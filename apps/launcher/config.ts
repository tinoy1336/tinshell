/**
 * Launcher config — the launcher's OWN store
 * (apps/launcher/config.{defaults,schema,json}).
 *
 * This module owns its config store (createConfigStore — no shared surface
 * registry). Exposes the app's API (`get(path, fallback?)`,
 * `set(path, value)`, `reloadConfig()`). Reads are always direct property
 * accesses on the live config object — never cache, since `config set` mutates
 * it in place.
 */
import { appConfigPath, appSchemaDir, createConfigStore } from "@common/config/loader"

const launcher = createConfigStore(appSchemaDir("launcher"), appConfigPath("launcher"))

/** Read a value by dotted path, e.g. get("calc.debounceMs", 150). */
export function get<T = any>(path: string, fallback?: T): T {
  const v = launcher.get(path)
  return (v === undefined ? fallback : v) as T
}

/**
 * Set a dotted-path value in the live config and persist it. Validates the
 * value against the schema; on rejection returns {ok:false,error} (the
 * `config set` request handler replies "error: …"), on success void.
 * Persists the WHOLE merged config.json.
 */
export function set(path: string, value: any): { ok: boolean; error?: string } {
  return launcher.set(path, value)
}

/** Re-read config.json + validate (atomic). */
export function reloadConfig(): Promise<void> {
  return launcher.reload().then((r) => {
    if (!r.ok) console.warn(`config reload failed: ${r.error}`)
  })
}
