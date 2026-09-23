/**
 * common/applets/host/transport — the applets backend's request table.
 *
 * The table is DERIVED from the domain modules themselves: every exported
 * function of `common/applets/domains/*` becomes a request path `<domain> <fn>`
 * (plus `<domain> <store>.<accessor>` for an exported object's functions), so
 * a new function in a domain module is reachable without editing a second
 * list. The domain key is the module file name (battery, bluetooth,
 * power-profile, …) — one spelling per concept, matching the module layout.
 *
 * Invocation is derived from the RETURNED value, not from per-member wiring:
 *   - a Promise is awaited and its resolution is the reply value;
 *   - a reactive (peek/subscribe) is kept ticking and its current value is the
 *     reply — the createPoll-based domains only poll while subscribed;
 *   - anything else (a string, a boolean, an object) is the reply value.
 *
 * Callback members (`PUSH_MEMBERS`) return nothing useful over a
 * request/response surface: the payload is handed to a callback. The backend
 * invokes them with a collector — a STREAM member (returns an unsubscribe fn
 * or a controller object) is subscribed once and thereafter answers the latest
 * collected payload; a ONE-SHOT member (returns nothing, e.g.
 * `fetchWorkspaceState`) is re-invoked per request and the reply waits for the
 * callback to land. The set is explicit because a function's parameter types
 * are erased at runtime: a new callback member that is not listed here fails
 * loudly (`call-failed`) instead of silently dropping its payload.
 *
 * Every failure is answered by the structured error envelope — no bare null,
 * no silent drop.
 */
import GLib from "gi://GLib"
import { decodeArg, replyError, replyOk } from "@common/applets/backend-protocol"
import * as battery from "@common/applets/domains/battery"
import * as bluetooth from "@common/applets/domains/bluetooth"
import * as brightness from "@common/applets/domains/brightness"
import * as cpu from "@common/applets/domains/cpu"
import * as fs from "@common/applets/domains/fs"
import * as mediaWindow from "@common/applets/domains/media-window"
import * as mpris from "@common/applets/domains/mpris"
import * as network from "@common/applets/domains/network"
import * as power from "@common/applets/domains/power"
import * as powerProfile from "@common/applets/domains/power-profile"
import * as powerSupplyEvents from "@common/applets/domains/power-supply-events"
import * as system from "@common/applets/domains/system"
import * as tablet from "@common/applets/domains/tablet"
import * as tlp from "@common/applets/domains/tlp"
import * as volume from "@common/applets/domains/volume"
import * as wifi from "@common/applets/domains/wifi"
import * as workspaces from "@common/applets/domains/workspaces"

/** Domain token → module namespace. The token is the module's file name. */
export const APPLETS_DOMAINS: Record<string, Record<string, unknown>> = {
  battery,
  bluetooth,
  brightness,
  cpu,
  fs,
  "media-window": mediaWindow,
  mpris,
  network,
  power,
  "power-profile": powerProfile,
  "power-supply-events": powerSupplyEvents,
  system,
  tablet,
  tlp,
  volume,
  wifi,
  workspaces,
}

/** Members whose payload arrives through a callback argument (see the header). */
const PUSH_MEMBERS = new Set([
  "mpris mprisState",
  "power-profile onProfileChanged",
  "power-supply-events onPowerSupplyEvent",
  "tablet onTabletChange",
  "wifi subscribeWifiStatus",
  "bluetooth subscribeBluetoothStatus",
  "workspaces fetchWorkspaceState",
  "workspaces onWorkspaceEvents",
])

/** How long a one-shot push member may take to hand over its payload. */
const ONE_SHOT_TIMEOUT_MS = 4000

/** How long the first request for a reactive member waits for the domain's own
 *  poll to land, so the reply is a real reading rather than the reactive's
 *  seed value. The createPoll-based domains only tick while subscribed. */
const FIRST_SAMPLE_MS = 1500

// ── The derived member index ──

interface Member {
  /** `<domain> <member>` — one spelling for logs and error messages. */
  path: string
  fn: (...args: unknown[]) => unknown
  push: boolean
  /** A STREAM push member is subscribed once and kept alive by the ref. */
  started: boolean
  keepAlive: unknown
  /** Latest callback payload + whether one ever landed (push members). */
  seen: boolean
  lastEvent: unknown[]
}

/** domain → member token → member. Built once at import from the modules. */
const TABLE: Map<string, Map<string, Member>> = buildTable()

