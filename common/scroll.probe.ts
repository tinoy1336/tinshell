/**
 * scroll.probe — the shared scroll laws: the wheel step, the two conversions
 * between a scroller's pixels and a surface's row unit, the viewport bound that
 * caps a scroller's natural height, and the decision for ONE scroll event.
 *
 * gi-free apart from the viewport section, which builds real `Gtk` widgets to
 * measure the cap (the `AUTOMATIC`-policy trap below), so it runs bundled rather
 * than under plain node:
 *   ags bundle --gtk 4 common/scroll.probe.ts /tmp/scroll-probe.sh
 *   bash /tmp/scroll-probe.sh
 */
import Gtk from "gi://Gtk"
import {
  clampOffset,
  offsetForSelection,
  offsetPixels,
  ROW_PITCH_FALLBACK_PX,
  rowOffset,
  SCROLL_CONTROLLER_FLAGS,
  SCROLL_FLAG_DISCRETE,
  scrollDecision,
  selectionInView,
  stepSelection,
  viewportPixels,
  viewportRows,
  wheelSteps,
} from "./scroll"

Gtk.init()

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

const PITCH = 44
/** A SECOND row pitch: the laws take the pitch as a parameter, so a surface
 *  whose rows are taller (the launcher's emoji glyph grid) is covered here by
 *  running the same laws at a different pitch rather than by importing that
 *  surface's constant. */
const TALL_PITCH = 46
const view = (
  o: Partial<{ selected: number; offset: number; rows: number; viewport: number }> = {},
) => ({
  selected: 0,
  offset: 0,
  rows: 10,
  viewport: 3,
  ...o,
})

// ── quantisation: one wheel notch is one ENTRY ──
check("one wheel notch is one entry", wheelSteps(1, "wheel"), 1)
check("two clicks are two entries", wheelSteps(2, "wheel"), 2)
check("a fractional click is no entry", wheelSteps(0.7, "wheel"), 0)
check("scrolling up is negative", wheelSteps(-1, "wheel"), -1)
check("a surface delta is never entries", wheelSteps(5, "surface"), 0)
check("a trackpad pixel delta moves no selection by itself", wheelSteps(5, "surface") === 0, true)

// ── a wheel notch lands on a WHOLE row, never a pixel offset ──
{
  const v = view()
  const selected = stepSelection(v.selected, wheelSteps(1, "wheel"), v.rows)
  const offset = offsetForSelection(selected, v.offset, v.viewport, v.rows)
  check("a notch moves the selection by exactly one", selected, 1)
  check("a notch keeps the position on a whole row", Number.isInteger(offset), true)
  check("a notch's pixel position is a whole pitch", offsetPixels(offset, PITCH) % PITCH, 0)
  const many = offsetForSelection(
    stepSelection(0, wheelSteps(5, "wheel"), v.rows),
    0,
    v.viewport,
    v.rows,
  )
  check("five notches land on row five's window", many, 3)
  check("five notches are still whole rows", Number.isInteger(many), true)
}

// ── the arrows are the same step, and they wrap like they always did ──
check("down is one entry", stepSelection(2, 1, 10), 3)
check("up is one entry", stepSelection(2, -1, 10), 1)
check("up from the first row wraps to the last", stepSelection(0, -1, 10), 9)
check("down from the last row wraps to the first", stepSelection(9, 1, 10), 0)
check("an empty list has no selection to move", stepSelection(0, 1, 0), 0)

// ── the selection follows the view ──
check("a selection below the window pulls it down", offsetForSelection(5, 0, 3, 10), 3)
check("a selection above the window pulls it up", offsetForSelection(1, 5, 3, 10), 1)
check("a selection already visible moves nothing", offsetForSelection(3, 2, 3, 10), 2)
check("the last row cannot scroll past the end", offsetForSelection(9, 0, 3, 10), 7)

// ── a position that arrives from OUTSIDE the surface is read back as rows ──
// GTK's own scroll path moves a `Gtk.ScrolledWindow`'s adjustment (a trackpad
// gesture, its kinetic tail, a dragged scrollbar), so a surface bound to it reads
// its position from the adjustment rather than accumulating it.
check("a pixel position reads back as rows", rowOffset(PITCH * 3, PITCH), 3)
check("a fractional pixel position stays fractional", rowOffset(PITCH / 2, PITCH), 0.5)
check("a position past an end reads past it (the caller clamps)", rowOffset(-PITCH * 2, PITCH), -2)
check("the read is the inverse of the write", rowOffset(offsetPixels(4, PITCH), PITCH), 4)
check("a zero pitch reads no position", rowOffset(PITCH * 3, 0), 0)
check("a non-finite position reads nothing", rowOffset(Number.NaN, PITCH), 0)

// ── ANY row unit: the same rows, in that surface's own pixels ──
check("a taller row maps the same units to taller pixels", offsetPixels(3, TALL_PITCH), 138)
check("and reads the same units back", rowOffset(TALL_PITCH * 3, TALL_PITCH), 3)

