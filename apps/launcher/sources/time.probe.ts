/**
 * time.probe — the time-zone grammar (apps/launcher/sources/time.ts).
 *
 * The VALUES depend on the clock, so nothing here asserts a wall time: the
 * probe pins which SHAPES are answered and which are refused, plus the
 * structural promises every row makes (an arrow between two sides, a non-empty
 * description, one row). A shape a user types must either convert or fall
 * through to the other sources — never answer nonsense, and never swallow a
 * query another source owns (`10 usd to cad`, `5 kg to lb`).
 *
 * The module imports `@common/clipboard`, so this runs in the bundled tier:
 *   ags bundle --gtk 4 apps/launcher/sources/time.probe.ts /tmp/time-probe.sh
 *   bash /tmp/time-probe.sh
 */
import { timeConvert } from "./time"

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}

/** Rows for a query, with the structural promises asserted alongside. */
function rows(q: string): number {
  const out = timeConvert(q)
  for (const r of out) {
    if (!r.title.includes("→")) throw new Error(`row without an arrow for "${q}": ${r.title}`)
    if (!r.description) throw new Error(`row without a description for "${q}"`)
  }
  return out.length
}

// ── the shapes people type ──
check("a zone-led pair reads as now", rows("local to tokyo"), 1)
check("another zone-led pair", rows("tokyo to est"), 1)
check("a target alone reads as now from here", rows("to tokyo"), 1)
check("`in` works as the separator", rows("in jst"), 1)
check("a spoken opener is the same question", rows("what time is it in tokyo"), 1)
check("the short opener too", rows("time in oslo"), 1)
check("a trailing `time` word is not part of the zone", rows("tokyo time"), 1)
check("a zone after `now`", rows("now tokyo"), 1)
check("a clock in one zone targets the local one", rows("9pm tokyo"), 1)
check("`at` is a separator", rows("9pm at tokyo"), 1)
check("both zones and a clock", rows("9pm tokyo to est"), 1)
// Direction: `in`/`at` names where the clock reads, `to` names where it goes.
// Tokyo's label is fixed (JST, no DST), so this half is machine-independent.
check(
  "`in` reads the clock in that zone",
  timeConvert("9pm in tokyo")[0]?.title.startsWith("9:00 PM JST"),
  true,
)
check(
  "a lone zone after a clock is also a reading",
  timeConvert("9pm tokyo")[0]?.title.startsWith("9:00 PM JST"),
  true,
)
check("a clock with no source zone", rows("9pm to utc"), 1)
check("now with both zones", rows("now utc to pst"), 1)
check("noon is a clock", rows("noon est to utc"), 1)
check("midnight is a clock", rows("midnight utc to est"), 1)
check("a 12-hour clock with minutes", rows("9:30 am jst to utc"), 1)
check("a 24-hour clock", rows("21:00 jst to utc"), 1)
check("a fixed offset zone", rows("utc+5:30 to local"), 1)
check("an IANA name passes through", rows("europe/london to tokyo"), 1)

// ── what it refuses, so other sources can answer ──
check("a bare zone is an app search", rows("tokyo"), 0)
check("a bare clock is not a conversion", rows("9pm"), 0)
check("a currency conversion is not a time query", rows("10 usd to cad"), 0)
check("a unit conversion is not a time query", rows("5 kg to lb"), 0)
check("words that are not zones", rows("you to cat"), 0)
check("an unknown clock", rows("25:99 jst to utc"), 0)
check("an impossible hour", rows("13pm jst to utc"), 0)
check("an empty query", rows(""), 0)

const failed = checks.filter(([, a, e]) => JSON.stringify(a) !== JSON.stringify(e))
for (const [name, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`)
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`time probe failed: ${failed.length} check(s)`)
