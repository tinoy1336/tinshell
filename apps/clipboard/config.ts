/**
 * Clipboard config — the clipboard app's OWN store
 * (apps/clipboard/config.{defaults,schema,json}).
 *
 * This module owns its config store (createConfigStore — no shared surface
 * registry). Exposes the app's API (`get(path, fallback?)`,
 * `set(path, value)`, `reloadConfig()`) plus the live `config` mirror (the
 * capture loop's startup gate reads `config.capture`). Reads are always direct
 * property accesses on the live config object — never cache, since
 * `config set` mutates it in place.
 */
import { appConfigPath, appSchemaDir, createConfigStore } from "@common/config/loader"

const clipboard = createConfigStore(appSchemaDir("clipboard"), appConfigPath("clipboard"))

/** The live clipboard config (stable mirror; read directly). */
export const config = clipboard.config

/** Read a value by dotted path, e.g. get("maxEntries", 100). */
export function get<T = any>(path: string, fallback?: T): T {
  const v = clipboard.get(path)
  return (v === undefined ? fallback : v) as T
}

/**
 * Set a dotted-path value in the live config and persist it. Validates the
 * value against the schema; on rejection returns {ok:false,error}. Persists
 * the WHOLE merged config.json.
 */
export function set(path: string, value: any): { ok: boolean; error?: string } {
  return clipboard.set(path, value)
}

/** Re-read config.json + validate (atomic). */
export function reloadConfig(): Promise<void> {
  return clipboard.reload().then((r) => {
    if (!r.ok) console.warn(`config reload failed: ${r.error}`)
  })
}