function buildTable(): Map<string, Map<string, Member>> {
  const table = new Map<string, Map<string, Member>>()
  for (const [domain, mod] of Object.entries(APPLETS_DOMAINS)) {
    const members = new Map<string, Member>()
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === "function") {
        members.set(name, member(`${domain} ${name}`, value as (...args: unknown[]) => unknown))
      } else if (value !== null && typeof value === "object") {
        // An exported object (the state stores) exposes its own functions as
        // `<object>.<fn>` paths.
        for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
          if (typeof subValue !== "function") continue
          members.set(
            `${name}.${sub}`,
            member(
              `${domain} ${name}.${sub}`,
              (subValue as (...args: unknown[]) => unknown).bind(value),
            ),
          )
        }
      }
    }
    table.set(domain, members)
  }
  return table
}

function member(path: string, fn: (...args: unknown[]) => unknown): Member {
  return {
    path,
    fn,
    push: PUSH_MEMBERS.has(path),
    started: false,
    keepAlive: null,
    seen: false,
    lastEvent: [],
  }
}

/** The member names of a domain, for discovery + error messages. */
export function domainMembers(domain: string): string[] {
  return [...(TABLE.get(domain)?.keys() ?? [])].sort()
}

function domainNames(): string[] {
  return [...TABLE.keys()].sort()
}

// ── Member resolution ──

/** Resolve a request token to a member name. An exact name wins; otherwise a
 *  token that is ONE whole camelCase word of a single member resolves to it
 *  (`battery state` → `batteryState`, `wifi scan` → `scanWifiNetworks`). An
 *  ambiguous token answers null so the caller lists the candidates.
 *
 *  Exported for the socket surface: its traffic policy must classify a request
 *  by the RESOLVED member (a shorthand token must not slip past a policy that
 *  names the long form) — the resolution itself stays in exactly this place. */
export function resolveMember(
  domain: string,
  token: string,
): { name: string; ambiguous: string[] } {
  const members = TABLE.get(domain)
  if (!members) return { name: "", ambiguous: [] }
  if (members.has(token)) return { name: token, ambiguous: [] }
  const lower = token.toLowerCase()
  const exactCi = [...members.keys()].filter((n) => n.toLowerCase() === lower)
  if (exactCi.length === 1) return { name: exactCi[0], ambiguous: [] }
  // `<domain word><token>` — `battery state` → `batteryState`,
  // `bluetooth status` → `bluetoothStatus`.
  const domainWord = domain.replace(/-/g, "").toLowerCase()
  const prefixed = [...members.keys()].filter((n) => n.toLowerCase() === domainWord + lower)
  if (prefixed.length === 1) return { name: prefixed[0], ambiguous: [] }
  // A token that is ONE whole camelCase word of a single member —
  // `wifi scan` → `scanWifiNetworks`.
  const matches = [...members.keys()].filter((n) => camelWords(n).includes(lower))
  if (matches.length === 1) return { name: matches[0], ambiguous: [] }
  const candidates = exactCi.length ? exactCi : prefixed.length ? prefixed : matches
  return { name: "", ambiguous: candidates }
}

