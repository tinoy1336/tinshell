/**
 * Emoji recency/frequency store — the SINGLE owner of emoji usage history.
 *
 * JSON at ~/.local/state/tinshell/apps/emoji/state.json, shape:
 *   { "version": 1, "emoji": { "<glyph>": { "count": n, "last": epochMs } } }
 *
 * Backed by the ONE shared state store (common/state.ts — versioned,
 * validated, sync atomic writes). Reads are cached after first load; the
 * caller wraps recordGlyph in try/catch so a store failure can never break an
 * activation.
 *
 * Consumer: the launcher's emoji mode (search.ts's recents strip + the glyph
 * grid's recordGlyph). This module keeps the ONLY access to that path — the
 * store id stays "emoji" so the user's existing history survives the
 * surface's move into the launcher (no second recents file).
 */
import { log } from "@common/log/logger"
import { createStateStore } from "@common/state"

interface RecencyEntry {
  count: number
  last: number
}
type RecencyMap = Record<string, RecencyEntry>

/** Default usage-map cap — callers pass `recents.max` from their own config
 *  (recency.ts is imported by the launcher via a re-export and must NOT pull
 *  the emoji config store into another process). */
const DEFAULT_CAP = 50

const store = createStateStore({
  app: "emoji",
  version: 1,
  keys: {
    emoji: (v): boolean => v !== null && typeof v === "object" && !Array.isArray(v),
  },
})

let cache: RecencyMap | null = null

/** Read the recency map once (missing/corrupt → {}). */
function loadRecency(): RecencyMap {
  if (cache) return cache
  const v = store.get("emoji")
  cache = v && typeof v === "object" && !Array.isArray(v) ? (v as RecencyMap) : {}
  return cache
}

/** Glyphs with the most recent `last` timestamp, most-recent first. */
export function recentGlyphs(limit: number): string[] {
  const map = loadRecency()
  return Object.entries(map)
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, Math.max(0, limit))
    .map(([glyph]) => glyph)
}

/**
 * Frecency ranking: `count` weighted against recency (a use today is worth a
 * small boost over the same count a week ago). Most-used-and-recent first.
 */
export function topGlyphs(limit: number): string[] {
  const map = loadRecency()
  const now = Date.now()
  const score = (e: RecencyEntry): number => {
    const ageDays = Math.max(0, now - e.last) / 86_400_000
    return e.count + 1 / (1 + ageDays)
  }
  return Object.entries(map)
    .sort((a, b) => score(b[1]) - score(a[1]))
    .slice(0, Math.max(0, limit))
    .map(([glyph]) => glyph)
}

/** Bump an activation: count+1, last=now, cap the map, persist via the store.
 *  `maxEntries` is the caller's configured cap (config `recents.max`); the
 *  oldest entries beyond it are dropped. */
export function recordGlyph(glyph: string, maxEntries: number = DEFAULT_CAP): void {
  try {
    const cap = Math.max(1, Math.floor(maxEntries))
    const map = loadRecency()
    const prev = map[glyph]
    map[glyph] = { count: (prev?.count ?? 0) + 1, last: Date.now() }
    // Cap: drop the oldest entries (by `last`) beyond the configured cap.
    const entries = Object.entries(map)
    if (entries.length > cap) {
      entries.sort((a, b) => b[1].last - a[1].last)
      const keep = new Set(entries.slice(0, cap).map(([g]) => g))
      for (const key of Object.keys(map)) {
        if (!keep.has(key)) delete map[key]
      }
    }
    store.set("emoji", map)
  } catch (e) {
    log(`emoji-recency: record failed: ${(e as Error).message}`)
  }
}
