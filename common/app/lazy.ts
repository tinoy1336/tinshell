/**
 * Lazy in-process app loader — the on-demand lifecycle for the standalone
 * apps (notes/files/annotate/media) in any RESIDENT instance that hosts
 * them (the production shell and dev islands/combos).
 *
 * A resident instance starts with ONLY the always-on members of its set
 * eager. A lazy app is loaded on first use (any request whose first token
 * names it), then unloaded after an idle grace once its last window closes,
 * so open/close cycles repeat without leaking (module-scope state is reset
 * in each app's `unmount`; per-window refs die with the windows).
 *
 * Registration lives in the host entry (common/host/entry.ts): EVERY
 * RESIDENT instance (TINSHELL_SHELL=1) registers the lazy apps OUTSIDE its set
 * via registerLazyApps; pure-lazy singleton islands register nothing, so
 * every function here no-ops when the registry is empty (isLazyApp →
 * false, ensureLoaded → false).
 *
 * Module-cache rule: esbuild evaluates an in-bundle
 * `import()` ONCE and caches the module forever. Command handlers register
 * at module top level — they stay registered after unload (by design, no
 * unregister), so a re-load only needs `mount()` to re-arm STATE, never
 * re-evaluate. `mount()` must be idempotent.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import type Gtk from "gi://Gtk?version=4.0"
import { ensureNamespace, register } from "@common/commands/registry"
import { ensureDir, writeFileSync } from "@common/fs/files"
import { ignore } from "@common/log/logger"
import { instanceName, isProductionShell } from "./mode"

// The toolkit is loaded ON THE FIRST LAZY-APP LOAD, never at import time: this
// module is imported by the universal entry before any toolkit exists, and the
// per-app CSS provider (`applyAppCss`) is the only thing here that needs
// Gtk/Gdk.
type GtkModule = typeof import("gi://Gtk?version=4.0")["default"]
type GdkModule = typeof import("gi://Gdk?version=4.0")["default"]
let gtk: GtkModule | null = null
let gdk: GdkModule | null = null

async function loadToolkit(): Promise<void> {
  if (gtk && gdk) return
  const [g, d] = await Promise.all([import("gi://Gtk?version=4.0"), import("gi://Gdk?version=4.0")])
  gtk = g.default
  gdk = d.default
}

interface LazyAppModule {
  /** Re-arm app state (idempotent). Called once per load. */
  mount: () => void
  /** Reset all module-scope state + close windows (idempotent). */
  unmount: () => void
  /** App stylesheet (already includes common/shell/theme.css). */
  css: string
}

interface LazyAppConfig {
  /** Dynamic import of the app's mount module (esbuild bundles it). */
  load: () => Promise<LazyAppModule>
  /** Idle grace before unload after the last window closes (ms).
   *  Non-finite / <= 0 = never unload (no timer armed; must NOT be a huge
   *  number — GLib timeout intervals are uint32, see scheduleUnload). */
  graceMs?: number
  /** Extra boot-restore signal: when truthy at host start, the app is
   *  restored by restoreLoadedApps even if it is absent from the persisted
   *  loaded set. For apps that mirror their open-window set in a DURABLE
   *  file (notes state.json) — the loaded set lives under
   *  XDG_RUNTIME_DIR (best-effort same-login memory), so it must not be the
   *  only trigger for reopening windows the app itself still records.
   *  Evaluated by restoreLoadedApps in the production shell on EVERY boot,
   *  and in a resident island ONLY when that island's own loaded-set memory
   *  file does not exist (see restoreLoadedApps — the durable signal is
   *  global, not per-instance, so a present-but-empty memory file must stay
   *  authoritative or every resident island would claim the same open work). */
  restoreIf?: () => boolean
}

interface LazyApp {
  cfg: LazyAppConfig
  state:
    | { status: "unloaded" }
    | { status: "loading"; promise: Promise<boolean> }
    | {
        status: "loaded"
        module: LazyAppModule
        timer: number | null
      }
    | { status: "unloading" }
}

const apps = new Map<string, LazyApp>()

// CSS providers are applied ONCE per lazy app and NEVER removed while the
// process lives: removing a lazy app's provider after
// its windows closed triggers a GTK restyle storm → JS-heap OOM runaway
// (load/unload cycles wedge within 2 cycles with the remove, run flat
// without it). The provider content is
// static per app (baked module CSS), so keeping it costs nothing and a
// re-load reuses the existing provider.
const cssProviders = new Map<string, Gtk.CssProvider>()