function camelWords(name: string): string[] {
  return name
    .split(/(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter(Boolean)
}

// ── Invocation ──

function isReactive(
  value: unknown,
): value is { peek: () => unknown; subscribe: (cb: () => void) => () => void } {
  // Reactive values are usually plain objects, but the ags pollers return an
  // `Accessor` — a CALLABLE object (extends Function) — so both typeofs count.
  if (value === null) return false
  const t = typeof value
  if (t !== "object" && t !== "function") return false
  const v = value as Record<string, unknown>
  return typeof v.peek === "function" && typeof v.subscribe === "function"
}

/** Reject when `p` has not settled within `ms` (the dangling timer is removed
 *  on settle). A timed-out push member stays pending in the domain module —
 *  the surface answers no-sample rather than hanging the request. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let id: number | null = null
    // One-shot: it destroys its own source on fire, so the callback clears the
    // id — removing a fired source logs GLib-CRITICAL (Source ID … not found).
    id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      id = null
      reject(new NoSample(message))
      return GLib.SOURCE_REMOVE
    })
    p.then(
      (v) => {
        if (id !== null) GLib.source_remove(id)
        resolve(v)
      },
      (e) => {
        if (id !== null) GLib.source_remove(id)
        reject(e)
      },
    )
  })
}

async function invokePush(m: Member): Promise<unknown> {
  if (m.started) {
    if (!m.seen) throw new NoSample(`${m.path} is subscribed but has not reported a payload yet`)
    return { event: m.lastEvent }
  }
  let settled = false
  let collected: unknown[] = []
  let resolveFirst: ((a: unknown[]) => void) | null = null
  const first = new Promise<unknown[]>((resolve) => {
    resolveFirst = resolve
  })
  const collector = (...a: unknown[]): void => {
    collected = a
    m.lastEvent = a
    m.seen = true
    if (!settled) {
      settled = true
      resolveFirst?.(a)
    }
  }
  const result = m.fn(collector)
  // STREAM vs ONE-SHOT is derived from the returned value: a callback
  // subscription hands back an unsubscribe fn / controller object and is kept
  // alive (its collector keeps filling the cache); a one-shot returns nothing
  // and is re-invoked per request.
  if (typeof result === "function" || (result !== null && typeof result === "object")) {
    m.started = true
    m.keepAlive = result
  }
  if (!settled) {
    // Wait for the payload the callback is about to receive. A member whose
    // callback carries nothing (a plain change notification) answers no-sample
    // — the client polls the matching snapshot instead of subscribing to it.
    await withTimeout(
      first,
      ONE_SHOT_TIMEOUT_MS,
      `${m.path} has not reported a payload within ${ONE_SHOT_TIMEOUT_MS}ms`,
    )
  }
  return { event: collected }
}

async function invoke(m: Member, args: unknown[]): Promise<unknown> {
  if (m.push) return invokePush(m)

  let result = m.fn(...args)
  if (result instanceof Promise) result = await result
  if (isReactive(result)) {
    // The createPoll-based domains only tick while subscribed — the backend is
    // the subscriber for the whole act of serving, and answers the current
    // value. The first subscription waits briefly for the domain's own first
    // poll, so this request answers a reading, not the seed.
    if (!m.keepAlive) {
      let sample: (() => void) | null = null
      const firstSample = new Promise<void>((resolve) => {
        sample = resolve
      })
      m.keepAlive = result.subscribe(() => {
        m.seen = true
        sample?.()
        sample = null
      })
      await settleOrTimeout(firstSample, FIRST_SAMPLE_MS)
    }
    return result.peek()
  }
  if (typeof result === "function") {
    // A member that hands back a function hands back behaviour (a callback
    // subscription); it cannot cross the request surface. Fail loud instead of
    // answering an envelope with no value.
    throw new Error("returned a function — callback members belong in PUSH_MEMBERS")
  }
  return result
}

/** Resolve as soon as `p` settles or after `ms` — a bounded wait, never a
 *  rejection (the caller answers the current value either way). */
function settleOrTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let id: number | null = null
    id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      id = null
      resolve()
      return GLib.SOURCE_REMOVE
    })
    void p.then(() => {
      if (id !== null) GLib.source_remove(id)
      resolve()
    })
  })
}

class NoSample extends Error {}

// ── Request handling ──

/** Handle one request for a domain (`ags request "applets battery state"` in
 *  the instance hosting the backend). Always answers an envelope — a throw is answered as
 *  `call-failed`, an unknown token as `unknown-path`, a bad argument token as
 *  `bad-arg`. */
export async function handleDomainRequest(domain: string, tokens: string[]): Promise<string> {
  const members = TABLE.get(domain)
  if (!members) {
    return replyError(
      "unknown-path",
      `unknown domain '${domain}'. Domains: ${domainNames().join(", ")}`,
    )
  }
  if (tokens.length === 0) {
    // Discovery: list the domain's members.
    return replyOk({ domain, members: domainMembers(domain) })
  }

  const token = tokens[0]
  const resolved = resolveMember(domain, token)
  if (!resolved.name) {
    const hint = resolved.ambiguous.length
      ? `ambiguous '${token}' — candidates: ${resolved.ambiguous.join(", ")}`
      : `unknown member '${token}' in domain '${domain}'`
    return replyError("unknown-path", `${hint}. Members: ${domainMembers(domain).join(", ")}`)
  }
  const m = members.get(resolved.name)
  if (!m) return replyError("unknown-path", `unknown member '${token}' in domain '${domain}'`)

  let args: unknown[]
  try {
    args = tokens.slice(1).map(decodeArg)
  } catch (e) {
    return replyError("bad-arg", `argument is not base64(JSON): ${String(e)}`)
  }

  try {
    return replyOk(await invoke(m, args))
  } catch (e) {
    if (e instanceof NoSample) return replyError("no-sample", e.message)
    return replyError("call-failed", `${domain} ${resolved.name}: ${errorText(e)}`)
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.message}` : String(e)
}
