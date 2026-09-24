/**
 * Schema-driven runtime config loader — the cross-app config system.
 *
 * Three files collaborate (all in the app's config dir):
 *   config.schema.json   — JSON Schema (draft-07 subset): types, enums,
 *                          structure, and a custom `x-tier` keyword
 *                          (live | baked | restart) telling the request
 *                          handler whether a key needs a redraw, a rebuild,
 *                          or a restart to take effect. GENERATED ARTIFACT:
 *                          authored as TypeBox in config.schema.ts and emitted
 *                          by scripts/gen-config-schemas.ts (npm run
 *                          gen:schemas) — never hand-edit the JSON.
 *   config.defaults.json — canonical defaults (recovery fallback).
 *   config.json          — the user's live, editable config.
 *
 * No defaults live in code. Everything is validated against the schema. Reload
 * and update are ATOMIC all-or-nothing: any invalid key rejects the whole
 * operation and the live config is left untouched (never a partial state). The
 * initial load stays lenient so a broken-but-mostly-working file still boots.
 *
 * Tiers (mechanism only — the RESPONSE is the app's job, via onConfigChanged):
 *   live     → redraw suffices (colours/fonts read per-frame).
 *   baked    → rebuild required (read once at window construction).
 *   restart  → poll intervals (persisted but only take effect on next run).
 *
 * This is a FACTORY: `createConfigStore(dir)` returns a store bound to that
 * app's config dir. Each app calls it once and exports the result. The typed
 * config shape is DERIVED app-side: per-app config.ts casts the `config`
 * object to the `Static` type of its TypeBox schema (config.schema.ts).
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { log } from "@common/log/logger"
import { treeRoot } from "@common/path/tree-root"

// ── Types ──

export type Tier = "live" | "baked" | "restart"

/** A draft-07-subset JSON Schema node. */
interface SchemaNode {
  type?: string
  enum?: any[]
  items?: SchemaNode
  minItems?: number
  maxItems?: number
  properties?: Record<string, SchemaNode>
  additionalProperties?: boolean | SchemaNode
  "x-tier"?: Tier
  [k: string]: any
}

type Schema = SchemaNode

interface ReloadResult {
  ok: boolean
  /** Present only when ok=false. */
  error?: string
  /** Validation errors. Non-empty ⇒ ok=false and the live config was NOT modified. */
  warnings: string[]
}

export interface ConfigStore {
  /** The live config object. Always read properties directly (do not cache). */
  config: any
  /** Dotted-path get. */
  get(path: string): any
  /** Dotted-path set on the live config (creates intermediates). Returns false
   *  if an intermediate resolves to a non-object. Does NOT validate or persist.
   *  Fires the change listeners when the value at the path actually differs:
   *  this is the ONE live-mutation primitive, so every set path built on it
   *  (the facade's `set`/`setLive`, app-store's `set`, and therefore every
   *  `<app> config set`) announces the change the same way `applyToLive` does. */
  setLive(path: string, value: any): boolean
  /** Validate a single {path, value} pair. null on success, error string otherwise. */
  checkType(path: string, value: any): string | null
  /** Validate a batch. ok=true iff every path is known AND every value passes. */
  validateBatch(pairs: { path: string; value: any }[]): { ok: boolean; errors: string[] }
  /** Tier for a dotted path (falls back to nearest ancestor's x-tier, then "live"). */
  tierOf(path: string): Tier
  /** Replace the live config's contents in place + fire change listeners. */
  applyToLive(clone: any): void
  /** Register a change listener; returns an unsubscribe. */
  onConfigChanged(cb: () => void): () => void
  /** Deep clone of the canonical defaults. */
  getDefaults(): any
  /** Atomic full-file re-read + validate. */
  reload(): Promise<ReloadResult>
  /** Queue a serialized config.json write of `source`. */
  queueWrite(source: any): Promise<boolean>
}

// ── Schema (draft-07 subset) validator ──

function typeMatches(type: string, v: any): boolean {
  switch (type) {
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v)
    case "array":
      return Array.isArray(v)
    case "string":
      return typeof v === "string"
    case "integer":
      return typeof v === "number" && Number.isInteger(v)
    case "number":
      return typeof v === "number"
    case "boolean":
      return typeof v === "boolean"
    case "null":
      return v === null
    default:
      return true
  }
}

