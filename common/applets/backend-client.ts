/**
 * common/applets/backend-client — the applet host's transport proxy for the
 * `applets` backend.
 *
 * The backend itself is bound IN PROCESS by the dock
 * (`common/applets/host/in-process`) — the process that serves the namespace.
 * A host that does NOT own the backend builds its `AppletBackend` from this
 * factory instead of importing the 17 `common/applets/domains/*` modules: the
 * object it returns implements the same interface, so no applet call site
 * changes. The PRE-LOGIN greeter uses the SAME factory with the SOCKET
 * transport (`createSocketBackendTransport`, common/applets/backend-socket-client)
 * and `storeRead: "transport"`: it runs as another user, outside the session
 * bus and outside the owner's home, so its requests go over the shared-group
 * unix socket and its store reads come from the backend instead of a state
 * file it could never open.
 *
 * Transport: by DEFAULT `common/shell/tinshell-route.sh applets <…>`, the generic
 * router — it probes the map's instances, then every live instance, for one
 * that serves the `applets` namespace and runs the request there. The backend
 * has no instance of its own (the dock hosts it), so no instance name can be
 * assumed and no in-process D-Bus hop exists: each call spawns the CLI. A
 * member that fails while no backend answers is DEGRADED: the caller gets the
 * documented placeholder and the failure is logged through
 * `common/log/logger` (once per member, plus every up/down transition), never a
 * silent zero. While the backend is known down the client stops spawning
 * probes for `REPROBE_MS` so a dead backend cannot be hammered by every poller.
 *
 * Member handling (the same four kinds the backend's table exposes):
 *   - promise members    — transported per call, answered with the decoded value.
 *   - reactive members   — an `Accessor` fed by a client-side poll on the
 *     CALLER's interval (`batteryState(pollMs)`), so a poll-interval change
 *     re-arms the cadence without a process restart. Subscribers are the
 *     applet's, exactly as with the in-process createPoll.
 *   - sync members       — a synchronous value cannot cross a process boundary:
 *     the client answers the memoized result for the same argument tuple, keeps
 *     it refreshed in the background when the member is a polled state
 *     (`isInhibitActive`, `tabletInfo`), and answers the documented placeholder
 *     when no value has ever arrived.
 *   - callback members   — the backend owns the subscription; the client polls
 *     the matching snapshot on an interval (a change notification) or the
 *     member's own push payload (`mprisState`, `onTabletChange`, …).
 *
 * Store members (`battery.chargeThresholdStore`, …) read the store's DURABLE
 * file synchronously (`common/state`'s canonical path — the store writes
 * synchronously on every set, so the file IS the current value) and route
 * writes to the backend, so exactly one process owns the store's mirror.
 * `ready(key)` reports whether the store has ANSWERED for a key at all: a
 * transport-backed store answers `undefined` until its background fetch lands
 * (a memo miss is "unknown", never "unset"), and `set` reports an undeliverable
 * write instead of claiming success.
 */
import GLib from "gi://GLib"
import type * as Battery from "@common/applets/domains/battery"
import type { BluetoothActionResult } from "@common/applets/domains/bluetooth"
import type * as Network from "@common/applets/domains/network"
import type * as Workspaces from "@common/applets/domains/workspaces"
import { storeFilePath } from "@common/applets/store-paths"
import type { GpuColour } from "@common/applets/types"
import { log } from "@common/log/logger"
import type { StateStore } from "@common/state"
import { treeRoot } from "@common/path/tree-root"
import { run } from "@common/subprocess/run"
import { Accessor } from "gnim"
import type {
  AppletBackend,
  BluetoothDevice,
  BluetoothStatus,
  MprisState,
  WifiNetwork,
  WifiStatus,
} from "./backend"
import {
  APPLETS_NAMESPACE,
  type Envelope,
  memberRequestTokens,
  parseEnvelope,
  type TransportError,
} from "./backend-protocol"

/** Everything but the dock-owned capture domains: the capture driver
 *  (apps/dock/screengrab) is not part of the OS-call backend — it runs in the
 *  host that owns the compositor session, so the dock keeps binding it. */
type TransportedBackend = Omit<AppletBackend, "screengrab" | "screengrabNaming">

// ── Transport ──

/** The generic router: it probes the map's instances, then every live instance,
 *  for one serving the `applets` namespace. The namespace has no instance of its
 *  own — the dock hosts it — so the router is the only resolver. */
const ROUTE_SCRIPT = GLib.build_filenamev([treeRoot(), "common", "shell", "tinshell-route.sh"])
/** The router probes live instances (a spawn + probe round trip per call, and a
 *  slow OS call may take seconds: an nmcli scan, or the backend's first
 *  reactive answer while it waits for its own poll). */
const ROUTE_TIMEOUT_MS = 30_000
/** While no backend answers, stop probing for this long (bounded spawn rate). */
const REPROBE_MS = 10_000
/** Bounds for a caller-supplied poll interval (GLib's timeout interval is a
 *  uint32; a non-finite/<=0 value would arm a busy loop). */
const MIN_INTERVAL_MS = 200
const MAX_INTERVAL_MS = 3_600_000

const UNREACHABLE = "applets backend unreachable"

let down = false
let nextProbeAt = 0
/** Members already reported degraded (reset when the backend answers again). */
const reported = new Set<string>()

