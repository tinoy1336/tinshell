/**
 * Subsequence fuzzy matcher with scoring — the ONE matcher shared by every
 * app that ranks text (launcher apps + bangs + its emoji mode).
 *
 * Rewards prefix matches, contiguous runs, and early/word-boundary character
 * hits. Higher score = better match; <=0 means no match.
 *
 * Per-field weighting is applied by the caller: a name hit is worth ~10x a
 * description hit.
 *
 * The bonus weights are hand-tuned against the surfaces' own rows rather than
 * against a corpus, and the penalty below applies only on the subsequence path
 * — an exact substring scores on its position alone, so the fast path is a
 * strong signal at any text length. Cost is O(text × query) per item plus the
 * sort in `rank`. Upgrade path if the order stops looking right: score a
 * labelled query set and re-tune the weights, or replace the scorer behind
 * `rank`'s callback without touching a caller.
 *
 * Pure module (no gi:// imports) so it is also usable from a plain-Node
 * harness (`common/text.probe.ts`).
 */

/**
 * Score `text` against `query` (case-insensitive subsequence). Returns 0 when
 * query is not a subsequence of text, or a positive score otherwise.
 *
 * The score is TIERED (see TIER_* below), because the picker's feel comes from
 * the kind of match, not from arithmetic on its position: the entry the query
 * names outranks the entry that merely contains it at a word start, which
 * outranks one that contains it mid-word, which outranks one that only spells
 * the query out as a subsequence. Within a tier, an earlier match and a shorter
 * text rank higher.
 *
 * CONTIGUITY GATE: a subsequence is a match only when its characters are
 * mostly contiguous AND it starts where a word starts. Without it any short
 * query is a subsequence of a large share of the corpus — `book` matches
 * "bottle with popping cork" (its `oo` run lives inside "popping"), `lamp`
 * matches flags (its `la` run lives inside "flag"), `laugh` matches "leftwards
 * pushing hand" — and those hits score high enough to crowd the entries the
 * query actually names. A real fuzzy match is mostly contiguous with a gap or
 * two (`smil`+`e` against "smiling face" keeps a four-character run) and it
 * begins at a word boundary; a one- or two-character query is exempt from the
 * run rule, because any abbreviation that short is one run by construction.
 */
/**
 * Match-quality tiers. A whole-text match beats a prefix, a prefix beats a
 * match at a word start, a word start beats one inside a word, and anything
 * with the query as a literal substring beats a subsequence spelling it out.
 * The gaps between tiers are large enough that position and length can only
 * reorder WITHIN a tier.
 */
const TIER_EXACT = 4000
const TIER_PREFIX = 3000
const TIER_WORD = 2200
const TIER_INSIDE = 1200
const TIER_FUZZY = 500

export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!t.includes(q[0])) return 0

  // ── Tiered scoring ──
  // The tiers are what make a picker feel right: the entry the query NAMES
  // outranks the entry it merely contains, which outranks the one it merely
  // spells out as a subsequence. Each tier is separated by far more than the
  // within-tier variations (position and length), so no amount of position luck
  // lifts a weaker KIND of match over a stronger one.
  const lengthPenalty = Math.min(200, Math.max(0, t.length - q.length) * 2)

  if (t === q) return TIER_EXACT

  const idx = t.indexOf(q)
  if (idx >= 0) {
    if (idx === 0) return TIER_PREFIX - lengthPenalty
    if (/[\s\-_.:/(]/.test(t[idx - 1])) return TIER_WORD - lengthPenalty - Math.min(100, idx)
    return TIER_INSIDE - lengthPenalty - Math.min(100, idx)
  }

  // Subsequence walk — only for abbreviations and typos, and only past the
  // contiguity gate below.
  let score = 0
  let qi = 0
  let prevMatchIdx = -2 // tracks contiguity
  let runLen = 0
  let bestRun = 0
  let firstMatchIdx = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstMatchIdx < 0) firstMatchIdx = ti
      // prefix bonus
      if (qi === 0 && ti === 0) score += 100
      // word-boundary bonus (previous char is separator)
      if (ti > 0 && /[\s\-_.]/.test(t[ti - 1])) score += 15
      // contiguity bonus
      if (ti === prevMatchIdx + 1) {
        runLen++
        score += 10 + runLen * 4
      } else {
        runLen = 1
        score += 5
      }
      if (runLen > bestRun) bestRun = runLen
      // early-match bonus: earlier chars are worth more
      score += Math.max(0, 8 - ti)
      prevMatchIdx = ti
      qi++
    }
  }
  if (qi < q.length) return 0 // not a full subsequence
  // Contiguity gate (see the header): a word-start anchor, and — for a query
  // long enough for the question to mean anything — a run of more than half.
  if (firstMatchIdx > 0 && !/[\s\-_.:/]/.test(t[firstMatchIdx - 1])) return 0
  if (q.length >= 3 && bestRun * 2 <= q.length) return 0
  // penalty for length difference (prefer terse matches), then the tier floor
  // keeps every subsequence hit UNDER a real substring match
  score -= Math.max(0, t.length - q.length) * 0.5
  return Math.min(TIER_FUZZY, Math.max(1, Math.round(score)))
}

interface Scored<T> {
  item: T
  score: number
}

/** Filter + rank `items` by `scoreOf`, descending. Drops non-matches (<=0). */
export function rank<T>(items: T[], scoreOf: (item: T) => number): Scored<T>[] {
  const out: Scored<T>[] = []
  for (const item of items) {
    const s = scoreOf(item)
    if (s > 0) out.push({ item, score: s })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}