function validate(node: SchemaNode, v: any, path: string): string | null {
  if (node.type && !typeMatches(node.type, v)) {
    return `${path}: expected ${node.type}, got ${Array.isArray(v) ? "array" : v === null ? "null" : typeof v}`
  }
  if (node.enum && !node.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
    return `${path}: value ${JSON.stringify(v)} not in enum [${node.enum.map((e) => JSON.stringify(e)).join(", ")}]`
  }
  if (typeof v === "number" && !Array.isArray(v)) {
    if (node.minimum !== undefined && v < node.minimum) {
      return `${path}: expected >= ${node.minimum}, got ${v}`
    }
    if (node.maximum !== undefined && v > node.maximum) {
      return `${path}: expected <= ${node.maximum}, got ${v}`
    }
  }
  if (typeof v === "string") {
    if (node.minLength !== undefined && v.length < node.minLength) {
      return `${path}: expected length >= ${node.minLength}, got ${v.length}`
    }
    if (node.maxLength !== undefined && v.length > node.maxLength) {
      return `${path}: expected length <= ${node.maxLength}, got ${v.length}`
    }
  }
  if (Array.isArray(v)) {
    if (node.minItems !== undefined && v.length < node.minItems) {
      return `${path}: expected at least ${node.minItems} items, got ${v.length}`
    }
    if (node.maxItems !== undefined && v.length > node.maxItems) {
      return `${path}: expected at most ${node.maxItems} items, got ${v.length}`
    }
  }
  if (node.type === "array" && node.items && Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const err = validate(node.items, v[i], `${path}[${i}]`)
      if (err) return err
    }
  }
  if (node.type === "object" && v !== null && typeof v === "object" && !Array.isArray(v)) {
    const props = node.properties ?? {}
    for (const key of Object.keys(v)) {
      const childSchema = props[key]
      if (childSchema === undefined) {
        if (node.additionalProperties === false) {
          return `${path}.${key}: additional property not allowed`
        }
        continue
      }
      const err = validate(childSchema, v[key], `${path}.${key}`)
      if (err) return err
    }
  }
  return null
}

/** Walk schema + parsed object in parallel, collecting EVERY error. Pure validation. */
function collectErrors(userVal: any, node: SchemaNode, path: string, errors: string[]): void {
  if (
    node.type === "object" &&
    userVal !== null &&
    typeof userVal === "object" &&
    !Array.isArray(userVal)
  ) {
    const props = node.properties ?? {}
    for (const key of Object.keys(userVal)) {
      const childSchema = props[key]
      const childPath = path ? `${path}.${key}` : key
      if (childSchema === undefined) {
        if (node.additionalProperties === false) {
          errors.push(`${childPath}: unknown property`)
        }
        continue
      }
      collectErrors(userVal[key], childSchema, childPath, errors)
    }
    return
  }
  const err = validate(node, userVal, path)
  if (err) errors.push(err)
}

// ── Async file I/O (GTK main-loop-safe) ──

function readFileAsync(path: string): Promise<{ ok: boolean; contents: string }> {
  return new Promise((resolve) => {
    const file = Gio.File.new_for_path(path)
    file.load_contents_async(null, (_f: any, res: any) => {
      try {
        const [ok, contents] = file.load_contents_finish(res)
        if (!ok) return resolve({ ok: false, contents: "" })
        resolve({ ok: true, contents: new TextDecoder().decode(contents as Uint8Array) })
      } catch (_) {
        resolve({ ok: false, contents: "" })
      }
    })
  })
}

function writeFileAsync(path: string, data: string): Promise<boolean> {
  return new Promise((resolve) => {
    const file = Gio.File.new_for_path(path)
    const bytes = new TextEncoder().encode(data)
    file.replace_contents_async(
      bytes,
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null,
      (_f: any, res: any) => {
        try {
          file.replace_contents_finish(res)
          resolve(true)
        } catch (e) {
          log(`config write failed ${path}: ${e}`)
          resolve(false)
        }
      },
    )
  })
}

// ── Helpers ──