function nowMs(): number {
  return GLib.get_monotonic_time() / 1000
}

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) return MIN_INTERVAL_MS
  return ms > MAX_INTERVAL_MS ? MAX_INTERVAL_MS : ms
}

function noteAnswered(): void {
  if (!down) return
  down = false
  reported.clear()
  log("[applets-client] backend is answering again")
}

function noteUnreachable(member: string, detail: string): void {
  down = true
  nextProbeAt = nowMs() + REPROBE_MS
  if (reported.has(member)) return
  reported.add(member)
  log(`[applets-client] ${UNREACHABLE} (${member}): ${detail}`)
}

function noteDegraded(member: string, error: TransportError): void {
  // `no-sample` is a push member's warm-up (the backend has subscribed, the OS
  // stream has not reported yet) — the caller still sees it in the envelope,
  // but it is not a degradation to log.
  if (error.kind === "no-sample") return
  if (reported.has(member)) return
  reported.add(member)
  log(`[applets-client] degraded '${member}': ${error.kind}: ${error.message}`)
}

function unreachable(label: string): Envelope {
  return { ok: false, error: { kind: "call-failed", message: `${UNREACHABLE} (${label})` } }
}

/** A request transport: exactly what the member-kind helpers below need, and
 *  nothing else (`invoke` → the shared envelope). The default is the routed
 *  session transport; a host that cannot reach the session bus at all — the
 *  pre-login greeter, another user — installs the
 *  socket transport (common/applets/backend-socket-client) instead. */
export interface BackendTransport {
  invoke: (domain: string, member: string, args: unknown[]) => Promise<Envelope>
}

/** How a store member reads its durable value: "file" = the owner's state dir
 *  (a same-user host), "transport" = through the backend (a host that cannot
 *  read the owner's home at all). */
type StoreReadMode = "file" | "transport"

interface AppletBackendClientOptions {
  /** Default: the session transport (D-Bus + router). */
  transport?: BackendTransport
  /** Default: "file". */
  storeRead?: StoreReadMode
}

/** Module scope on purpose: ONE client per host process (see the header), so
 *  the effective transport and store-read mode are the process's. */
let transport: BackendTransport = { invoke: routedInvoke }
let storeRead: StoreReadMode = "file"

/** The transport every member kind below goes through. */
async function invoke(domain: string, member: string, args: unknown[]): Promise<Envelope> {
  return transport.invoke(domain, member, args)
}

/** One transport round trip over the session: the router, which runs the
 *  request in whatever live instance serves the `applets` namespace. */
async function routedInvoke(domain: string, member: string, args: unknown[]): Promise<Envelope> {
  const label = `${domain} ${member}`
  if (down && nowMs() < nextProbeAt) return unreachable(label)
  const tokens = memberRequestTokens(domain, member, args)
  let routed: Awaited<ReturnType<typeof run>>
  try {
    routed = await run([ROUTE_SCRIPT, APPLETS_NAMESPACE, ...tokens], {
      timeoutMs: ROUTE_TIMEOUT_MS,
    })
  } catch (e) {
    noteUnreachable(label, `router spawn failed: ${String(e)}`)
    return unreachable(label)
  }
  const routedEnv = routed.exit === 0 ? parseEnvelope(routed.stdout) : null
  if (routedEnv) {
    noteAnswered()
    if (!routedEnv.ok) noteDegraded(label, routedEnv.error)
    return routedEnv
  }
  // A refused request (`no live instance serves 'applets'`), a failed call and
  // a spawn timeout all land here: the reason is logged, not swallowed.
  noteUnreachable(label, `router exit ${routed.exit}: ${routed.stderr.trim().slice(0, 160)}`)
  return unreachable(label)
}

// ── Member kinds ──

/** A promise-returning member: transport the call, answer the value; the
 *  documented placeholder + a log line when no backend answers. */
function promiseMember<T>(
  domain: string,
  member: string,
  fallback: T,
): (...args: any[]) => Promise<T> {
  return async (...args: any[]): Promise<T> => {
    const r = await invoke(domain, member, args)
    if (r.ok) return r.value as T
    noteDegraded(`${domain} ${member}`, r.error)
    return fallback
  }
}

// ── Polled-state refresh after an action ──
// An ACTION changes state that this domain also POLLS, and a polled member only
// re-reads on its interval — so a caller that redraws from that state right
// after acting paints the pre-action value, and nothing repaints when the memo
// finally catches up. Polled members register a refresher here so the action
// path can force a fresh read before its promise resolves.
const polledRefreshers = new Map<string, Set<() => Promise<void>>>()

function registerPolledRefresh(domain: string, refresh: () => Promise<void>): void {
  let set = polledRefreshers.get(domain)
  if (!set) {
    set = new Set()
    polledRefreshers.set(domain, set)
  }
  set.add(refresh)
}

/** Re-read every polled member of `domain`; resolves when they have all landed. */
function refreshPolled(domain: string): Promise<void> {
  const refreshers = polledRefreshers.get(domain)
  if (!refreshers || refreshers.size === 0) return Promise.resolve()
  return Promise.all([...refreshers].map((r) => r())).then(() => undefined)
}

