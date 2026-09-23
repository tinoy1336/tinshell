/**
 * notes session persistence — the restore-across-restart layer.
 *
 * Tracks every open note window (file path → Hyprland address), samples its
 * live geometry + workspace from `hyprctl -j clients` on a light poll, and
 * debounces the result into the app's state file. On mount, `restoreOnce()`
 * re-opens every note recorded in the file and re-applies its saved geometry
 * + workspace via the Lua-config Hyprland dispatchers (0.56: the ONLY working
 * form is `hyprctl dispatch "hl.dsp.<fn>(...)"`).
 *
 * State semantics: the file MIRRORS the currently-open set. A user CLOSE
 * removes the entry (closing the last note leaves `notes: []` — nothing is
 * resurrected). A crash / shell restart leaves the file stale ON PURPOSE —
 * that is exactly what the next mount restores from.
 *
 * Persistence lives in the ONE shared state store (common/state.ts):
 * canonical `~/.local/state/tinshell/apps/notes/state.json` (XDG state dir),
 * versioned + validated + sync atomic writes. The same file + store also
 * holds the closed-note history behind Ctrl+Shift+T / Mod+SHIFT+N (`closed`) — each
 * entry carrying the geometry the note was closed at — and the per-note
 * Ctrl+Shift+S save target (`named`), so the reopen stack, the reopen
 * geometry and the named file all survive an app unload, a shell restart and
 * a reboot.
 *
 * The poll timer only runs while ≥1 note is tracked (no busy timers in the
 * shell). All hyprctl failures are best-effort — never throw into the GTK
 * main loop.
 */
import GLib from "gi://GLib"
import { hyprctlJson } from "@common/hyprland/dispatch"
import { log } from "@common/log/logger"
import { createStateStore } from "@common/state"
import { run, spawnDetached } from "@common/subprocess/run"
import { get as getConfig } from "./config"
import type { Note } from "./Note"

/** Map-time placement rules: register a title-matched windowrule
 *  BEFORE the window maps so Hyprland places it at the saved
 *  workspace + geometry on first commit — no visible "initialize at the
 *  cascade spot then jump" flash. Two callers: the session restore (workspace
 *  + position + size) and a geometry-restoring reopen (§reopenLastClosed —
 *  position + size on the current workspace). Runtime rules are added via
 *  `hyprctl eval 'hl.window_rule({...})'` (the 0.56 Lua runtime; dispatch
 *  rejects window_rule — it is config-scope, not a dispatcher). Rules are
 *  appended after notes-float so size/move/workspace LAST-WIN over the
 *  class-wide notes-float pins. They persist across the session (harmless:
 *  they match exact titles) — bounded by notes × restarts × reopens.
 *
 *  Title derivation MUST mirror Note.tsx exactly: first non-empty line
 *  trimmed, else the basename without .md, sliced to 48 chars. */
