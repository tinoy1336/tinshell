/**
 * media config — thin re-export over the shared app-store facade
 * (common/config/app-store). Rejections route to the media log sink.
 */
import { createAppStore } from "@common/config/app-store"
import { log } from "@common/log/logger"

const app = createAppStore("media", {
  onReject: (msg) => log(msg),
})

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

/**
 * Drop the config keys this app no longer declares (`appearance.rounding`,
 * `appearance.fontSize`, `appearance.iconSize`).
 *
 * The root schema is closed (`additionalProperties: false`), so a live
 * `media.json` that still carries one of them would make the next
 * `media config reload` refuse the whole file. Uses the primitives the app's
 * own config path already uses (`applyToLive` + the serialized write chain) and
 * is idempotent: a file with none of them is left untouched and nothing is
 * written.
 *
 * Called from `mountMedia`, the media app's own mount: no process that merely
 * reads something from this app writes its config.
 */
export function pruneRemovedKeys(): void {
  const live = app.all()
  const appearance = live?.appearance
  if (!appearance || typeof appearance !== "object") return
  const removed = ["rounding", "fontSize", "iconSize"].filter((key) => key in appearance)
  if (removed.length === 0) return
  const clone = JSON.parse(JSON.stringify(live))
  for (const key of removed) delete clone.appearance[key]
  store.applyToLive(clone)
  void store.queueWrite(clone)
}