/** A fire-and-forget member (a void action). Coalesced per member — one
 *  request in flight, the newest argument set wins, so a brightness/volume
 *  drag cannot spawn a request per frame. The returned promise resolves once
 *  the request has landed AND this domain's polled members have been re-read,
 *  so it means "the change is visible to a caller redrawing from that state"
 *  rather than merely "sent". Callers that do not care simply ignore it. */
function actionMember(domain: string, member: string): (...args: any[]) => Promise<void> {
  let inflight = false
  let pending: unknown[] | null = null
  let waiters: Array<() => void> = []
  const release = (): void => {
    const w = waiters
    waiters = []
    for (const fn of w) fn()
  }
  const pump = (): void => {
    if (inflight || !pending) return
    const args = pending
    pending = null
    inflight = true
    void invoke(domain, member, args)
      .then((r) => {
        if (!r.ok) noteDegraded(`${domain} ${member}`, r.error)
        return refreshPolled(domain)
      })
      .finally(() => {
        inflight = false
        release()
        pump()
      })
  }
  return (...args: any[]): Promise<void> => {
    pending = args
    const settled = new Promise<void>((resolve) => waiters.push(resolve))
    pump()
    return settled
  }
}

interface SyncOptions {
  /** Re-transport the last argument tuple on this interval (a polled state). */
  refreshMs?: number
  /** Answer the placeholder on a cache miss instead of the member's previous
   *  value (used where a stale value would be wrong, e.g. a window lookup). */
  placeholderOnMiss?: boolean
}

/** A sync fetch may legitimately wait for a cold-starting backend (the router's
 *  bound), so its inflight key is released only past that. A fetch that never
 *  settles must not poison the member for the process lifetime: past this the
 *  key is released and the next call retries. */
const SYNC_INFLIGHT_DEADLINE_MS = ROUTE_TIMEOUT_MS + 5_000

/** A synchronous member: the memoized result for the same argument tuple,
 *  refreshed in the background; the documented placeholder when nothing has
 *  arrived yet. Build the member ONCE (see the colour members below) — a
 *  `syncMember(…)(args)` per call owns a fresh memo and inflight set, so it can
 *  never answer anything but the placeholder. */
function syncMember<T>(
  domain: string,
  member: string,
  placeholder: T,
  opts: SyncOptions = {},
): (...args: any[]) => T {
  const memo = new Map<string, T>()
  const inflight = new Set<string>()
  /** The armed inflight deadline per key (SYNC_INFLIGHT_DEADLINE_MS). */
  const deadlines = new Map<string, number>()
  /** Keys whose placeholder fallback has been reported — one line per key per
   *  fetch, never one per draw. */
  const placeholderLogged = new Set<string>()
  let last: T | undefined
  let lastArgs: unknown[] | null = null
  const label = `${domain} ${member}`
  const fetch = (args: unknown[]): Promise<void> => {
    const key = JSON.stringify(args)
    if (inflight.has(key)) return Promise.resolve()
    inflight.add(key)
    deadlines.set(
      key,
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_INFLIGHT_DEADLINE_MS, () => {
        // A fired source removed its own entry: `.finally` must not remove it twice.
        deadlines.delete(key)
        if (!inflight.has(key)) return GLib.SOURCE_REMOVE
        inflight.delete(key)
        log(
          `[applets-client] '${label}' fetch has not settled after ${SYNC_INFLIGHT_DEADLINE_MS}ms — released so the next call can retry`,
        )
        return GLib.SOURCE_REMOVE
      }),
    )
    return invoke(domain, member, args)
      .then((r) => {
        if (r.ok) {
          const value = r.value as T
          memo.set(key, value)
          last = value
          placeholderLogged.delete(key)
        } else {
          noteDegraded(label, r.error)
        }
      })
      .finally(() => {
        inflight.delete(key)
        const id = deadlines.get(key)
        if (id !== undefined) {
          deadlines.delete(key)
          GLib.source_remove(id)
        }
      })
  }
  if (opts.refreshMs) {
    const refreshMs = clampInterval(opts.refreshMs)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, refreshMs, () => {
      if (lastArgs) fetch(lastArgs)
      return GLib.SOURCE_CONTINUE
    })
    // An action in this domain changes what this member polls; let the action
    // path force a fresh read so it can resolve once the change is visible.
    registerPolledRefresh(domain, () => (lastArgs ? fetch(lastArgs) : Promise.resolve()))
  }
  return (...args: any[]): T => {
    lastArgs = args
    const key = JSON.stringify(args)
    if (memo.has(key)) return memo.get(key) as T
    fetch(args)
    if (inflight.has(key) && !placeholderLogged.has(key)) {
      // A caller answering the placeholder because its fetch is still
      // outstanding — logged once per argument tuple, so a frozen member is
      // never silent.
      placeholderLogged.add(key)
      log(
        `[applets-client] '${label}' answered the placeholder while its fetch is outstanding (${key.length > 80 ? `${key.slice(0, 77)}…` : key})`,
      )
    }
    if (opts.placeholderOnMiss) return placeholder
    return (last ?? placeholder) as T
  }
}

interface ReactiveSpec {
  /** The poll interval the CALLER asked for (ms). */
  intervalMs: number
  /** The argument tuple the backend's member is called with. */
  args: unknown[]
  /** The EVENT path, optional: called once with a `refresh` that re-reads the
   *  member immediately, and expected to return its unsubscribe. Use it when
   *  the value has a source of truth that changes faster than `intervalMs`
   *  (a change signal) — the poll stays the safety net instead of the primary
   *  path, so a change reaches the applet in the signal's cadence and not up
   *  to one full poll interval later. */
  refreshOn?: (refresh: () => void) => () => void
}