function luaEscape(s: string): string {
  // 1. regex-escape the title for Hyprland's ^…$ match, 2. Lua-string-escape
  //    the result (backslashes doubled, double quotes escaped).
  const regexEsc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return regexEsc.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** The title a note window for `path` will carry at map time: ALWAYS the
 *  basename (without .md). Note.tsx sets buffer.text BEFORE connecting the
 *  "changed" handler, so the content-derived title only appears after the
 *  first user edit — a first-line title here would not match the window the
 *  map rule has to hit. */
function mapTitle(path: string): string {
  return GLib.path_get_basename(path).replace(/\.md$/, "")
}

/** Window-rule placement: `ws` present = ALSO pin that workspace (session
 *  restore rebuilds the previous workspace layout); absent = leave the window
 *  on the current workspace (a reopen restores position + size only). */
interface MapPlacement {
  path: string
  x: number
  y: number
  w: number
  h: number
  ws?: number
}

/** Monotonic rule-name suffix: a rule is registered per restore AND per
 *  geometry-restoring reopen, so a name derived from the geometry alone would
 *  repeat within one Hyprland session. */
let ruleSeq = 0

async function registerMapRule(p: MapPlacement): Promise<void> {
  const title = luaEscape(mapTitle(p.path))
  const workspace = p.ws === undefined ? "" : `workspace = "${p.ws} silent", `
  const code =
    `hl.window_rule({ name = "notes-restore-${ruleSeq++}", ` +
    `match = { title = "^${title}$" }, float = true, ` +
    `${workspace}move = { ${p.x}, ${p.y} }, size = { ${p.w}, ${p.h} } })`
  try {
    // AWAITED — the rule must be registered BEFORE the window maps. A
    // spawnDetached fire-and-forget raced the open: windows mapped first,
    // rules landed after, so every restored window appeared at the default
    // cascade spot and dispersed a beat later.
    const res = await run(["hyprctl", "eval", code])
    if (res.exit !== 0) log(`session: map rule rejected for ${p.path}: ${res.stderr}`)
    else
      log(
        `session: map rule for ${p.path} (${p.ws === undefined ? "current ws" : `ws=${p.ws}`} ${p.x},${p.y} ${p.w}x${p.h})`,
      )
  } catch (err) {
    log(`session: map rule failed for ${p.path}: ${err}`)
  }
}

/** One persisted note entry. Coordinates are LOGICAL screen px (hyprctl space). */
interface SessionEntry {
  path: string
  ws: number
  x: number
  y: number
  w: number
  h: number
}

/** One entry of the persisted closed-note history (the Ctrl+Shift+T / Mod+SHIFT+N
 *  stack). `geometry` is the note's live geometry sampled at close time;
 *  absent for an entry recorded before the note ever got a polled session
 *  entry — such a note reopens at Hyprland's default spot. */
interface ClosedEntry {
  path: string
  geometry?: { x: number; y: number; w: number; h: number }
}

/** Validator for a persisted `closed` entry (see ClosedEntry). A bare path
 *  string is the shape written before entries carried geometry — accepted so
 *  an existing history is never dropped on load. */
function isClosedEntry(v: unknown): v is ClosedEntry {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false
  const e = v as { path?: unknown; geometry?: unknown }
  if (typeof e.path !== "string") return false
  if (e.geometry === undefined) return true
  const g = e.geometry as Record<string, unknown>
  return (
    !!g &&
    typeof g === "object" &&
    !Array.isArray(g) &&
    [g.x, g.y, g.w, g.h].every((n) => typeof n === "number" && Number.isFinite(n))
  )
}
// ── module state (reset by resetSession on lazy unmount) ──
const tracked = new Map<string, Note>()
const addr = new Map<string, string>()
const applied = new Set<string>()
const applyTries = new Map<string, number>()
const entries = new Map<string, SessionEntry>()
let pollTimer: number | null = null
let writeTimer: number | null = null
let pollInFlight = false
let restored = false

// ── shared state store (common/state) ──
// The session file lives at the canonical XDG-state location
// (~/.local/state/tinshell/apps/notes/state.json — the same convention dock
// established), versioned + validated + sync atomic writes, backed by the
// ONE shared state-store module. The registry restoreIf predicate
// (common/host/registry.ts) reads this canonical file via
// appStateFilePath("notes").
const sessionStore = createStateStore({
  app: "notes",
  version: 1,
  keys: {
    notes: (v): boolean => Array.isArray(v),
    closed: (v): boolean =>
      Array.isArray(v) && v.every((e) => typeof e === "string" || isClosedEntry(e)),
    named: (v): boolean =>
      !!v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.values(v as Record<string, unknown>).every((t) => typeof t === "string"),
  },
})

/** Notes recorded in the persisted state (the store mirror). */
function savedNotes(): SessionEntry[] {
  const notes = sessionStore.get("notes")
  return Array.isArray(notes) ? (notes as SessionEntry[]) : []
}

function writeState(): void {
  if (writeTimer !== null) {
    GLib.source_remove(writeTimer)
    writeTimer = null
  }
  const ok = sessionStore.set("notes", [...entries.values()])
  if (!ok) log("session: state write failed")
}

function writeStateDebounced(): void {
  if (writeTimer !== null) GLib.source_remove(writeTimer)
  // 200ms: the file is tiny and the write cheap — crash staleness
  // should be bounded by the poll, not doubled by a second debounce.
  writeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
    writeTimer = null
    writeState()
    return GLib.SOURCE_REMOVE
  })
}