// In-flight unload promises, keyed by app name. Held OUTSIDE the state
// union: the unloading state must never store the promise it belongs to
// (see the unloadNow fix below — a settled promise reachable from the
// "unloading" state let ensureLoaded re-arm .then on it forever = infinite
// microtask recursion = the GB-scale OOM runaway).
const unloadPromises = new Map<string, Promise<void>>()

const DEFAULT_GRACE_MS = 60_000

/** Declare a lazy app in a resident instance. Pre-declares its namespace
 *  node (NO handler — see registry.ensureNamespace) so `request ""` (the
 *  router probe) lists it from boot; the real handlers register as
 *  subcommands on first load and stay forever. */
export function registerLazyApp(name: string, cfg: LazyAppConfig): void {
  ensureNamespace([name])
  apps.set(name, { cfg: { graceMs: DEFAULT_GRACE_MS, ...cfg }, state: { status: "unloaded" } })
  // `<name> quit` in a host that lazy-hosts the app = "tear this app down and
  // unload it", NEVER a process quit: the host owns the process (quitting it
  // when the user closes notes would kill every surface it hosts). The app's
  // own instance — a pure-lazy island, which registers nothing here — answers
  // `<name> quit` with its own teardown + process quit (createApp).
  register([name, "quit"], (_args, res) => {
    res("quitting")
    // unloadNow is synchronous through unmount (the app's window destroy +
    // flush), so the reply above still reaches the bus on the live host.
    void unloadNow(name)
  })
}

export function isLazyApp(name: string): boolean {
  return apps.has(name)
}

export function isLoaded(name: string): boolean {
  return apps.get(name)?.state.status === "loaded"
}

function loadedApps(): string[] {
  return [...apps.entries()].filter(([, a]) => a.state.status === "loaded").map(([n]) => n)
}

// ── loaded-set persistence (restart restore) ──
// RESIDENT instances (the production shell AND dev islands that lazy-host
// not-in-set apps) persist WHICH lazy apps are loaded, so a restart / crash
// can bring back the apps that were running when the process died — a
// previously-running app (notes/…) must not need a fresh request to re-open
// after a restart. This is separate from any app's own session data (notes
// state.json records WHAT windows were open; the loaded set records
// THAT the app was running at all). Pure-lazy singleton islands register no
// lazy apps → nothing here is ever reached.
//
// The state file is PER-OWNER, keyed by the instance name: the production
// shell owns lazy-loaded.json (one shell per login, so its set is never
// shared with another instance) and every OTHER
// resident instance owns lazy-loaded-<instance>.json. Per-owner files are
// the only correct shape for islands: the loaded set is only meaningful to
// the instance that actually hosted the apps, N resident islands (full
// island mode) must never read each other's — or a stale shell's — set (an
// island boot would wrongly restore the shell's apps), and a single shared
// file would be clobbered by N writers. XDG_RUNTIME_DIR survives process
// restarts + crashes but is cleared on logout/reboot — a fresh login should
// not auto-fan-out desktop apps.

const LOADED_STATE_FILE = "lazy-loaded.json"

interface LoadedState {
  /** Apps that were loaded when the last process died (restore candidates). */
  loaded: string[]
  /** Consecutive boot-restore load failures per app (crash-loop guard: an app
   *  whose load fails twice in a row is dropped and never retried). */
  failCounts: Record<string, number>
}

/** Loaded-state file of THIS instance. The shell owns lazy-loaded.json;
 *  every other resident instance
 *  owns lazy-loaded-<instance>.json. (TINSHELL_HOST_INSTANCE is always set for
 *  instances that reach here — the universal entry hard-errors without it
 *  and is the only place lazy apps are registered.) */
function loadedStatePath(): string {
  const file = isProductionShell ? LOADED_STATE_FILE : `lazy-loaded-${instanceName}.json`
  return GLib.build_filenamev([GLib.get_user_runtime_dir(), "tinshell", file])
}

/** Read this instance's loaded-state file. `fileExisted` tells the caller
 *  whether usable restore memory is present: ONLY a file that opens AND
 *  parses counts as memory. A missing file (a resident island's first boot
 *  under per-owner memory, or any fresh login — XDG_RUNTIME_DIR clears on
 *  logout) and an unreadable or corrupt file are ALL treated as "no memory"
 *  (`fileExisted: false`), so restoreLoadedApps falls through to the
 *  durable-signal (restoreIf) backstop exactly as it does when the file has
 *  never been written. Do NOT read this file without the guard below:
 *  gjs `GLib.file_get_contents` THROWS a GLib.FileError when the file cannot
 *  be opened (it does NOT return [false, null]) — an unguarded read makes
 *  every first-restart adoption crash restoreLoadedApps before its backstop
 *  ever runs. */