/** A reactive member: ONE Accessor + ONE poll timer PER MEMBER (the same
 *  module-scope singleton the in-process domains have) fed by a client-side
 *  poll on the caller's interval. A later call with a different interval
 *  re-arms the timer, so a `timing.poll` change takes effect without a process
 *  restart; the value the applet sees behaves like the in-process createPoll
 *  (peek + subscribe). */
const REACTIVE: Map<
  string,
  { arm: (ms: number, args: unknown[]) => void; refresh: () => void; accessor: Accessor<any> }
> = new Map()

function reactiveMember<T>(
  domain: string,
  member: string,
  placeholder: T,
  spec: (...args: any[]) => ReactiveSpec,
): (...args: any[]) => Accessor<T> {
  const key = `${domain} ${member}`
  let slot = REACTIVE.get(key)
  if (!slot) {
    const listeners = new Set<() => void>()
    let value: T = placeholder
    let timer: number | null = null
    let interval = -1
    let pollArgs: unknown[] = []
    let polling = false

    const tick = async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        const r = await invoke(domain, member, pollArgs)
        if (!r.ok) {
          noteDegraded(`${domain} ${member}`, r.error)
          return
        }
        value = r.value as T
        for (const cb of listeners) cb()
      } finally {
        polling = false
      }
    }

    const arm = (ms: number, args: unknown[]): void => {
      if (timer !== null && ms === interval) return
      interval = ms
      pollArgs = args
      if (timer !== null) {
        GLib.source_remove(timer)
        timer = null
      }
      void tick()
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        void tick()
        return GLib.SOURCE_CONTINUE
      })
    }

    slot = {
      arm,
      refresh: () => void tick(),
      accessor: new Accessor<T>(
        () => value,
        (cb: () => void) => {
          listeners.add(cb)
          return () => {
            listeners.delete(cb)
          }
        },
      ),
    }
    REACTIVE.set(key, slot)
  }
  const bound = slot
  /** The event path is installed ONCE per member (the slot is the process's
   *  singleton, like the domains' own state). */
  let refreshStop: (() => void) | null = null
  return (...args: any[]): Accessor<T> => {
    const s = spec(...args)
    bound.arm(clampInterval(s.intervalMs), s.args)
    if (s.refreshOn && refreshStop === null) refreshStop = s.refreshOn(bound.refresh)
    return bound.accessor as Accessor<T>
  }
}

/** The raw value of a push member's collected payload (`{event: [...]}`). */
function eventOf(value: unknown): unknown[] {
  const event = (value as { event?: unknown } | null)?.event
  return Array.isArray(event) ? event : []
}

interface PollSpec {
  /** `domain member` for logs. */
  label: string
  ms: number
  probe: () => Promise<Envelope>
  onValue: (value: unknown) => void
}

/** Poll a backend member and hand its value to `onValue`; returns the
 *  unsubscribe. The first poll runs immediately, so a subscriber sees the
 *  current state without waiting one interval. */
function startPoll(spec: PollSpec): () => void {
  let stopped = false
  const tick = async (): Promise<void> => {
    const r = await spec.probe()
    if (stopped) return
    if (!r.ok) {
      noteDegraded(spec.label, r.error)
      return
    }
    spec.onValue(r.value)
  }
  void tick()
  const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, clampInterval(spec.ms), () => {
    void tick()
    return GLib.SOURCE_CONTINUE
  })
  return () => {
    stopped = true
    GLib.source_remove(id)
  }
}

/** Fire `cb(value)` when the polled value changes (JSON-compared). */
function changeSignal<T>(
  label: string,
  ms: number,
  probe: () => Promise<Envelope>,
  pick: (value: unknown) => T | undefined,
  cb: (value: T) => void,
): () => void {
  let seen = false
  let last = ""
  return startPoll({
    label,
    ms,
    probe,
    onValue: (value) => {
      const picked = pick(value)
      if (picked === undefined) return
      const key = JSON.stringify(picked)
      if (seen && key === last) return
      seen = true
      last = key
      cb(picked)
    },
  })
}

// ── Store members ──

/** Route a store write to the backend — the single owner of the store's
 *  mirror — and answer whether it was ACCEPTED. A backend already known
 *  unreachable cannot deliver it: report the drop to the caller (the value it
 *  would read back is still the old one) instead of claiming a set that never
 *  happened. A delivery that fails later is logged where it is observed. */
function setStoreMember(domain: string, store: string, key: string, value: unknown): boolean {
  const label = `${domain} ${store}`
  if (down) {
    noteDegraded(`${label}.set`, { kind: "call-failed", message: UNREACHABLE })
    return false
  }
  void invoke(domain, `${store}.set`, [key, value]).then((r) => {
    if (!r.ok) noteDegraded(`${label}.set`, r.error)
  })
  return true
}

/** A store member: `get` reads the store's durable file synchronously (the
 *  store writes it synchronously on every set, so the file is the live value),
 *  `set` routes the write to the backend — the single owner of the store — and
 *  reports its outcome through the log. A failed write leaves the file
 *  unchanged, so the next `get` reads the pre-write value back. */