/** Synchronous final geometry sample (GLib.spawn_command_line_sync, ~5-15ms
 *  main-loop block — imperceptible, and sync is REQUIRED here: the async
 *  run() cannot complete before the window is destroyed on close).
 *  Updates every tracked entry from hyprctl so a move→close inside the poll
 *  interval persists the FINAL position, not the last sampled one. Falls
 *  back to existing entries on any failure (compositor dying = session lost
 *  anyway). Called on untrack and flush, both BEFORE the state write. */
function sampleGeometrySync(): void {
  try {
    const [, stdout] = GLib.spawn_command_line_sync("hyprctl -j clients")
    const clients = JSON.parse(new TextDecoder().decode(stdout)) as HyprClient[]
    for (const [path, a] of addr) {
      const c = clients.find((cl) => cl.address === a)
      if (!c || !c.size || !c.at) continue
      const e = entries.get(path)
      if (!e) continue
      const ws = c.workspace?.id
      if (typeof ws === "number") e.ws = ws
      e.x = c.at[0]
      e.y = c.at[1]
      e.w = c.size[0]
      e.h = c.size[1]
    }
  } catch (err) {
    log(`session: sync geometry sample failed: ${err}`)
  }
}

// ── dispatch helpers (fire-and-forget, Lua-config Hyprland 0.56 form) ──

function dispatch(lua: string): void {
  spawnDetached(["hyprctl", "dispatch", lua])
}

function applyGeometry(e: SessionEntry, address: string): void {
  dispatch(
    `hl.dsp.window.move({ workspace = ${e.ws}, follow = false, window = 'address:${address}' })`,
  )
  dispatch(`hl.dsp.window.resize({ x = ${e.w}, y = ${e.h}, window = 'address:${address}' })`)
  dispatch(`hl.dsp.window.move({ x = ${e.x}, y = ${e.y}, window = 'address:${address}' })`)
}

// ── track / untrack (called from the note registry) ──

export function track(note: Note): void {
  tracked.set(note.path, note)
  // Adopt any already-persisted entry for this path (restore re-open).
  if (!entries.has(note.path)) {
    const saved = savedNotes().find((n) => n.path === note.path)
    if (saved) entries.set(note.path, { ...saved })
  }
  // First tick early: a note that is moved and closed within the normal poll
  // interval must already have its address + baseline entry, or the close has
  // no geometry to record and the reopen history loses it. After this tick
  // the cadence is the configured session.pollMs again.
  ensurePoll(250)
}

/** Drop a tracked note. Returns the entry the note was last sampled at (the
 *  FINAL geometry, sampled here) so the close path can record it in the
 *  closed-note history — one sample serving both the session drop and the
 *  reopen history. Undefined for a note that never got a polled entry. */
export function untrack(path: string): SessionEntry | undefined {
  log(`session: untrack ${path}`)
  // Sample FINAL geometry before dropping anything — the poll may not have
  // run since the last move (close within pollMs = stale entry otherwise).
  sampleGeometrySync()
  const sampled = entries.get(path)
  const finalEntry = sampled ? { ...sampled } : undefined
  tracked.delete(path)
  addr.delete(path)
  applied.delete(path)
  applyTries.delete(path)
  entries.delete(path)
  if (tracked.size === 0) {
    // Last note gone — stop the poll, drop entries NOW (a user close must not
    // resurrect), keep the file on disk (empty notes array).
    stopPoll()
    writeState()
  } else {
    writeState()
  }
  return finalEntry
}

/** Sync-flush (unmount / shutdown). Samples final geometry first (runs
 *  BEFORE windows are destroyed — see unmountNotes ordering). */
export function flush(): void {
  stopPoll()
  if (writeTimer !== null) {
    GLib.source_remove(writeTimer)
    writeTimer = null
  }
  sampleGeometrySync()
  writeState()
}

/** Reset ALL module state (lazy-unload re-arm path). The closed-note
 *  history is NOT module state — it lives in the store and stays on disk. */
