/**
 * annotate config — thin re-export over the shared app-store facade
 * (common/config/app-store). Tiers: appearance and window are restart (the
 * dynamic CSS block is assembled at startup); tools and export are live
 * (line width, font size, colours, copy-to-clipboard are read at use time).
 */
import { createAppStore } from "@common/config/app-store"

const app = createAppStore("annotate")

/** Read a value by dotted path, e.g. get("tools.lineWidth"). */
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

/** Set a dotted-path value in the live config WITHOUT persisting it: a surface
 *  applies an in-progress interaction live and persists the settled value with
 *  `set` once the interaction ends. */
export function applyLive(path: string, value: any): void {
  app.store.setLive(path, value)
}

/** Re-read config.json + validate (atomic). */
export function reloadConfig(): Promise<void> {
  return app.reloadConfig()
}