function storeMember<K extends string>(domain: string, store: string): StateStore<K> {
  if (storeRead === "transport") return transportStoreMember<K>(domain, store)
  const label = `${domain} ${store}`
  const read = (): Record<string, unknown> | null => {
    const path = storeFilePath(domain, store)
    // A store that has never been written has no file — that is an empty store,
    // not a failure.
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null
    try {
      const [ok, contents] = GLib.file_get_contents(path)
      if (!ok || !contents) return null
      const parsed: unknown = JSON.parse(new TextDecoder().decode(contents))
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
    } catch (e) {
      noteDegraded(label, { kind: "call-failed", message: `state file read: ${String(e)}` })
      return null
    }
  }
  return {
    path: () => storeFilePath(domain, store),
    get: (key: K) => read()?.[key],
    // The durable file is read synchronously here, so every key is answered
    // (value or confirmed absence) on the first ask.
    ready: () => true,
    set: (key: K, value: unknown): boolean => setStoreMember(domain, store, key, value),
    reload: () => {
      // `get` re-reads the file, so there is no mirror to refresh.
    },
    dump: () => JSON.stringify(read() ?? {}),
  }
}

/** How often a transport-read store re-reads the keys it has been asked for.
 *  Short, because a `get` that lands before the transport is up answers
 *  `undefined` and must converge quickly — the payloads are a handful of tiny
 *  scalars. */
const STORE_REFRESH_MS = 2000

/** A store member for a host that CANNOT read the owner's state dir (a
 *  different user): the value comes over the transport, key by key — a sync
 *  `get` answers the memoized value and kicks a background read on a miss, and
 *  a write is routed to the backend, the single owner of the store. This is the
 *  same division the file mode makes (one writer, file is the live value), just
 *  with the read side moved behind the backend. `ready` is the read side's
 *  contract: false until the backend has answered for a key, because the
 *  memoized `undefined` of a miss is not an answer. */
function transportStoreMember<K extends string>(domain: string, store: string): StateStore<K> {
  const label = `${domain} ${store}`
  const known = new Map<string, unknown>()
  /** Every key ever asked for: the refresh re-reads THESE, not only the ones a
   *  read already answered — a `get` that raced the first connect must recover
   *  on its own instead of staying empty for the process lifetime. */
  const wanted = new Set<string>()
  const inflight = new Set<string>()
  let timer: number | null = null

  const fetch = (key: string): void => {
    wanted.add(key)
    if (inflight.has(key)) return
    inflight.add(key)
    void invoke(domain, `${store}.get`, [key])
      .then((r) => {
        if (!r.ok) {
          noteDegraded(`${label}.get`, r.error)
          return
        }
        known.set(key, r.value)
      })
      .finally(() => {
        inflight.delete(key)
      })
  }

  const armRefresh = (): void => {
    if (timer !== null) return
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STORE_REFRESH_MS, () => {
      for (const key of wanted) fetch(key)
      return GLib.SOURCE_CONTINUE
    })
  }

  return {
    // The owner's canonical path — informational for a host that cannot read
    // it; the value itself always comes from the backend.
    path: () => storeFilePath(domain, store),
    get: (key: K) => {
      const k = key as string
      if (!known.has(k)) {
        fetch(k)
        armRefresh()
      }
      return known.get(k) as never
    },
    // Answered only once the backend has replied for this key: a caller must
    // not read the memo miss above as "the store holds no value".
    ready: (key: K) => known.has(key as string),
    set: (key: K, value: unknown): boolean => setStoreMember(domain, store, key, value),
    reload: () => {
      // Nothing cached beyond the keys already served; the refresh re-reads
      // them through the backend.
    },
    dump: () => JSON.stringify(Object.fromEntries(known)),
  }
}

// ── Client construction ──

/** Poll intervals for the members the applet caller does not parametrize. */
const NET_POLL_MS = 1500
const MPRIS_POLL_MS = 1000
const TABLET_POLL_MS = 1000
const WORKSPACE_POLL_MS = 1000
const SUBSCRIPTION_POLL_MS = 2000
const POWERS_HINT = "power-supply-events onPowerSupplyEvent"

const WIFI_FALLBACK: WifiStatus = {
  enabled: false,
  connected: false,
  signal: 0,
  connectivity: "none",
}
const BLUETOOTH_FALLBACK: BluetoothStatus = { enabled: false, connected: false }
const BATTERY_FALLBACK: Battery.BatteryState = {
  percentage: 100,
  wattage: null,
  status: "Unknown",
}
const NET_FALLBACK: Network.NetState = { down: 0, up: 0, downRing: 0, upRing: 0 }

/** One-shot note (the dock row rebuilds remount applets and would repeat it). */
let netStateNoteLogged = false

function failedResult(what: string): { ok: boolean; error?: string } {
  return { ok: false, error: `${UNREACHABLE}: ${what}` }
}

/** Build the transport proxy. Module scope: one client per host process (the
 *  reactive Accessors, the poll timers and the down-probe window are shared —
 *  exactly like the in-process modules' module-scope state). */