export function resetSession(): void {
  flush()
  tracked.clear()
  addr.clear()
  applied.clear()
  applyTries.clear()
  entries.clear()
  restored = false
}

// ── closed-note history (Ctrl+Shift+T) ──

/** Closed-note stack cap: bounded so the state file stays tiny and the
 *  history cannot grow without limit under open/close churn. */
const CLOSED_STACK_MAX = 20

function closedStack(): ClosedEntry[] {
  const v = sessionStore.get("closed")
  if (!Array.isArray(v)) return []
  return (v as unknown[]).flatMap((e) => {
    if (typeof e === "string") return [{ path: e }] // legacy bare-path entry
    return isClosedEntry(e) ? [e] : []
  })
}

/** Record a USER close (the close-request path only — never an unmount or a
 *  bare destroy) as the newest entry of the reopen history, with the geometry
 *  the note was closed at (sampled by the caller's untrack — see
 *  notes.ts close-request). A path already in the stack moves to the front
 *  instead of repeating. */
export function recordClosed(path: string, entry?: SessionEntry): void {
  const closed: ClosedEntry = entry
    ? { path, geometry: { x: entry.x, y: entry.y, w: entry.w, h: entry.h } }
    : { path }
  const stack = closedStack().filter((e) => e.path !== path)
  stack.unshift(closed)
  if (!sessionStore.set("closed", stack.slice(0, CLOSED_STACK_MAX))) {
    log(`session: closed-stack write failed for ${path}`)
  }
}

/** Pop the newest closed note and hand it to the injected reopener. Entries
 *  whose file is gone (pruned by the storage cap, deleted by hand) are
 *  DROPPED — the reopen path creates a missing note, which would otherwise
 *  resurrect an empty file under the old name. Returns true when a note is
 *  being reopened, false when the history held nothing restorable (the
 *  Mod+SHIFT+N caller then opens a blank note).
 *
 *  A recorded geometry is restored through the map-time window rule the
 *  session restore already uses, registered (and awaited) BEFORE the window
 *  opens so the note's FIRST commit is at its old position and size — no
 *  default-spot flash, and no dispatcher race. The saved WORKSPACE is
 *  deliberately not restored here (unlike a session restore, which rebuilds
 *  the previous workspace layout): the reopened note stays on the workspace
 *  the user is on, otherwise the chord would look dead whenever the closed
 *  note lived elsewhere. Position + size then feed the normal poll, so the
 *  reopened note is tracked at them like any other. */
export function reopenLastClosed(): boolean {
  const stack = closedStack()
  let dropped = false
  while (stack.length > 0) {
    const entry = stack.shift() as ClosedEntry
    if (!GLib.file_test(entry.path, GLib.FileTest.EXISTS)) {
      dropped = true
      log(`session: closed note gone, skipping ${entry.path}`)
      continue
    }
    sessionStore.set("closed", stack)
    log(`session: reopening closed note ${entry.path}`)
    // Already open (the window outlived its stack entry): focus it, never
    // yank it to the recorded spot.
    if (entry.geometry && !tracked.has(entry.path)) {
      // Position + size only (no `ws`) — see the doc comment above.
      void registerMapRule({ path: entry.path, ...entry.geometry }).then(() => reopener(entry.path))
    } else {
      reopener(entry.path)
    }
    return true
  }
  if (dropped) sessionStore.set("closed", stack)
  return false
}

// ── Ctrl+Shift+S save target (the note's named file) ──
// The autosave file and the Ctrl+Shift+S export target are different things:
// the named file is where an explicit Ctrl+S writes. It is remembered per
// NOTE PATH in the same state store, so a note reopened by Ctrl+Shift+T /
// Mod+SHIFT+N or restored after a restart still knows the file it was last saved
// to.

/** Cap on remembered save targets: the map is keyed by note path and would
 *  otherwise grow with every save-as for the life of the state file. */
const NAMED_TARGET_MAX = 100

function namedTargets(): Record<string, string> {
  const v = sessionStore.get("named")
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {}
}

/** The file Ctrl+S writes for `notePath` — null until Ctrl+Shift+S names one
 *  (Ctrl+S is inert before that). */