function readLoadedState(): LoadedState & { fileExisted: boolean } {
  const path = loadedStatePath()
  let contents: Uint8Array | null = null
  try {
    contents = GLib.file_get_contents(path)[1]
  } catch (e) {
    // Missing / unreadable file = no memory. Distinguish only the message:
    // ENOENT is the designed first-boot state, other failures are anomalies
    // (permissions, …) — both classify identically below.
    const code = (e as { code?: number } | null)?.code
    const reason = code === GLib.FileError.NOENT ? "missing" : `unreadable (${String(e)})`
    console.warn(`[lazy] loaded-state file '${path}' ${reason}: no restore memory`)
    return { loaded: [], failCounts: {}, fileExisted: false }
  }
  if (!contents) {
    // Defensive: a binding that reports open failure as [false, null] instead
    // of a throw lands here — same semantics.
    console.warn(`[lazy] loaded-state file '${path}' missing or unreadable: no restore memory`)
    return { loaded: [], failCounts: {}, fileExisted: false }
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(contents)) as Partial<LoadedState>
    return {
      loaded: Array.isArray(parsed.loaded) ? parsed.loaded : [],
      failCounts:
        parsed.failCounts && typeof parsed.failCounts === "object"
          ? (parsed.failCounts as Record<string, number>)
          : {},
      fileExisted: true,
    }
  } catch {
    // Present but unparsable — equally untrustworthy as restore memory.
    console.warn(`[lazy] loaded-state file '${path}' corrupt: no restore memory`)
    return { loaded: [], failCounts: {}, fileExisted: false }
  }
}

function writeLoadedState(state: LoadedState): void {
  if (!writeFileSync(loadedStatePath(), JSON.stringify(state), 0o700)) {
    // A lost loaded-set only costs a re-load of the app on next boot.
    ignore("lazy loaded-set persist")
  }
}

/** Suppress persistLoadedSet() while restoreLoadedApps() is executing so the
 *  loop's successful `ensureLoaded` calls (which each persist) can't clobber
 *  the failure bookkeeping that restore is accumulating. */
let restoring = false

/** Persist the currently-loaded set to THIS instance's own file (reachable
 *  only from load/unload paths, which require a lazy registry — pure-lazy
 *  singletons never call it). Carries any existing failure counts forward
 *  untouched (they are only mutated by restoreLoadedApps). */
function persistLoadedSet(): void {
  if (restoring) return
  const prior = readLoadedState()
  writeLoadedState({ loaded: loadedApps(), failCounts: prior.failCounts })
}

// Non-side-effect probe for status tooling (tinshell-mode): lists the lazy apps
// currently LOADED in this instance. Deliberately a top-level `lazy`
// namespace — the request pre-step lazy-loads any request whose first token
// names a lazy app, so probing `<app> ping` would itself load the app and
// make every instance report it as hosted.
register(["lazy", "status"], (_t, res) => {
  res(loadedApps().join(" "))
})

/** Load (or wait for) a lazy app. Resolves true when mounted. */
export function ensureLoaded(name: string): Promise<boolean> {
  const entry = apps.get(name)
  if (!entry) return Promise.resolve(false)

  if (entry.state.status === "loading") return entry.state.promise
  if (entry.state.status === "loaded") return Promise.resolve(true)
  if (entry.state.status === "unloading") {
    // Wait for the in-flight unload (settled ⇒ state is "unloaded"), then
    // re-check. BOUNDED: the unload promise is fetched from unloadPromises,
    // not from the state — re-arming .then on a settled promise that the
    // state still points at recursed forever.
    const p = unloadPromises.get(name) ?? Promise.resolve()
    return p.then(
      () => ensureLoaded(name),
      () => ensureLoaded(name),
    )
  }
  return loadApp(entry)
}

function loadApp(entry: LazyApp): Promise<boolean> {
  const promise = (async (): Promise<boolean> => {
    try {
      const mod = await entry.cfg.load()
      mod.mount()
      await applyAppCss(entryName(entry), mod.css)
      entry.state = { status: "loaded", module: mod, timer: null }
      persistLoadedSet()
      return true
    } catch (e: unknown) {
      entry.state = { status: "unloaded" }
      console.error(`[lazy] failed to load '${entryName(entry)}': ${String(e)}`)
      return false
    }
  })()
  entry.state = { status: "loading", promise }
  return promise
}

