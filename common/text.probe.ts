/**
 * text.probe — the shared fuzzy matcher's ordering promises
 * (common/text.ts).
 *
 * The matcher ranks every launcher app row, bang row and emoji row, so a
 * change to a bonus or a penalty reorders what the user sees first with no
 * error anywhere. These checks pin the ORDER relations the doc comment
 * states — a prefix beats a word-boundary hit, a contiguous run beats a
 * scattered one, a terse match beats a long one, an earlier hit beats a later
 * one — plus the two hard edges: no match is 0, and every score is a whole
 * number (the sort compares them directly).
 *
 * Run:  node --experimental-strip-types common/text.probe.ts
 */
import { fuzzyScore, rank } from "./text.ts"

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}

// ── the hard edges ──
check("empty query matches nothing", fuzzyScore("", "anything"), 0)
check("a non-subsequence scores 0", fuzzyScore("zzz", "abc"), 0)
check("a partial subsequence scores 0", fuzzyScore("abcd", "abc"), 0)
check("every score is a whole number", Number.isInteger(fuzzyScore("ab", "axbxc")), true)
check("no score is negative", fuzzyScore("zz", "abcdefghij") >= 0, true)

// ── ordering: what the doc comment promises ──
check("prefix beats a word-boundary hit", fuzzyScore("x", "xray") > fuzzyScore("x", "my x"), true)
check(
  "word-boundary hit beats a mid-word hit",
  fuzzyScore("b", "a-b") > fuzzyScore("b", "amb"),
  true,
)
check(
  "an exact substring beats a scattered subsequence",
  fuzzyScore("ab", "abzz") > fuzzyScore("ab", "azbz"),
  true,
)
check(
  "a contiguous run beats a gapped one",
  fuzzyScore("bc", "abcd") > fuzzyScore("bd", "abcd"),
  true,
)
check(
  "a terse match beats a long one",
  fuzzyScore("ab", "axb") > fuzzyScore("ab", `axb${"z".repeat(50)}`),
  true,
)
check("an early hit beats a late one", fuzzyScore("ab", "ab") > fuzzyScore("ab", "zab"), true)
check("matching is case-insensitive", fuzzyScore("FIRE", "firefox"), fuzzyScore("fire", "firefox"))
check(
  "matching is case-insensitive on the text side",
  fuzzyScore("fire", "FireFox"),
  fuzzyScore("fire", "firefox"),
)

// ── rank: filters and orders ──
const ranked = rank(["zzz", "files", "abc"], (t) => fuzzyScore("fil", t))
check("rank drops non-matches", ranked.length, 1)
check("rank keeps the matching row", ranked[0].item, "files")
const ordered = rank(["axbzzzz", "axb"], (t) => fuzzyScore("ab", t))
check("rank puts the better score first", ordered[0].item, "axb")
check("rank is descending", ordered[0].score > ordered[1].score, true)
check("rank of nothing matching is empty", rank(["abc"], (t) => fuzzyScore("qqqq", t)).length, 0)

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`)
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`text probe failed: ${failed.length} check(s)`)
