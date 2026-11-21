/**
 * emoji.probe — the launcher's emoji GRID row maths: the arrows'
 * selection-follow (`emojiScrollTop`), the visible-area height
 * (`emojiGridHeight`) and the pitch both are stated in.
 *
 * The grid's WHEEL path is NOT here: it is the shared scroll laws
 * (`@common/scroll`, probed by `common/scroll.probe.ts`) applied in grid rows;
 * its GESTURE — the drag scaling and the momentum after a flick — belongs to the
 * grid's own scroller. That is why the law is probed where it lives rather than
 * twice.
 *
 * Reads the launcher's config store (the emoji helpers do), so it runs bundled
 * rather than under plain node:
 *   ags bundle --gtk 4 apps/launcher/emoji.probe.ts /tmp/emoji-probe.sh
 *   bash /tmp/emoji-probe.sh
 */

import { searchEntries } from "@common/emoji/search"
import { EMOJI_ROW_PITCH, emojiGridHeight, emojiScrollTop } from "./emoji"

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

// ── the grid's row maths: the arrows' selection-follow ──
// Row indexes, not pixels, and the minimal scroll: a selection already visible
// does not move the grid, one past an edge moves it exactly one row.
check("a cell below the viewport scrolls to it", emojiScrollTop(9, 24, 1, 3, 0), 7)
check("the grid scrolls from the top", emojiScrollTop(1, 24, 1, 3, 0), 0)
check("a visible cell leaves the grid alone", emojiScrollTop(1, 24, 1, 3, 0), 0)
check("the grid never scrolls past its last row", emojiScrollTop(23, 24, 1, 3, 0), 21)

// ── the grid's visible area and the pitch it is counted in ──
check("the grid keeps its height for 3 visible rows", emojiGridHeight(3), 3 * EMOJI_ROW_PITCH)
check("the pitch is a plausible glyph row", EMOJI_ROW_PITCH > 20 && EMOJI_ROW_PITCH < 80, true)

// ── the query layer: what the ranking must answer first ──
// The table's own contents are the generator's business (scripts/gen-emoji.ts);
// these pin the ORDER the picker shows, which is what a user reports as broken.
const first = (q: string) => searchEntries(q, 60)[0]?.glyph
check("a name answers its own query first", first("book"), "📚")
check("a CLDR keyword answers the greeting", first("hello"), "👋")
check("an exact keyword beats a longer name", first("thanks"), "🙏")
check("a colon-wrapped query searches the same term", first(":cat:"), first("cat"))
check("an empty query matches nothing", searchEntries("", 10).length, 0)
check("a query with no match returns nothing", searchEntries("qxzjv", 10).length, 0)
check(
  "a scattered subsequence is not a match",
  searchEntries("book", 60).some((e) => e.glyph === "🍾"),
  false,
)

const failed = checks.filter(([, a, e]) => JSON.stringify(a) !== JSON.stringify(e))
for (const [name, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`emoji probe failed: ${failed.length} check(s)`)
