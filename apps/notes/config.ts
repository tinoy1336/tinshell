/**
 * notes config — thin re-export over the shared app-store facade
 * (common/config/app-store). Reads are direct property accesses on the live
 * `config` object — never cache, since `config set` mutates it in place.
 */
import { createAppStore } from "@common/config/app-store"

const app = createAppStore("notes")

/** Read a value by dotted path, e.g. get("appearance.fontSize"). No fallback
 *  param — config.defaults.json (merged by the loader) guarantees every
 *  known path exists; a code fallback just drifts from the defaults file
 *  (a stale fallback silently diverges from the defaults). */
export function get<T = any>(path: string): T {
  return app.get<T>(path)
}

/** The whole live config object (read-only access by convention). */
export function all(): any {
  return app.all()
}

/** Set a dotted-path value in the live config and persist it (schema-validated). */
export function set(path: string, value: any): void {
  app.set(path, value)
}

/** Re-read config.json + validate (atomic). */
export function reloadConfig(): Promise<void> {
  return app.reloadConfig()
}
