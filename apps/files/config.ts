/**
 * files config — thin re-export over the shared app-store facade
 * (common/config/app-store). Reads are direct property accesses on the live
 * `config` object — never cache, since `config set` mutates it in place.
 */
import { createAppStore } from "@common/config/app-store"

const app = createAppStore("files")

export const store = app.store

/** Read a value by dotted path (defaults file guarantees every path exists). */
export function get<T = any>(path: string): T {
  return app.get<T>(path)
}

/** The whole live config object (read-only access by convention). */
export function all(): any {
  return app.all()
}

/** Set a dotted-path value in the live config and persist it (schema-validated). */
export function set(path: string, value: any): { ok: boolean; error?: string } {
  return app.set(path, value)
}

/** Re-read config.json + validate (atomic). */
export function reloadConfig(): Promise<void> {
  return app.reloadConfig()
}
