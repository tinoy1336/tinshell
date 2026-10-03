/**
 * colour.probe — the config-colour parser (common/colour.ts).
 *
 * Every config-driven dynamic CSS block (files, notes, annotate, media) paints
 * through this conversion, and its failure mode is silent: a parsing change
 * does not throw, it paints the wrong colour or falls back to the scrim for a
 * value the user wrote. These checks pin the accepted shape, the channel
 * extraction, and the documented fallback that an unknown format takes.
 *
 * Run:  node --experimental-strip-types common/colour.probe.ts
 */
import { hexToRgba } from "./colour.ts"

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}

// ── the accepted shape: six hex digits, with or without the marker ──
check("a hash-prefixed colour converts", hexToRgba("#0a0c11", 0.9), "rgba(10, 12, 17, 0.9)")
check("a bare colour converts", hexToRgba("0a0c11", 0.9), "rgba(10, 12, 17, 0.9)")
check("the digits are case-insensitive", hexToRgba("#AABBCC", 1), "rgba(170, 187, 204, 1)")
check(
  "surrounding whitespace is trimmed",
  hexToRgba("  #ffffff  ", 0.5),
  "rgba(255, 255, 255, 0.5)",
)
check("black and white are the channel extremes", hexToRgba("#000000", 1), "rgba(0, 0, 0, 1)")
check("the alpha is passed through verbatim", hexToRgba("#123456", 0), "rgba(18, 52, 86, 0)")

// ── the documented fallback: an unknown format takes the dark card scrim ──
const SCRIM = "rgba(10, 12, 17, 0.25)"
check("a three-digit colour is not accepted", hexToRgba("#abc", 0.25), SCRIM)
check("eight digits (with alpha) are not accepted", hexToRgba("#11223344", 0.25), SCRIM)
check("a named colour is not accepted", hexToRgba("red", 0.25), SCRIM)
check("an empty string is not accepted", hexToRgba("", 0.25), SCRIM)
check("a non-hex digit is not accepted", hexToRgba("#12345g", 0.25), SCRIM)
check("the fallback keeps the requested alpha", hexToRgba("nope", 0.7), "rgba(10, 12, 17, 0.7)")

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`)
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`colour probe failed: ${failed.length} check(s)`)