/** The colour members the applets call from their DRAW path. Bound ONCE: a
 *  fresh `syncMember` per call owns a fresh memo and inflight set, so it would
 *  answer its placeholder forever (the white-glyph bug) and fire a request per
 *  draw. `refreshMs` keeps the memo converged while the applet is not calling —
 *  the states behind the colours (dGPU status, platform profile) are polled
 *  every 1–3 s, so a 5 s refresh is well inside their own cadence. */
const COLOUR_REFRESH_MS = 5_000
const batteryColourMember = syncMember<string>("battery", "batteryColour", "green", {
  refreshMs: COLOUR_REFRESH_MS,
})
const gpuColourMember = syncMember<GpuColour>("system", "gpuColour", "none", {
  refreshMs: COLOUR_REFRESH_MS,
})
const tlpProfileColourMember = syncMember<string>("tlp", "tlpProfileColour", "none", {
  refreshMs: COLOUR_REFRESH_MS,
})

/** The fs domain for a host whose transport CANNOT serve it. The socket policy
 *  never exposes `fs` (common/applets/host/socket-server.ts — it reads and writes
 *  files as the owner, which must not cross a user boundary), so the members
 *  answer their documented placeholders locally instead of firing a request
 *  that is refused every time. `available` is what an applet checks before it
 *  mutates sysfs: a host without it is mounted READ-ONLY, rather than finding
 *  out through a write that silently did nothing. */
function deniedFsDomain(): TransportedBackend["fs"] {
  return {
    available: false,
    readFile: () => "",
    listDir: () => [],
    readFileAsync: async () => "",
    writeFileAsync: async () => false,
    readUserFileAsync: async () => ({ ok: false, contents: "" }),
    writeUserFileAsync: async () => false,
  }
}