/** Arm the idle-grace unload timer (no-op when not loaded or already armed).
 *
 *  GRACEMS CONTRACT: `graceMs: Number.MAX_SAFE_INTEGER`
 *  (the "never unload" sentinel) OVERFLOWS GLib's uint32 interval arg →
 *  timeout_add THREW → the throw unwound through the caller's window
 *  close-request handler, aborting the close mid-teardown (orphaned window,
 *  half-torn-down state) and the next load wedged the shell into a GB-scale
 *  OOM runaway. Rules:
 *    - non-finite / <= 0 → "never unload": NO timer armed (clean, no throw)
 *    - finite but > GLib MAXUINT32 (4294967295) → clamped (49.7 days ≈ never)
 *    - arm must NEVER throw — callers run inside signal handlers.
 *  A timer returning here must still clear entry.state.timer (null) so a
 *  later scheduleUnload call can arm a fresh one. */
export function scheduleUnload(name: string): void {
  const entry = apps.get(name)
  if (!entry || entry.state.status !== "loaded") return
  if (entry.state.timer !== null) return
  const graceMs = entry.cfg.graceMs ?? DEFAULT_GRACE_MS
  if (!Number.isFinite(graceMs) || graceMs <= 0) return // never unload
  const interval = Math.min(Math.floor(graceMs), 4_294_967_295)
  entry.state.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
    const e = apps.get(name)
    if (e?.state.status === "loaded" && e.state.timer !== null) {
      e.state.timer = null
      void unloadNow(name)
    }
    return GLib.SOURCE_REMOVE
  })
}

/** Cancel a pending grace unload (a new request/window arrived). */
export function cancelUnload(name: string): void {
  const entry = apps.get(name)
  if (!entry || entry.state.status !== "loaded") return
  if (entry.state.timer !== null) {
    GLib.source_remove(entry.state.timer)
    entry.state.timer = null
  }
}

/** Immediate teardown: unmount + remove CSS + drop to unloaded. */
export function unloadNow(name: string, persist = true): Promise<void> {
  const entry = apps.get(name)
  if (!entry) return Promise.resolve()
  if (entry.state.status === "unloading") {
    // Same in-flight unload — dedupe onto its promise (bounded: the promise
    // lives in unloadPromises, never reachable from the state itself).
    return unloadPromises.get(name) ?? Promise.resolve()
  }
  if (entry.state.status !== "loaded") {
    if (entry.state.status === "loading") {
      // Load raced an unload: wait for the load to settle, then unload.
      const loading = entry.state.promise
      return loading.then(() => unloadNow(name, persist))
    }
    return Promise.resolve()
  }

  // Mark unloading BEFORE the body runs: the body has no await, so it
  // completes SYNCHRONOUSLY — any state written inside it (the finally's
  // "unloaded") must not be clobbered afterwards by the caller. (Assigning
  // { unloading, promise } AFTER the IIFE re-freezes the
  // state at "unloading" with a settled promise ⇒ ensureLoaded recursion
  // = a GB-scale OOM runaway.)
  const loaded = entry.state
  entry.state = { status: "unloading" }
  const promise = (async (): Promise<void> => {
    try {
      if (loaded.timer !== null) {
        GLib.source_remove(loaded.timer)
        loaded.timer = null
      }
      loaded.module.unmount()
    } catch (e) {
      // A throwing unmount must NEVER hang the request surface. Log + reset.
      console.error(`[lazy] unmount of '${entryName(entry)}' failed: ${String(e)}`)
    } finally {
      unloadPromises.delete(name)
      entry.state = { status: "unloaded" }
      // Grace (idle) unload reflects reality — persist it. Shutdown unloadAll
      // passes persist=false so the truth ("this app was running") survives a
      // clean stop and a restart brings it back.
      if (persist) {
        // A genuine unload means this instance no longer hosts the app: drop
        // the restore claim so any instance may adopt it at the next boot.
        releaseRestoreClaim(name)
        persistLoadedSet()
      }
    }
  })()
  unloadPromises.set(name, promise)
  return promise
}

/** Unload everything loaded (quit path). */
export async function unloadAll(): Promise<void> {
  const names = [...apps.keys()]
  // persist=false: the shutdown path must NOT clear the loaded set — "what was
  // running" is exactly what a restart should restore.
  await Promise.all(names.map((n) => unloadNow(n, false)))
}

