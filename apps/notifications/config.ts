/**
 * Notifications config — the notifications app's OWN store
 * (apps/notifications/config.{defaults,schema,json}).
 *
 * This module owns its config store (createConfigStore — no shared surface
 * registry). Exposes the app's API surface (`get`, `set`, `reloadConfig()`,
 * `store`). Reads are always direct property accesses on the live config
 * object — never cache, since `config set` mutates it in place.
 */
import {
  appConfigPath,
  appSchemaDir,
  type ConfigStore,
  createConfigStore,
} from "@common/config/loader"

/** The store (onConfigChanged fires only on notifications changes). */
export const store: ConfigStore = createConfigStore(
  appSchemaDir("notifications"),
  appConfigPath("notifications"),
)

/** Read a value by dotted path, e.g. get("popup.timeout", 10). */
export function get<T = any>(path: string, fallback?: T): T {
  const v = store.get(path)
  return (v === undefined ? fallback : v) as T
}

/**
 * Set a dotted-path value in the live config and persist it. Validates the
 * value against the schema; on rejection returns {ok:false,error}. Persists
 * the WHOLE merged config.json.
 */
export function set(path: string, value: any): { ok: boolean; error?: string } {
  return store.set(path, value)
}

/** Re-read config.json + validate (atomic). */
export function reloadConfig(): Promise<void> {
  return store.reload().then((r) => {
    if (!r.ok) console.warn(`config reload failed: ${r.error}`)
  })
}