// ── the position is bounded by the list and the viewport ──
check("the end stop is rows minus viewport", clampOffset(99, 10, 3), 7)
check("the top stop is zero", clampOffset(-5, 10, 3), 0)
check("a list shorter than the viewport cannot scroll", clampOffset(3, 2, 3), 0)

// ── the viewport cap ──
check("the viewport is the configured height", viewportRows(3, 10), 3)
check("a short list fills the viewport", viewportRows(3, 2), 2)
check("the viewport never exceeds the list", viewportRows(10, 10), 10)
check("a zero height still shows one row", viewportRows(0, 10), 1)

// ── a scroll that moved the view pulls the selection back into it ──
check("the selection is pulled back into view", selectionInView(0, 3, 3, 10), 3)
check("a selection below the window is pulled up", selectionInView(9, 3, 3, 10), 5)
check("a visible selection stays put", selectionInView(4, 3, 3, 10), 4)
check("the pull never selects past the last row", selectionInView(9, 8, 3, 9), 8)

// ── the row pitch fallback ──
check(
  "the row pitch fallback is a sane single row",
  ROW_PITCH_FALLBACK_PX > 20 && ROW_PITCH_FALLBACK_PX < 80,
  true,
)

// ── the controller's decision, per unit, with the emoji rule ──
check("a wheel notch decides a one-unit step", scrollDecision("wheel", 1, false), {
  kind: "step",
  steps: 1,
})
check("a two-click wheel event moves two units", scrollDecision("wheel", 2, false), {
  kind: "step",
  steps: 2,
})
// The hand-over: a continuous delta is the scroller's own gesture, so the app
// that reads this decision returns FALSE and keeps no momentum of its own.
check("a surface delta decides a continuous gesture", scrollDecision("surface", 12, false), {
  kind: "continuous",
})
check("a fractional wheel click decides nothing", scrollDecision("wheel", 0.4, false), {
  kind: "ignore",
})
// The emoji rule: while the grid holds the selection the LIST consumes nothing.
check(
  "the list ignores a wheel notch while the emoji grid is active",
  scrollDecision("wheel", 1, true),
  {
    kind: "ignore",
  },
)
check(
  "the list ignores a trackpad delta while the grid is active",
  scrollDecision("surface", 40, true),
  {
    kind: "ignore",
  },
)
// The DISCRETE trap: the flags the controller is built with must not carry it,
// or get_unit() would answer WHEEL for a trackpad and every gesture would notch.
check(
  "the controller flags never carry DISCRETE",
  (SCROLL_CONTROLLER_FLAGS & SCROLL_FLAG_DISCRETE) === 0,
  true,
)
check("the controller asks for vertical scrolling", (SCROLL_CONTROLLER_FLAGS & 1) === 1, true)
check("the viewport is the configured rows of pixels", viewportPixels(3, PITCH), 3 * PITCH)
check("a taller viewport is proportionally taller", viewportPixels(5, PITCH), 5 * PITCH)

// ── the viewport BOUNDS the card ──
// The card's shown height IS the toplevel's natural height (GTK sizes a window
// from its content, and `win.set_size_request` only raises the floor), so the
// viewport must bound what the scroller reports. It does that only while the
// scroller's VERTICAL policy is AUTOMATIC: with NEVER a `Gtk.ScrolledWindow`
// propagates the child's full natural height and ignores `max-content-height`,
// and the card takes the height of every row at once. Built here in the card's
// own shape (an entry row above the scroller) and measured offscreen — the
// `Gtk.Window` never has to be mapped for its natural height to be read.

const CHROME = 48

function cardNaturalHeight(policy: Gtk.PolicyType, rows: number, cap: number): number {
  const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
  for (let i = 0; i < rows; i++) {
    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL })
    row.set_size_request(-1, PITCH)
    list.append(row)
  }
  const scroller = new Gtk.ScrolledWindow()
  scroller.set_policy(Gtk.PolicyType.NEVER, policy)
  scroller.set_propagate_natural_height(true)
  scroller.set_max_content_height(cap)
  scroller.set_child(list)

  const main = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
  const entryRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL })
  entryRow.set_size_request(-1, CHROME)
  main.append(entryRow)
  main.append(scroller)

  const win = new Gtk.Window()
  win.set_child(main)
  const [, natural] = win.measure(Gtk.Orientation.VERTICAL, -1)
  return natural
}

const CARD_CAP = viewportPixels(5, PITCH)
check(
  "a 33-row list takes the card no higher than the viewport",
  cardNaturalHeight(Gtk.PolicyType.AUTOMATIC, 33, CARD_CAP),
  CHROME + CARD_CAP,
)
check(
  "a 2-row list stays content-sized, not padded to the cap",
  cardNaturalHeight(Gtk.PolicyType.AUTOMATIC, 2, CARD_CAP),
  CHROME + 2 * PITCH,
)
check(
  "the NEVER-policy trap: the list would take the height of every row",
  cardNaturalHeight(Gtk.PolicyType.NEVER, 33, CARD_CAP) > CHROME + CARD_CAP,
  true,
)

const failed = checks.filter(([, a, e]) => JSON.stringify(a) !== JSON.stringify(e))
for (const [name, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`scroll probe failed: ${failed.length} check(s)`)
