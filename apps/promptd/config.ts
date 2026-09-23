/**
 * promptd config — thin re-export over the shared app-store facade
 * (common/config/app-store; same shape as launcher/config.ts and dock config).
 */
import { createAppStore } from "@common/config/app-store"

const app = createAppStore("promptd")

/** Read a value by dotted path. */
export function get<T = any>(path: string, fallback?: T): T {
  return app.get<T>(path, fallback)
}

/** The whole live config object (read-only access by convention). */
export function all(): any {
  return app.all()
}

/** Set a dotted-path value, validated against the schema. */
export function set(path: string, value: any): { ok: boolean; error?: string } {
  return app.set(path, value)
}

/** Re-read config.json + validate (atomic). */
export function reloadConfig(): Promise<void> {
  return app.reloadConfig()
}