export function namedTargetFor(notePath: string): string | null {
  const target = namedTargets()[notePath]
  return typeof target === "string" ? target : null
}

/** Remember `target` as `notePath`'s Ctrl+S file. The map is capped, oldest
 *  entry dropped. */
export function setNamedTarget(notePath: string, target: string): void {
  // Copy the mirror first: a rejected set must leave the live map consistent
  // with the file on disk.
  const map = { ...namedTargets() }
  delete map[notePath]
  map[notePath] = target
  const keys = Object.keys(map)
  for (const key of keys.slice(0, Math.max(0, keys.length - NAMED_TARGET_MAX))) delete map[key]
  if (!sessionStore.set("named", map)) log(`session: named-target write failed for ${notePath}`)
}

// ── restore ──

/** Re-open every note recorded in the state file. No-op when the state is
 *  empty or already restored. Focus-safe: restored windows never grab focus. */
export function restoreOnce(): void {
  if (restored) return
  restored = true
  if (getConfig("session.enabled") === false) return

  // Fresh mirror from disk at every mount (module scope survives lazy
  // unload/reload cycles in the shell — the mirror must not go stale).
  sessionStore.reload()
  const notes = savedNotes()
  const existing = notes.filter((n) => n.path && GLib.file_test(n.path, GLib.FileTest.EXISTS))
  if (existing.length === 0) {
    // Nothing restorable — if the file recorded stale entries (files deleted
    // since), purge them so the state converges to empty instead of carrying
    // them forever.
    if (notes.length > 0) writeState()
    return
  }

  // Strict ordering: EVERY map rule is awaited before the first window
  // opens, so each window's first commit is already fully placed — no
  // visible init-then-jump. The sync restoreOnce shells out to this async
  // chain (mount context is sync; nothing else must race the opener).
  void (async () => {
    for (const e of existing) {
      await registerMapRule(e)
    }
    // Lazy import avoidance: session.ts is bundled with the app; notes.ts
    // imports session.ts and hands us the opener via setOpener to break the
    // import cycle.
    for (const e of existing) {
      try {
        opener(e.path)
      } catch (err) {
        log(`session: restore open failed for ${e.path}: ${err}`)
      }
    }
    log(`session: restoring ${existing.length} note(s)`)
    ensurePoll(150) // accelerated until every note has its geometry applied
    // Failsafe: if a window never settles (no address, weird compositor
    // state), reveal it anyway rather than leaving an invisible note.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
      for (const [p, n] of tracked) {
        if (applied.has(p)) continue
        n.reveal()
        log(`session: failsafe reveal for ${p}`)
      }
      return GLib.SOURCE_REMOVE
    })
  })()
}

/** Injected by notes.ts (avoids the session ↔ notes import cycle). */
let opener: (path: string) => void = () => {}
export function setOpener(fn: (path: string) => void): void {
  opener = fn
}

/** Injected by notes.ts — the Ctrl+Shift+T reopen of a CLOSED note (the
 *  registry's create-or-focus open path, focused; distinct from the silent
 *  restore opener above). */
let reopener: (path: string) => void = () => {}
export function setReopener(fn: (path: string) => void): void {
  reopener = fn
}

// ── poll: address assignment + geometry sampling + geometry apply ──

function ensurePoll(initialMs?: number): void {
  if (pollTimer !== null) return
  const tick = (): boolean => {
    pollTimer = null
    if (tracked.size === 0) return GLib.SOURCE_REMOVE
    if (!pollInFlight) {
      pollInFlight = true
      void pollOnce()
        .catch((e) => log(`session: poll failed: ${e}`))
        .finally(() => {
          pollInFlight = false
        })
    }
    const pending = [...tracked.keys()].some(
      (p) => !applied.has(p) && addr.has(p) && entries.has(p),
    )
    const accel = initialMs ?? 150
    // Accelerated cadence while a restore apply is outstanding, config
    // cadence once every note has settled.
    scheduleNext(pending ? accel : getConfig("session.pollMs"))
    return GLib.SOURCE_REMOVE
  }
  const scheduleNext = (ms: number) => {
    const interval = Math.max(250, ms)
    pollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, tick)
  }
  scheduleNext(initialMs ?? getConfig("session.pollMs"))
}