// ── exactly-once restore claim ──
// A durable restoreIf signal (notes' state.json) is GLOBAL: it names the same
// open windows to EVERY instance that reads it. Any resident instance booting
// without its own memory file adopts every such app, so two instances mount
// two editors on one file (duplicate windows, N writers on one .md). One claim
// file per app, created with an exclusive open, makes exactly ONE live
// instance the adopter; a claim whose owner pid is gone is reclaimed, so a
// crash cannot strand an app for the rest of the login.

interface RestoreClaim {
  instance: string
  pid: number
}

function restoreClaimPath(name: string): string {
  return GLib.build_filenamev([GLib.get_user_runtime_dir(), "tinshell", `restore-claim-${name}`])
}

/** This process's pid. gjs exposes no process.pid; /proc/self resolves to the
 *  calling process and needs no legacy `imports.system` (unavailable in ESM). */
function selfPid(): number {
  try {
    return Number(GLib.file_read_link("/proc/self")) || -1
  } catch {
    return -1
  }
}

/** True when `pid` names a live process. XDG_RUNTIME_DIR is per-login, so pid
 *  recycling inside one login is the only false positive. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  return GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS)
}

function readRestoreClaim(path: string): RestoreClaim | null {
  try {
    const bytes = GLib.file_get_contents(path)[1]
    if (!bytes) return null
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<RestoreClaim>
    return {
      instance: typeof parsed.instance === "string" ? parsed.instance : "",
      pid: typeof parsed.pid === "number" ? parsed.pid : -1,
    }
  } catch {
    // Missing or half-written (the writer died between create and write) —
    // the caller treats both as stale.
    return null
  }
}

/** Take the restore claim for `name`, atomically. False ⇒ another LIVE
 *  instance owns the app and this one must not restore it. An unusable claim
 *  path (unwritable runtime dir) grants the claim rather than blocking a
 *  restore: the claim is a duplicate guard, not a permission gate. */
function takeRestoreClaim(name: string): boolean {
  const dir = GLib.path_get_dirname(restoreClaimPath(name))
  ensureDir(dir, 0o700)
  const path = restoreClaimPath(name)
  const file = Gio.File.new_for_path(path)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = file.create(Gio.FileCreateFlags.NONE, null)
      stream.write_all(JSON.stringify({ instance: instanceName, pid: selfPid() }), null)
      stream.close(null)
      return true
    } catch (e) {
      const isExists = (e as { matches?: (a: unknown, b: unknown) => boolean })?.matches?.(
        Gio.IOErrorEnum,
        Gio.IOErrorEnum.EXISTS,
      )
      if (!isExists) {
        console.warn(
          `[lazy] restore claim for '${name}' unusable (${String(e)}) — restoring unclaimed`,
        )
        return true
      }
    }
    const held = readRestoreClaim(path)
    if (held && held.instance !== instanceName && pidAlive(held.pid)) return false
    try {
      file.delete(null)
    } catch {
      // Raced with the owner's own cleanup — the next attempt re-reads.
    }
  }
  return false
}

function releaseRestoreClaim(name: string): void {
  try {
    Gio.File.new_for_path(restoreClaimPath(name)).delete(null)
  } catch {
    // No claim held (or already reclaimed) — nothing to release.
  }
}

/** Restore the lazy apps that were running when the last process died (host
 *  restart or crash) in EVERY resident instance that lazy-registers apps:
 *  the production shell AND dev islands/combos that host lazy-not-in-set
 *  apps (a dock island restart must bring the user's note windows back the
 *  same way a shell restart does). Pure-lazy singleton islands register no
 *  lazy apps (apps map empty) → no-op: they spawn per request and open
 *  their own window via the entry `boot` hook. Crash-loop guard: an app
 *  whose load fails twice in a row is dropped from the set and never
 *  retried.
 *
 *  Candidates = this instance's persisted loaded set (its own per-owner
 *  file — apps loaded in THIS process at death) UNION every app whose own
 *  durable open-state signal fires (cfg.restoreIf — e.g. notes reads its
 *  state.json). The loaded set is best-effort memory across
 *  restarts within a login (XDG_RUNTIME_DIR); an app that records its open
 *  windows in a durable file must survive a missing/cleared loaded set.
 *  The durable-signal union is UNCONDITIONAL in the production shell (the
 *  single lazy host of shell mode) but in a resident
 *  island it fires ONLY when the island's own memory file does not exist:
 *  the notes session file is GLOBAL (not per-instance), so a present
 *  memory file — even an empty one — must stay authoritative, or EVERY
 *  resident island of a multi-island deployment would claim the same open
 *  note (duplicate windows, N writers on one .md). The absent-file
 *  backstop is what makes the first boot under per-owner memory (and a
 *  wiped XDG_RUNTIME_DIR) still restore instead of regressing to
 *  nothing-until-mod+n.
 *
 *  Call AFTER registerLazyApps (the lazy registry must exist for ensureLoaded
 *  to resolve an app). No-op when no candidate exists. */
