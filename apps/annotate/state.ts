/**
 * annotate state — the persisted colour history behind the colour picker.
 *
 * One `common/state` store (app "annotate"), state file
 * `~/.local/state/tinshell/apps/annotate/state.json`: the ink colours the user has
 * actually used, most recent first, deduplicated and capped — the picker's ONE
 * list (there is no static palette row beside it). It lives on disk (NOT in a
 * module variable) so the list AND the colour a new window starts with survive
 * a window close, the shell's lazy unload grace (which resets module scope) and
 * a restart. While nothing was ever used the list is PRIMED with the configured
 * defaults (`tools.colours`, annotate's config), so a fresh state shows those
 * as its starting history instead of an empty picker.
 */
import { createStateStore } from "@common/state"
import { get as getConfig } from "./config"

/** How many colours the picker offers as one-click swatches — one row at the
 *  popover's inner width (6 × 20px chips + 5 × 4px gaps = 140). */
export const RECENT_COLOURS_MAX = 6

const store = createStateStore({
  app: "annotate",
  version: 1,
  keys: {
    colours: (v): boolean => Array.isArray(v) && v.every((c) => typeof c === "string"),
  },
})

/** Deduplicate (case-insensitively, keeping the first spelling) and cap: the
 *  list is both the picker's row and the file's content, and a colour repeated
 *  in the config palette must collapse rather than render twice. */
function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of list) {
    const key = c.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
    if (out.length === RECENT_COLOURS_MAX) break
  }
  return out
}

/** The configured default colours, deduplicated and capped — the SEED for an
 *  empty history. Other users of the config palette (the ink a new window
 *  starts with) read `tools.colours` directly. */
export function defaultColours(): string[] {
  return dedupe(getConfig("tools.colours"))
}

/** The picker's list: the colours actually used, most recent first. Read fresh
 *  from disk (the store's mirror is per process), so a state file cleared or
 *  replaced under a RUNNING app is noticed on the next read. Empty history
 *  (first run, or a cleared/removed state file) answers the configured
 *  defaults, which the next `rememberColour` then persists as real history. */
export function recentColours(): string[] {
  store.reload()
  const v = store.get("colours")
  const list = Array.isArray(v) ? (v as string[]) : []
  return list.length > 0 ? dedupe(list) : defaultColours()
}

/** Record a used colour as the most recent one: moved to the front, never
 *  duplicated (this is what keeps a SEEDED colour from appearing twice once it
 *  is chosen again) and capped at RECENT_COLOURS_MAX. A colour already at the
 *  front is a no-op, so merely re-using the current ink never rewrites the
 *  file. */
export function rememberColour(hex: string): void {
  const list = recentColours()
  if (list[0] === hex) return
  store.set("colours", dedupe([hex, ...list]))
}