function parseJSONFile(path: string): any | undefined {
  try {
    const [ok, contents] = GLib.file_get_contents(path)
    if (!ok || !contents) return undefined // missing file → undefined (not an error)
    // SAFETY: GLib.file_get_contents returns a Uint8Array view; decoding it as an ArrayBuffer
    // is the standard gjs read idiom (TextDecoder accepts any buffer-like). The bytes are
    // valid UTF-8 JSON from the config file.
    return JSON.parse(new TextDecoder().decode(contents as unknown as ArrayBuffer))
  } catch (e) {
    // A missing file throws GLib.FileError in gjs — that's the normal first-run
    // case (live config absent → defaults used), not a real error. Only log
    // parse failures (the file exists but is broken JSON).
    const msg = String(e)
    if (/No such file|Failed to open file|FILE_ERROR/.test(msg)) return undefined
    log(`[config] failed to parse ${path}: ${e}`)
    return undefined
  }
}

function deepMerge(target: any, source: any): void {
  for (const key of Object.keys(source)) {
    const sv = source[key]
    if (sv === null || sv === undefined) continue
    if (sv !== null && typeof sv === "object" && !Array.isArray(sv)) {
      if (typeof target[key] !== "object" || target[key] === null || Array.isArray(target[key])) {
        target[key] = {}
      }
      deepMerge(target[key], sv)
    } else {
      target[key] = sv
    }
  }
}

function deepClone(obj: any): any {
  try {
    return JSON.parse(JSON.stringify(obj))
  } catch (e) {
    // config objects are plain JSON (no cycles); only a bug trips this.
    log(`deepClone failed: ${e}`)
    return {}
  }
}

/** Structural equality over the JSON values a config holds. A set to the value
 *  already there is not a change, so it must not announce one. */
function sameValue(a: any, b: any): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!sameValue(a[k], b[k])) return false
  }
  return true
}

/**
 * Set a dotted path on ANY config object — the live tree or a detached copy a
 * write path is staging — creating the intermediate objects the path names.
 * Returns false when an intermediate already resolves to something that is not
 * an object (a primitive or an array): the caller rejects that pair instead of
 * silently replacing the subtree.
 */
export function setDottedPath(root: any, path: string, value: any): boolean {
  const parts = path.split(".")
  let cur: any = root
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (cur[p] === null || cur[p] === undefined) {
      cur[p] = {}
    } else if (typeof cur[p] !== "object" || Array.isArray(cur[p])) {
      return false
    }
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = value
  return true
}

// ── Factory ──

/** App schema dir: <tree>/apps/<name> — holds config.schema.json and
 *  config.defaults.json. The tree root comes from the launcher (TINSHELL_HOME,
 *  exported by the host scripts); when it is unset, `common/path/tree-root`'
 *  fallback resolves the same value it always has. */
export function appSchemaDir(name: string): string {
  return GLib.build_filenamev([treeRoot(), "apps", name])
}

/** This machine's live config file: ~/.config/tinshell/<name>.json — flat, one
 *  file per app. It lives OUTSIDE the tree: the values are the machine's, the
 *  schema and defaults are the project's. */
export function appConfigPath(name: string): string {
  return GLib.build_filenamev([GLib.get_user_config_dir(), "tinshell", `${name}.json`])
}

/** The live file's parent must exist before the first write. */
function ensureParentFile(path: string): void {
  const dir = GLib.path_get_dirname(path)
  if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) GLib.mkdir_with_parents(dir, 0o755)
}

/** `dir` supplies schema + defaults; `livePath` (default `<dir>/config.json`)
 *  is the file written. The deployed greeter passes one directory and keeps the
 *  single-dir form; every session app passes appSchemaDir + appConfigPath. */
