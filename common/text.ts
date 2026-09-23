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
 * Pure module (no gi:// imports) so it is also usable from a plain-Node
 * harness.
 */

/**
 * Score `text` against `query` (case-insensitive subsequence). Returns 0 when
 * query is not a subsequence of text, or a positive score otherwise. Bonuses:
 *  - prefix (query at text start): +100
 *  - contiguous matched run: per-char increasing bonus
 *  - word-boundary start (after space/sep): +15
 *  - earlier matches score higher than late ones
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!t.includes(q[0])) return 0

  // Fast path: exact substring (after case-fold) — strong signal.
  if (t.includes(q)) {
    const idx = t.indexOf(q)
    return 200 - idx + (idx === 0 ? 100 : 0) + (idx > 0 && /[\s\-_.]/.test(t[idx - 1]) ? 30 : 0)
  }

  // Subsequence walk.
  let score = 0
  let qi = 0
  let prevMatchIdx = -2 // tracks contiguity
  let runLen = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // prefix bonus
      if (qi === 0 && ti === 0) score += 100
      // word-boundary bonus (previous char is separator)
      if (ti > 0 && /[\s\-_.]/.test(t[ti - 1])) score += 15
      // contiguity bonus
      if (ti === prevMatchIdx + 1) {
        runLen++
        score += 10 + runLen * 4
      } else {
        runLen = 0
        score += 5
      }
      // early-match bonus: earlier chars are worth more
      score += Math.max(0, 8 - ti)
      prevMatchIdx = ti
      qi++
    }
  }
  if (qi < q.length) return 0 // not a full subsequence
  // penalty for length difference (prefer terse matches)
  score -= Math.max(0, t.length - q.length) * 0.5
  return Math.max(0, Math.round(score))
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
