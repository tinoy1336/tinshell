/**
 * Emoji search — the query layer over the owned table (common/emoji/data.ts)
 * and recents store (common/emoji/recency.ts).
 *
 * Empty query → the recents strip (frecency-ordered, config recents.limit).
 * Non-empty query → ranked by the shared TIERED matcher (@common/text): the
 * match quality decides first (exact, prefix, word start, in-word, gated
 * subsequence), the name is weighted 10x over a keyword, the BEST keyword
 * counts rather than the keywords summing, and a keyword that IS the query
 * carries a large bonus. A leading/trailing ":" is stripped so a `:joy:`-style
 * query searches the same terms.
 *
 * The noise floor is a filter, not a ranking tiebreak (rank() already orders
 * by score) — gibberish that is not a subsequence of any name/keyword scores
 * 0 and never appears.
 */
import { fuzzyScore, rank } from "@common/text"
import { EMOJI, type EmojiEntry } from "./data"
import { recentGlyphs, topGlyphs } from "./recency"

/** A keyword that IS the query is worth more than one that merely contains it:
 *  the derived keyword set is what makes `phone` reach 📱 whose NAME never says
 *  "phone". */
const EXACT_KEYWORD_BONUS = 35000

/** Noise floor: short/partial subsequence hits below this never surface. It is
 *  an absolute cut on a score whose weights are hand-tuned (common/text), so a
 *  change to that scorer shifts it for every query — re-check the cut with the
 *  scorer, or move the cut to a rank position instead. */
const MIN_SCORE = 25

const BY_GLYPH = new Map<string, EmojiEntry>(EMOJI.map((e) => [e.glyph, e]))

/**
 * Name weighted 10x; the BEST keyword counts at base weight, plus the exact
 * bonus. Keyword scores are NOT summed: with a sum, an entry carrying several
 * loosely-related keywords outranked the entry whose NAME the user typed (📚
 * "books" lost to a row whose keywords each matched weakly), and that is the
 * class of ordering no emoji picker people like does.
 */
function scoreEntry(entry: EmojiEntry, q: string): number {
  const name = fuzzyScore(q, entry.name)
  let best = 0
  let exact = 0
  for (const k of entry.keywords) {
    if (k === q) exact = EXACT_KEYWORD_BONUS
    const s = fuzzyScore(q, k)
    if (s > best) best = s
  }
  return name * 10 + best + exact
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