export function createAppletBackendClient(
  opts: AppletBackendClientOptions = {},
): TransportedBackend {
  transport = opts.transport ?? { invoke: routedInvoke }
  storeRead = opts.storeRead ?? "file"
  log(
    opts.transport
      ? "[applets-client] applets are served by the 'applets' socket (unix transport)"
      : "[applets-client] applets are served by the 'applets' instance (request proxy)",
  )
  const backend: TransportedBackend = {
    battery: {
      batteryState: (pollIntervalMs?: number) =>
        reactiveMember<Battery.BatteryState>("battery", "batteryState", BATTERY_FALLBACK, () => ({
          intervalMs: pollIntervalMs ?? 2000,
          args: [pollIntervalMs ?? 2000],
        }))(),
      batteryColour: batteryColourMember,
      chargeThresholdStore: storeMember<"chargeThreshold">("battery", "chargeThresholdStore"),
      pluggedSinceStore: storeMember<"pluggedSince">("battery", "pluggedSinceStore"),
    },
    bluetooth: {
      bluetoothEnabledStore: storeMember<"bluetoothEnabled">("bluetooth", "bluetoothEnabledStore"),
      isBluetoothEnabled: promiseMember<boolean>("bluetooth", "isBluetoothEnabled", false),
      setBluetoothEnabled: promiseMember<void>("bluetooth", "setBluetoothEnabled", undefined),
      bluetoothStatus: (): Promise<BluetoothStatus> =>
        promiseMember<BluetoothStatus>("bluetooth", "bluetoothStatus", BLUETOOTH_FALLBACK)(),
      subscribeBluetoothStatus: (onChange: () => void) =>
        changeSignal(
          "bluetooth bluetoothStatus",
          SUBSCRIPTION_POLL_MS,
          () => invoke("bluetooth", "bluetoothStatus", []),
          (v) => v as BluetoothStatus,
          () => onChange(),
        ),
      adapterExists: promiseMember<boolean>("bluetooth", "adapterExists", false),
      listBluetoothDevices: (): Promise<BluetoothDevice[]> =>
        promiseMember<BluetoothDevice[]>("bluetooth", "listBluetoothDevices", [])(),
      adapterDiscovering: promiseMember<boolean>("bluetooth", "adapterDiscovering", false),
      startDiscovery: (): Promise<BluetoothActionResult> =>
        promiseMember<BluetoothActionResult>(
          "bluetooth",
          "startDiscovery",
          failedResult("discover"),
        )(),
      stopDiscovery: (): Promise<BluetoothActionResult> =>
        promiseMember<BluetoothActionResult>(
          "bluetooth",
          "stopDiscovery",
          failedResult("discover"),
        )(),
      connectDevice: (path: string): Promise<BluetoothActionResult> =>
        promiseMember<BluetoothActionResult>(
          "bluetooth",
          "connectDevice",
          failedResult("connect"),
        )(path),
      disconnectDevice: (path: string): Promise<BluetoothActionResult> =>
        promiseMember<BluetoothActionResult>(
          "bluetooth",
          "disconnectDevice",
          failedResult("disconnect"),
        )(path),
      removeDevice: (path: string): Promise<BluetoothActionResult> =>
        promiseMember<BluetoothActionResult>(
          "bluetooth",
          "removeDevice",
          failedResult("remove"),
        )(path),
      pairDevice: (path: string): Promise<BluetoothActionResult> =>
        promiseMember<BluetoothActionResult>("bluetooth", "pairDevice", failedResult("pair"))(path),
      registerAgent: actionMember("bluetooth", "registerAgent"),
      unregisterAgent: actionMember("bluetooth", "unregisterAgent"),
    },
    brightness: {
      brightnessState: (pollIntervalMs: number) =>
        reactiveMember<{ screen: number }>(
          "brightness",
          "brightnessState",
          { screen: 100 },
          () => ({ intervalMs: pollIntervalMs, args: [pollIntervalMs] }),
        )(pollIntervalMs),
      setScreenBrightness: actionMember("brightness", "setScreenBrightness"),
    },
    cpu: {
      cpuUtilization: (intervalMs = 3000) =>
        reactiveMember<number>("cpu", "cpuUtilization", 0, () => ({
          intervalMs,
          args: [intervalMs],
        }))(intervalMs),
      cpuTemperature: (intervalMs = 3000) =>
        reactiveMember<number | null>("cpu", "cpuTemperature", null, () => ({
          intervalMs,
          args: [intervalMs],
        }))(intervalMs),
      ramUtilization: (intervalMs = 5000) =>
        reactiveMember<number>("cpu", "ramUtilization", 0, () => ({
          intervalMs,
          args: [intervalMs],
        }))(intervalMs),
    },
    fs: opts.transport
      ? deniedFsDomain()
      : {
          available: true,
          readFile: syncMember<string>("fs", "readFile", ""),
          listDir: syncMember<string[]>("fs", "listDir", []),
          readFileAsync: promiseMember<string>("fs", "readFileAsync", ""),
          writeFileAsync: promiseMember<boolean>("fs", "writeFileAsync", false),
          readUserFileAsync: (path: string): Promise<{ ok: boolean; contents: string }> =>
            promiseMember<{ ok: boolean; contents: string }>("fs", "readUserFileAsync", {
              ok: false,
              contents: "",
            })(path),
          writeUserFileAsync: promiseMember<boolean>("fs", "writeUserFileAsync", false),
        },
    mediaWindow: {
      findMediaWindow: (
        clientsJson: string,
        player: string,
        title: string,
        artist: string,
      ): { ws: number; addr: string } | null =>
        syncMember<{ ws: number; addr: string } | null>("media-window", "findMediaWindow", null, {
          placeholderOnMiss: true,
        })(clientsJson, player, title, artist),
    },
    mpris: {
      // Transport actions: fire-and-forget mutators over the request surface
      // (owner-only across the socket — see the applets socket policy).
      playPause: actionMember("mpris", "playPause"),
      next: actionMember("mpris", "next"),
      previous: actionMember("mpris", "previous"),
      mprisState: (onChange: (s: MprisState) => void) => {
        const stop = startPoll({
          label: "mpris mprisState",
          ms: MPRIS_POLL_MS,
          probe: () => invoke("mpris", "mprisState", []),
          onValue: (value) => {
            const state = eventOf(value)[0] as MprisState | undefined
            if (state) onChange(state)
          },
        })
        return {
          stop,
          // The applet's safety-net tick: one extra read now, no extra timer.
          safetyRefresh: (): void => {
            void invoke("mpris", "mprisState", []).then((r) => {
              if (!r.ok) {
                noteDegraded("mpris mprisState", r.error)
                return
              }
              const state = eventOf(r.value)[0] as MprisState | undefined
              if (state) onChange(state)
            })
          },
        }
      },
    },
    network: {
      netState: (scale: Network.NetScale) => {
        // `shouldPoll` is the caller's own visibility gate — a function, so it
        // cannot cross the request boundary; the backend's counter poll runs
        // continuously instead of being cheapened while the icon is hidden.
        if (!netStateNoteLogged) {
          netStateNoteLogged = true
          log("[applets-client] network netState: shouldPoll is not transported (backend polls)")
        }
        return reactiveMember<Network.NetState>("network", "netState", NET_FALLBACK, () => ({
          intervalMs: NET_POLL_MS,
          args: [scale],
        }))(scale)
      },
    },
    power: {
      executePowerAction: actionMember("power", "executePowerAction"),
      // Polled state, not a per-call value: a lock-icon staleness of one
      // interval is invisible (the applet re-reads on every draw).
      isInhibitActive: syncMember<boolean>("power", "isInhibitActive", false, { refreshMs: 2000 }),
      restoreInhibitState: promiseMember<void>("power", "restoreInhibitState", undefined),
    },
    powerProfile: {
      autoProfileStore: storeMember<"autoProfile">("power-profile", "autoProfileStore"),
      readProfile: (): Promise<"performance" | "balanced" | "power-saver" | "unknown"> =>
        promiseMember<"performance" | "balanced" | "power-saver" | "unknown">(
          "power-profile",
          "readProfile",
          "balanced",
        )(),
      writeProfile: actionMember("power-profile", "writeProfile"),
      onProfileChanged: (fn: () => void) =>
        changeSignal(
          "power-profile readProfile",
          SUBSCRIPTION_POLL_MS,
          () => invoke("power-profile", "readProfile", []),
          (v) => v as string,
          () => fn(),
        ),
    },
    powerSupplyEvents: {
      onPowerSupplyEvent: (fn: (action: string, deviceName: string) => void) =>
        changeSignal(
          POWERS_HINT,
          SUBSCRIPTION_POLL_MS,
          () => invoke("power-supply-events", "onPowerSupplyEvent", []),
          (v) => eventOf(v) as [string, string],
          ([action, deviceName]) => fn(action ?? "", deviceName ?? ""),
        ),
    },
    system: {
      gpuColour: gpuColourMember,
      systemTick: (intervalMs = 1000) =>
        reactiveMember<{ gpuStatus: string | null }>(
          "system",
          "systemTick",
          { gpuStatus: null },
          () => ({ intervalMs, args: [intervalMs] }),
        )(intervalMs),
      // Pulled per call (the applet's own timer sets the cadence); null = no
      // reading, so a host without a live backend paints no readout.
      systemUptime: promiseMember<number | null>("system", "systemUptime", null),
    },
    tablet: {
      onTabletChange: (cb: (tablet: boolean) => void) =>
        changeSignal(
          "tablet onTabletChange",
          TABLET_POLL_MS,
          () => invoke("tablet", "onTabletChange", []),
          (v) => {
            const tablet = eventOf(v)[0]
            return typeof tablet === "boolean" ? tablet : undefined
          },
          (tablet) => cb(tablet),
        ),
      startTabletWatchdog: actionMember("tablet", "startTabletWatchdog"),
      setTabletOverride: actionMember("tablet", "setTabletOverride"),
      tabletInfo: syncMember<string>(
        "tablet",
        "tabletInfo",
        "tablet: applets backend unreachable",
        { refreshMs: 15_000 },
      ),
    },
    tlp: {
      tlpProfile: (intervalMs = 30000) =>
        reactiveMember<"performance" | "balanced" | "power-saver" | "unknown">(
          "tlp",
          "tlpProfile",
          "balanced",
          () => ({
            intervalMs,
            args: [intervalMs],
            // The backend's tlpProfile follows the daemon's PropertiesChanged
            // signal, so the interval above is only its safety net: without an
            // event path the applet's colour waited up to `intervalMs` (30s)
            // for the next poll after a profile switch. Re-read the member when
            // the profile actually changes (the same change signal the
            // power-profile domain already polls).
            refreshOn: (refresh) =>
              changeSignal(
                "tlp tlpProfile refresh",
                SUBSCRIPTION_POLL_MS,
                () => invoke("power-profile", "readProfile", []),
                (v) => v as string,
                refresh,
              ),
          }),
        )(intervalMs),
      tlpProfileColour: tlpProfileColourMember,
    },
    wifi: {
      wifiStatus: (): Promise<WifiStatus> =>
        promiseMember<WifiStatus>("wifi", "wifiStatus", WIFI_FALLBACK)(),
      activeWifiSsid: (): Promise<string | null> =>
        promiseMember<string | null>("wifi", "activeWifiSsid", null)(),
      subscribeWifiStatus: (onChange: () => void) =>
        changeSignal(
          "wifi wifiStatus",
          SUBSCRIPTION_POLL_MS,
          () => invoke("wifi", "wifiStatus", []),
          (v) => v as WifiStatus,
          () => onChange(),
        ),
      setWifiEnabled: promiseMember<void>("wifi", "setWifiEnabled", undefined),
      scanWifiNetworks: (): Promise<WifiNetwork[]> =>
        promiseMember<WifiNetwork[]>("wifi", "scanWifiNetworks", [])(),
      connectWifi: (ssid: string, password?: string): Promise<{ ok: boolean; error?: string }> =>
        promiseMember<{ ok: boolean; error?: string }>("wifi", "connectWifi", {
          ok: false,
          error: `${UNREACHABLE}: connect ${ssid}`,
        })(ssid, password),
      rescanWifi: promiseMember<void>("wifi", "rescanWifi", undefined),
      savedSsidList: (): Promise<string[]> =>
        promiseMember<string[]>("wifi", "savedSsidList", [])(),
      forgetWifiNetwork: (ssid: string): Promise<{ ok: boolean; error?: string }> =>
        promiseMember<{ ok: boolean; error?: string }>("wifi", "forgetWifiNetwork", {
          ok: false,
          error: `${UNREACHABLE}: forget ${ssid}`,
        })(ssid),
      disconnectWifi: (): Promise<{ ok: boolean; error?: string }> =>
        promiseMember<{ ok: boolean; error?: string }>("wifi", "disconnectWifi", {
          ok: false,
          error: `${UNREACHABLE}: disconnect`,
        })(),
    },
    workspaces: {
      fetchWorkspaceState: (onState: (s: Workspaces.WorkspaceState) => void): void => {
        void invoke("workspaces", "fetchWorkspaceState", []).then((r) => {
          if (!r.ok) {
            noteDegraded("workspaces fetchWorkspaceState", r.error)
            onState({ active: 0 })
            return
          }
          const state = eventOf(r.value)[0] as Workspaces.WorkspaceState | undefined
          onState(state ?? { active: 0 })
        })
      },
      jumpToWorkspace: actionMember("workspaces", "jumpToWorkspace"),
      onWorkspaceEvents: (fn: () => void) =>
        changeSignal(
          "workspaces fetchWorkspaceState",
          WORKSPACE_POLL_MS,
          () => invoke("workspaces", "fetchWorkspaceState", []),
          (v) => eventOf(v)[0] as Workspaces.WorkspaceState,
          () => fn(),
        ),
    },
  }
  // Warm the cached sync members a request handler can read before the first
  // poll lands (`dock tablet get`, and the LockSession applet's mount state) —
  // their first read would otherwise answer the placeholder.
  backend.power.isInhibitActive()
  backend.tablet.tabletInfo()
  return backend
}
