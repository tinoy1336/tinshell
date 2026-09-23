/**
 * portal config — thin re-export over the shared app-store facade
 * (common/config/app-store). Only `get` is consumed (window.tsx, mount.ts) —
 * the unused facade surface is not re-exported here.
 */
import { createAppStore } from "@common/config/app-store"

const app = createAppStore("portal")

/** Read a value by dotted path, e.g. get("window.defaultWidth"). No fallback
 *  param — config.defaults.json (merged by the loader) guarantees every
 *  known path exists. */
export function get<T = any>(path: string): T {
  return app.get<T>(path)
}
