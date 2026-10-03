/**
 * Keyboard config — the keyboard app's OWN store
 * (apps/keyboard/config.{defaults,schema,json}), same shape as launcher's.
 *
 * The keyboard is merged into the shell process (io.Astal.shell), gated
 * behind keyboard.enabled (startup-read only). This module owns its config
 * store (createConfigStore — no shared surface registry) and exports the app's
 * API surface (`get`, `set`, `reload()`, `all()`, `store`, `config`) plus
 * `keyboardEnabled()` (the cross-app startup gate the dock's Keyboard applet
 * reads — import it from here as `@apps/keyboard/config`, never a shared
 * registry). Reads are always direct property accesses on the live config
 * object — never cache (config set mutates it in place).
 */
import {
  appConfigPath,
  appSchemaDir,
  type ConfigStore,
  createConfigStore,
} from "@common/config/loader"

const keyboard = createConfigStore(appSchemaDir("keyboard"), appConfigPath("keyboard"))

/** The store (onConfigChanged fires only on keyboard changes). */
export const store: ConfigStore = keyboard

/** The live keyboard config (the store's stable mirror; read directly). */
export const config = keyboard.config

/** Startup-read-only gate: keyboard.enabled (restart to apply). */
export function keyboardEnabled(): boolean {
  return config.enabled === true
}

/** Read a value by dotted path, e.g. get("repeat.delayMs", 400). */
export function get<T = any>(path: string, fallback?: T): T {
  const v = keyboard.get(path)
  return (v === undefined ? fallback : v) as T
}

/**
 * Set a dotted-path value in the live config and persist it. Validates
 * against the schema; on rejection returns {ok:false,error}. Persists the
 * WHOLE merged config.json.
 */
export function set(path: string, value: any): { ok: boolean; error?: string } {
  return keyboard.set(path, value)
}

export type ShowMode = "auto" | "show" | "hide"

/** The keyboard's show policy: auto (tablet-driven), show (always), hide (never). */
export function getShowMode(): ShowMode {
  const m = config.showMode as ShowMode | undefined
  return m === "show" || m === "hide" ? m : "auto"
}

/** Set + persist the show policy (validates against the schema). */
export function setShowMode(m: ShowMode): void {
  set("showMode", m)
}

/** The whole live config object (read-only access by convention). */
export function all(): any {
  return keyboard.all()
}

/** Re-read config.json + validate (atomic). */
export function reloadConfig(): Promise<void> {
  return keyboard.reload().then((r) => {
    if (!r.ok) console.warn(`config reload failed: ${r.error}`)
  })
}