function stopPoll(): void {
  if (pollTimer !== null) {
    GLib.source_remove(pollTimer)
    pollTimer = null
  }
}

interface HyprClient {
  address: string
  class: string
  title: string
  at: number[]
  size: number[]
  workspace?: { id?: number }
  floating?: boolean
}

async function pollOnce(): Promise<void> {
  const clients = (await hyprctlJson("clients")) as HyprClient[] | null
  if (!clients) return
  const mine = clients.filter((c) => c.class === "io.Astal.notes")
  const claimed = new Set(mine.filter((c) => [...addr.values()].includes(c.address)))

  // 0. Stale-entry guard: drop entries for notes no longer tracked (defensive —
  //    untrack normally removes them; this keeps the file honest if a destroy
  //    signal ever slips past).
  for (const p of [...entries.keys()]) {
    if (!tracked.has(p)) entries.delete(p)
  }

  // 1. Assign addresses to tracked notes lacking one.
  const unassigned = [...tracked.keys()].filter((p) => !addr.has(p))
  const free = mine.filter((c) => !claimed.has(c) && c.address)
  for (const path of unassigned) {
    const note = tracked.get(path)
    if (!note) continue
    const want = note.win.title ?? ""
    // Exact title match first, then a prefix match (title truncation guards).
    let hit = free.find((c) => c.title === want)
    if (!hit && want.length >= 8) hit = free.find((c) => c.title.startsWith(want.slice(0, 16)))
    if (!hit) continue
    addr.set(path, hit.address)
    free.splice(free.indexOf(hit), 1)
  }

  // 2. Drop addresses that vanished (note closed outside the registry).
  const live = new Set(mine.map((c) => c.address))
  for (const [path, a] of addr) {
    if (!live.has(a)) addr.delete(path)
  }

  let dirty = false

  // 3. Sample geometry for tracked notes with an address — but ONLY when the
  //    note has no saved entry yet (first baseline for a brand-new note) or
  //    its saved geometry has already been applied. Sampling a just-restored
  //    note records Hyprland's default placement and clobbers the saved
  //    entry before step 4 can apply it.
  for (const [path, a] of addr) {
    if (applied.has(path) === false && entries.has(path)) continue
    const c = mine.find((cl) => cl.address === a)
    if (!c || !c.size || !c.at) continue
    const ws = c.workspace?.id
    const e: SessionEntry = entries.get(path) ?? {
      path,
      ws: ws ?? 1,
      x: c.at[0],
      y: c.at[1],
      w: c.size[0],
      h: c.size[1],
    }
    if (typeof ws === "number") e.ws = ws
    e.x = c.at[0]
    e.y = c.at[1]
    e.w = c.size[0]
    e.h = c.size[1]
    entries.set(path, e)
    dirty = true
  }
  if (dirty) writeStateDebounced()

  // 4. Apply saved geometry once per note (restore path): workspace first
  //    (silent), then exact resize, then exact position.
  for (const [path, a] of addr) {
    if (applied.has(path)) continue
    const e = entries.get(path)
    if (!e) continue
    const c = mine.find((cl) => cl.address === a)
    const tries = applyTries.get(path) ?? 0
    // The notes-float windowrule floats the window at map; wait (bounded)
    // for the float + map to settle so the dispatches land on a real client.
    if (c && !c.floating && tries < 10) {
      applyTries.set(path, tries + 1)
      continue
    }
    applyGeometry(e, a)
    applied.add(path)
    applyTries.delete(path)
    tracked.get(path)?.reveal()
    log(`session: applied geometry for ${path} (ws=${e.ws} ${e.x},${e.y} ${e.w}x${e.h})`)
  }
}

/** Debug surface (`request notes session`): current tracking state. */
export function debugState(): string {
  return JSON.stringify(
    [...tracked.keys()].map((p) => ({
      path: p,
      addr: addr.get(p) ?? null,
      applied: applied.has(p),
      entry: entries.get(p) ?? null,
    })),
  )
}
