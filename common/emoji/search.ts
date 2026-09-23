/**
 * Emoji search — the query layer over the owned table (common/emoji/data.ts)
 * and recents store (common/emoji/recency.ts).
 *
 * Empty query → the recents strip (frecency-ordered, config recents.limit).
 * Non-empty query → name weighted 10x, keywords summed, ranked by the shared
 * subsequence matcher (@common/text). A leading/trailing ":" is
 * stripped so a `:joy:`-style query searches the same terms.
 *
 * The noise floor is a filter, not a ranking tiebreak (rank() already orders
 * by score) — gibberish that is not a subsequence of any name/keyword scores
 * 0 and never appears.
 */
import { fuzzyScore, rank } from "@common/text"
import { EMOJI, type EmojiEntry } from "./data"
import { recentGlyphs, topGlyphs } from "./recency"

/** Noise floor: short/partial subsequence hits below this never surface. */
const MIN_SCORE = 25

const BY_GLYPH = new Map<string, EmojiEntry>(EMOJI.map((e) => [e.glyph, e]))

/** Name weighted 10x; keywords summed at base weight. */
function scoreEntry(entry: EmojiEntry, q: string): number {
  const name = fuzzyScore(q, entry.name)
  let kw = 0
  for (const k of entry.keywords) kw += fuzzyScore(q, k)
  return name * 10 + kw
}

/** Rank the table for `q`, best-first, capped at `limit`. */
export function searchEntries(q: string, limit: number): EmojiEntry[] {
  const query = q.trim().replace(/^:+|:+$/g, "")
  if (!query) return []
  return rank(EMOJI, (e) => scoreEntry(e, query))
    .filter((r) => r.score >= MIN_SCORE)
    .slice(0, Math.max(1, limit))
    .map((r) => r.item)
}

/** The recency strip — most-recently-used first, resolved to table entries. */
export function recentEntries(limit: number): EmojiEntry[] {
  return recentGlyphs(limit)
    .map((glyph) => BY_GLYPH.get(glyph))
    .filter((e): e is EmojiEntry => !!e)
}

/** Frecency-ordered strip (used by `launcher emoji-debug` / future
 *  ranking); empty until the store has recorded usage. */
export function topEntries(limit: number): EmojiEntry[] {
  return topGlyphs(limit)
    .map((glyph) => BY_GLYPH.get(glyph))
    .filter((e): e is EmojiEntry => !!e)
}

/** Resolve a glyph to its table entry (debug/introspection). */
export function entryFor(glyph: string): EmojiEntry | undefined {
  return BY_GLYPH.get(glyph)
}

/** Table size (debug). */
export function tableSize(): number {
  return EMOJI.length
}