export async function restoreLoadedApps(): Promise<void> {
  if (apps.size === 0) return
  const state = readLoadedState()
  // Loaded-set members first, then restoreIf apps (order only matters for the
  // error logs — every candidate is mounted independently).
  const candidates = new Set<string>()
  for (const n of state.loaded) if (isLazyApp(n)) candidates.add(n)
  if (isProductionShell || !state.fileExisted) {
    for (const [n, a] of apps) if (a.cfg.restoreIf?.()) candidates.add(n)
  }
  // A candidate whose claim another LIVE instance holds is already hosted
  // there — restoring it here mounts a second copy on the same durable
  // session data.
  const toRestore = [...candidates].filter((n) => takeRestoreClaim(n))
  if (toRestore.length === 0) return
  const failCounts = { ...state.failCounts }
  restoring = true
  try {
    for (const name of toRestore) {
      const ok = await ensureLoaded(name)
      if (ok) {
        delete failCounts[name]
      } else {
        // A failed load keeps no claim, so the next boot — here or in another
        // instance — is free to try again.
        releaseRestoreClaim(name)
        failCounts[name] = (failCounts[name] ?? 0) + 1
        if (failCounts[name] >= 2) state.loaded = state.loaded.filter((n) => n !== name)
      }
    }
  } finally {
    restoring = false
  }
  // Islands fold the now-loaded apps into their memory: a backstop restore
  // (memory absent) must seed the file so the NEXT restart restores from
  // memory, and a memory-listed app that failed its first strike stays
  // listed for the retry. The shell writes back the pre-restart set
  // (its always-on durable-signal
  // union makes the file content a fallback, not the source of truth).
  const finalLoaded = isProductionShell
    ? state.loaded
    : [...new Set([...state.loaded, ...loadedApps()])]
  // Island all-fail backstop: when the memory file was absent (so every
  // candidate came from the durable-signal backstop) and nothing is now
  // loaded, do NOT create an authoritative empty file — that would silently
  // stop the boot retry, unlike the shell which retries durable-signal apps
  // on every boot. Leaving the file absent keeps the next boot backstopping.
  if (!isProductionShell && !state.fileExisted && finalLoaded.length === 0) return
  writeLoadedState({ loaded: finalLoaded, failCounts })
}

// ── CSS: lazy apps carry their own provider so unload removes exactly it
//    (app.apply_css tracks providers privately and reset_css() nukes all). ──

/**
 * Apply an app's stylesheet through the ONE provider mechanism: one provider
 * per app name (a second call is a no-op), applied at
 * `STYLE_PROVIDER_PRIORITY_APPLICATION` and kept for the process lifetime —
 * see the cssProviders note above (a removal after the app's windows closed
 * triggers the GTK restyle storm). The lazy loader calls this on load; the
 * host entry calls it for a lazy member of ITS OWN set, which the loader never
 * sees (common/host/entry.ts — an in-set lazy member is mounted by the entry's
 * boot hook, not by the loader, and would otherwise boot with the shared theme
 * only). Both paths therefore apply identical CSS.
 */
export async function applyAppCss(name: string, css: string): Promise<void> {
  if (!css || cssProviders.has(name)) return
  await loadToolkit()
  const provider = applyCss(css)
  if (provider) cssProviders.set(name, provider)
}

function applyCss(css: string): Gtk.CssProvider | null {
  if (!gtk || !gdk) return null
  const display = gdk.Display.get_default()
  if (!display) return null
  const provider = new gtk.CssProvider()
  provider.load_from_string(css)
  gtk.StyleContext.add_provider_for_display(
    display,
    provider,
    gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
  )
  return provider
}

// NOTE: there is intentionally NO removeCss.
// Removing a lazy app's CSS provider after its windows closed triggers a GTK
// restyle storm (JS-heap OOM runaway — see the cssProviders note above).
// Providers are applied once and kept for the process lifetime.

// small helper for error logs (avoid a name→entry lookup loop)
const entryName = (e: LazyApp): string => [...apps.entries()].find(([, v]) => v === e)?.[0] ?? "?"
