/**
 * common/state.ts — the ONE shared runtime-state store for every app:
 * the dock row's mode (apps/dock/dock-row.ts), the applet-setting stores in
 * `common/applets/domains/*` (charge limit, adapter power, auto profile, inhibit
 * intent), notes' session and the launcher's emoji recents
 * (common/emoji/recency.ts) all sit on this single
 * factory.
 * Canonical
 * location: ONE versioned `state.json` per app under the XDG state dir
 * (`~/.local/state/tinshell/apps/<app>/state.json`, via GLib.get_user_state_dir —
 * NOT the config dir: `~/.config` stays backup-worthy config, while a wipe of
 * `~/.local/state` loses
 * only re-derivable machine/UI intent).
 *
 * Store semantics per key:
 *   - The file MIRRORS the in-memory live state. Each app owns its keys; the
 *     file is rebuilt on every write from the live mirror.
 *   - Values persist as JSON. Every key has a validator; invalid values are
 *     rejected on set and dropped on load (never a partial/corrupt store).
 *   - Writes are SYNCHRONOUS and ATOMIC (GLib.file_set_contents writes a
 *     temp file then renames — the same primitive notes/clipboard/emoji
 *     use). Single-threaded gjs + a tiny file means ordering is
 *     guaranteed by the main loop; no async write chain is needed (the
 *     config loader's promise chain exists only because its IO is
 *     async — serialization is the point, sync writes serialize by
 *     construction). A write is either fully visible or not at all.
 *
 * Missing or unparseable state.json = empty mirror (nothing is adopted).
 *
 * Boot-restore probe: apps that record their open-window set durably (notes)
 * read this store's canonical file at host boot via `appStateFilePath(app)`
 * + a raw sync read — registry.ts must NOT import the app (lazy), so path
 * knowledge lives here, in ONE place.
 *
 * This is a FACTORY: each app calls `createStateStore` once with its own
 * schema. It deliberately does NOT live in common/config: that system is the
 * schema-driven user-config trio (defaults/schema/live, config dir); this is
 * versioned machine/UI state (state dir). Different taxonomy, different
 * lifecycle.
 */
import GLib from "gi://GLib"
import { bytesToUtf8 } from "@common/fs/bytes"
import { writeFileSync } from "@common/fs/files"

// ── Paths ──

/** App state dir: ~/.local/state/tinshell/apps/<app>. */
function appStateDir(app: string): string {
  return GLib.build_filenamev([GLib.get_user_state_dir(), "tinshell", "apps", app])
}

/** Canonical state file of an app (default state.json). Registry restoreIf
 *  predicates and debug surfaces use this so the path lives in ONE place. */
export function appStateFilePath(app: string, file = "state.json"): string {
  return GLib.build_filenamev([appStateDir(app), file])
}

// ── Types ──

interface StateStoreSchema<K extends string> {
  /** state.json format version (written into the file). */
  version: number
  /** File name inside the app state dir (default "state.json"). */
  file?: string
  /** Per-key validators. A key's value is stored only when it validates. */
  keys: Record<K, (v: unknown) => boolean>
}

interface StateStoreOptions<K extends string> extends StateStoreSchema<K> {
  /** App workspace name → dir ~/.local/state/tinshell/apps/<app>. */
  app: string
}

export interface StateStore<K extends string> {
  /** Absolute state file path. */
  path(): string
  /** Mirror value for `key` (undefined when unset or failed validation). */
  get<Key extends K>(key: Key): unknown
  /** True once the store has ANSWERED for `key` — its value, or its absence,
   *  is then definitive. A local store reads its file synchronously at
   *  construction; a store fed by a background fetch (the applet client's
   *  transport read) is NOT ready on a memo miss, and callers must treat that
   *  as "unknown" — never as "unset". */
  ready<Key extends K>(key: Key): boolean
  /** Validate + set mirror + persist synchronously. False on invalid value
   *  or write failure (mirror is NOT updated on failure). */
  set<Key extends K>(key: Key, value: unknown): boolean
  /** Re-read state.json into the mirror (mount-time freshness for apps whose
   *  module scope survives unload cycles, e.g. notes restore). Idempotent. */
  reload(): void
  /** Human-readable dump for debug commands. */
  dump(): string
}

// ── Sync file primitives (tiny files; the shared sync write is atomic) ──

function readFile(path: string): string | undefined {
  try {
    const [ok, contents] = GLib.file_get_contents(path)
    if (!ok || !contents) return undefined
    return bytesToUtf8(contents)
  } catch {
    // Missing/unreadable = "not present" (never a thrown error to callers).
    return undefined
  }
}

// ── Factory ──

export function createStateStore<K extends string>(opts: StateStoreOptions<K>): StateStore<K> {
  const { app, version, file = "state.json", keys } = opts
  const PATH = appStateFilePath(app, file)
  const keyNames = Object.keys(keys) as K[]

  const mirror: Partial<Record<K, unknown>> = {}

  function isValidKey(key: string): boolean {
    return key in keys
  }

  function adopt(key: string, value: unknown): void {
    if (!isValidKey(key)) return
    const validate = keys[key as K]
    if (validate(value)) mirror[key as K] = value
  }

  function payload(): string {
    const obj: Record<string, unknown> = { version }
    for (const key of keyNames) {
      if (mirror[key] !== undefined) obj[key] = mirror[key]
    }
    return `${JSON.stringify(obj, null, 2)}\n`
  }

  function write(): boolean {
    const ok = writeFileSync(PATH, payload())
    if (!ok) print(`[state] write failed for ${app} — mirror kept in memory`)
    return ok
  }

  /** Load state.json into the mirror (per-key validation drops anything
   *  invalid). Missing or unparseable file = empty mirror. */
  function load(): void {
    for (const key of keyNames) delete mirror[key]
    const raw = readFile(PATH)
    if (raw === undefined) return
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const key of keyNames) adopt(key, parsed[key])
      } else {
        print(`[state] ${PATH} not an object — empty mirror`)
      }
    } catch (e) {
      print(`[state] ${PATH} unparseable, empty mirror: ${e}`)
    }
  }

  load()

  return {
    path: () => PATH,
    get: (key: K) => mirror[key],
    // The file is read synchronously in load(), so every key is answered by the
    // time a caller can ask.
    ready: () => true,
    set(key: K, value: unknown): boolean {
      if (!isValidKey(key)) {
        print(`[state:${app}] rejected unknown key ${String(key)}`)
        return false
      }
      const validate = keys[key]
      if (!validate(value)) {
        print(`[state:${app}] rejected invalid ${String(key)}=${JSON.stringify(value)}`)
        return false
      }
      mirror[key] = value
      return write()
    },
    reload: load,
    dump: () => {
      const lines = [`state.json: ${PATH}`, `version: ${version}`]
      for (const key of keyNames) {
        const v = mirror[key]
        lines.push(`${key}=${v === undefined ? "(unset)" : JSON.stringify(v)}`)
      }
      return lines.join("\n")
    },
  }
}