export function createConfigStore(dir: string, livePath?: string): ConfigStore {
  const CONFIG_PATH = livePath ?? GLib.build_filenamev([dir, "config.json"])
  const DEFAULTS_PATH = GLib.build_filenamev([dir, "config.defaults.json"])
  const SCHEMA_PATH = GLib.build_filenamev([dir, "config.schema.json"])

  const SCHEMA: Schema | undefined = parseJSONFile(SCHEMA_PATH)
  const DEFAULTS: any | undefined = parseJSONFile(DEFAULTS_PATH)

  if (!SCHEMA) log(`[config] WARNING: config.schema.json missing at ${SCHEMA_PATH}`)
  if (!DEFAULTS) log(`[config] WARNING: config.defaults.json missing at ${DEFAULTS_PATH}`)

  const _config: any = {}

  const listeners: (() => void)[] = []

  function notify(): void {
    for (const cb of listeners) cb()
  }

  function schemaAt(path: string): SchemaNode | undefined {
    if (!SCHEMA) return undefined
    let node: SchemaNode = SCHEMA
    for (const seg of path.split(".")) {
      if (!node.properties || !node.properties[seg]) return undefined
      node = node.properties[seg]
    }
    return node
  }

  function seedFromDefaults(): any {
    return DEFAULTS ? deepClone(DEFAULTS) : {}
  }

  function applyToLive(clone: any): void {
    for (const key of Object.keys(_config)) delete _config[key]
    Object.assign(_config, clone)
    notify()
  }

  function get(path: string): any {
    const parts = path.split(".")
    let cur: any = _config
    for (const p of parts) {
      if (cur === null || typeof cur !== "object") return undefined
      cur = cur[p]
    }
    return cur
  }

  function setLive(path: string, value: any): boolean {
    const before = get(path)
    if (!setDottedPath(_config, path, value)) return false
    if (!sameValue(before, value)) notify()
    return true
  }

  function checkType(path: string, value: any): string | null {
    const node = schemaAt(path)
    if (!node) return `${path}: unknown config path`
    return validate(node, value, path)
  }

  function validateBatch(pairs: { path: string; value: any }[]): { ok: boolean; errors: string[] } {
    const errors: string[] = []
    for (const { path, value } of pairs) {
      const err = checkType(path, value)
      if (err) errors.push(err)
    }
    return { ok: errors.length === 0, errors }
  }

  function tierOf(path: string): Tier {
    const parts = path.split(".")
    for (let i = parts.length; i > 0; i--) {
      const node = schemaAt(parts.slice(0, i).join("."))
      if (node?.["x-tier"]) return node["x-tier"]
    }
    return (SCHEMA?.["x-tier"] as Tier) ?? "live"
  }

  // Serialized write chain — an earlier in-flight write must never clobber a
  // later one (two changes within the async window would otherwise leave
  // config.json stale).
  let writeChain: Promise<boolean> = Promise.resolve(true)
  function queueWrite(source: any): Promise<boolean> {
    const p = writeChain.then(() => {
      ensureParentFile(CONFIG_PATH)
      return writeFileAsync(CONFIG_PATH, JSON.stringify(source, null, 2) + "\n")
    })
    // The chain arm keeps the chain alive on failure (a rejection here would
    // stall every later write); the failure itself is logged, not dropped.
    writeChain = p.then(
      () => true,
      (e) => {
        log(`config write chain failed: ${e}`)
        return true
      },
    )
    return p
  }

  async function reload(): Promise<ReloadResult> {
    const { ok: exists, contents } = await readFileAsync(CONFIG_PATH)
    if (!exists) {
      applyToLive(seedFromDefaults())
      return { ok: true, warnings: [] }
    }
    let parsed: any
    try {
      parsed = JSON.parse(contents)
    } catch (e) {
      return { ok: false, error: `config.json unparseable: ${e}`, warnings: [] }
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "config.json top-level must be an object", warnings: [] }
    }
    if (!SCHEMA) {
      const fresh = seedFromDefaults()
      deepMerge(fresh, parsed)
      applyToLive(fresh)
      return { ok: true, warnings: [] }
    }
    const errors: string[] = []
    collectErrors(parsed, SCHEMA, "", errors)
    if (errors.length) {
      return { ok: false, error: `${errors.length} validation error(s)`, warnings: errors }
    }
    const fresh = seedFromDefaults()
    deepMerge(fresh, parsed)
    applyToLive(fresh)
    return { ok: true, warnings: [] }
  }

  // Initial lenient load: defaults + merge live on top WITHOUT schema filtering
  // (extra keys in a hand-edited config.json are merged as-is). Subsequent
  // reloads DO validate. Keeping the first load lenient means a broken-but-mostly-
  // working file still boots.
  applyToLive(seedFromDefaults())
  const parsed = parseJSONFile(CONFIG_PATH)
  if (parsed) deepMerge(_config, parsed)

  return {
    config: _config,
    get,
    setLive,
    checkType,
    validateBatch,
    tierOf,
    applyToLive,
    onConfigChanged(cb) {
      listeners.push(cb)
      return () => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    getDefaults: () => deepClone(seedFromDefaults()),
    reload,
    queueWrite,
  }
}
