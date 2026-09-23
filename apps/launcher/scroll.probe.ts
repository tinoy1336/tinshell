/**
 * scroll.probe — the launcher's scroll laws (the wheel/selection laws, the
 * linear surface mapping and the glide that spends a flick's velocity), the
 * viewport that bounds the CARD, and the emoji grid's own scrolling left exactly
 * as it was.
 *
 * Needs the launcher's config store (the emoji helpers read it), so it runs
 * bundled rather than under plain node:
 *   ags bundle --gtk 4 apps/launcher/scroll.probe.ts /tmp/scroll-probe.sh
 *   bash /tmp/scroll-probe.sh
 */
import Gtk from "gi://Gtk"
import { emojiGridHeight, emojiScrollTop } from "./emoji"
import {
  clampOffset,
  GLIDE_DECAY_PER_MS,
  GLIDE_MAX_STEP_MS,
  GLIDE_START_ROWS_PER_MS,
  GLIDE_STOP_ROWS_PER_MS,
  glideStarts,
  glideStep,
  glideVelocity,
  linearOffset,
  offsetForSelection,
  offsetPixels,
  ROW_PITCH_FALLBACK_PX,
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

// ── the linear mapping: pixels in, proportional rows out ──
check("half a row of pixels is half a row", linearOffset(0, PITCH / 2, PITCH, 10, 3), 0.5)
check("a full row of pixels is a full row", linearOffset(0, PITCH, PITCH, 10, 3), 1)
check("twice the finger travel is twice the scroll", linearOffset(0, PITCH * 2, PITCH, 10, 3), 2)
check(
  "the mapping is linear: equal deltas move equal distances",
  linearOffset(0, PITCH * 2.5, PITCH, 10, 3) - linearOffset(0, PITCH * 1.5, PITCH, 10, 3),
  1,
)
check(
  "scrolling the other way decreases the position",
  linearOffset(1, -PITCH / 2, PITCH, 10, 3),
  0.5,
)
check("a momentum-sized delta keeps moving", linearOffset(0, PITCH * 20, PITCH, 10, 3), 7)
check("the position stops at the top", linearOffset(0, -PITCH * 20, PITCH, 10, 3), 0)
check("a zero pitch cannot divide", linearOffset(1, PITCH, 0, 10, 3), 1)

// ── the position is bounded by the list and the viewport ──
check("the end stop is rows minus viewport", clampOffset(99, 10, 3), 7)
check("the top stop is zero", clampOffset(-5, 10, 3), 0)
check("a list shorter than the viewport cannot scroll", clampOffset(3, 2, 3), 0)

// ── the momentum tail: GTK's gesture velocity, mapped and decayed ──
// The velocity comes from `::decelerate` in pixels/ms; these laws turn it into
// rows/ms, decide whether the gesture was a flick at all, and spend it frame by
// frame. Nothing here is a tween: every expectation is the decay law itself.
check("a gesture velocity maps into rows through the row pitch", glideVelocity(1, PITCH), 1 / PITCH)
check("an upward flick keeps its sign", glideVelocity(-2, PITCH), -2 / PITCH)
check("an impossible pitch maps no velocity", glideVelocity(1, 0), 0)
check("a non-finite velocity maps nothing", glideVelocity(Number.NaN, PITCH), 0)
check("a flick starts a glide", glideStarts(0.02), true)
check("the start threshold itself starts one", glideStarts(GLIDE_START_ROWS_PER_MS), true)
check("an upward flick starts one too", glideStarts(-0.02), true)
check("a slow drag starts nothing", glideStarts(0.001), false)
check("a zero velocity starts nothing", glideStarts(0), false)
{
  /** The distance one frame's velocity decays through — the decay law's own
   *  integral over that frame. */
  const travel = (velocity: number, dt: number) =>
    (velocity * (1 - Math.exp(-GLIDE_DECAY_PER_MS * dt))) / GLIDE_DECAY_PER_MS
  const first = glideStep(1, 0.02, 16, 100, 3)
  check("the first frame travels the decay's integral", first.offset, 1 + travel(0.02, 16))
  check(
    "a frame travels less than its velocity would at full speed",
    first.offset < 1 + 0.02 * 16,
    true,
  )
  check(
    "the first frame keeps all but the decay",
    first.velocity,
    0.02 * Math.exp(-GLIDE_DECAY_PER_MS * 16),
  )
  const second = glideStep(1, first.velocity, 16, 100, 3)
  check(
    "every frame keeps less of the velocity",
    second.velocity < first.velocity && second.velocity > 0,
    true,
  )
  check(
    "a stalled frame cannot spend the whole tail",
    glideStep(0, 0.02, 5000, 1000, 3).offset,
    travel(0.02, GLIDE_MAX_STEP_MS),
  )
  check("a zero-duration frame moves nothing", glideStep(3, 0.02, 0, 10, 3).offset, 3)
  check("a zero-duration frame keeps the velocity", glideStep(3, 0.02, 0, 10, 3).velocity, 0.02)
  check("a zero velocity moves nothing", glideStep(3.5, 0, 16, 10, 3), { offset: 3.5, velocity: 0 })
  check("an upward flick glides up", glideStep(5, -0.02, 16, 10, 3).offset, 5 - travel(0.02, 16))
  check("the glide stops at the end of the list", glideStep(96.99, 0.02, 16, 100, 3), {
    offset: 97,
    velocity: 0,
  })
  check("the glide stops at the top", glideStep(0, -0.02, 16, 100, 3), { offset: 0, velocity: 0 })
  check(
    "a glide under the stop threshold ends after its frame",
    glideStep(0, GLIDE_STOP_ROWS_PER_MS * 0.9, 16, 100, 3).velocity,
    0,
  )
  check("a stopped glide leaves the position alone", glideStep(3, 0, 16, 100, 3), {
    offset: 3,
    velocity: 0,
  })
  // The decay IS the law: simulated frame by frame, the tail travels the
  // starting velocity's exponential integral less the stop threshold, and the
  // distance does not depend on the frame rate.
  const glide = (dt: number) => {
    let offset = 0
    let velocity = 0.02
    let frames = 0
    while (velocity !== 0 && frames < 1000) {
      const step = glideStep(offset, velocity, dt, Number.MAX_SAFE_INTEGER, 3)
      offset = step.offset
      velocity = step.velocity
      frames++
    }
    return { offset, frames }
  }
  const at60 = glide(16)
  const at120 = glide(8)
  const travelled = (0.02 - GLIDE_STOP_ROWS_PER_MS) / GLIDE_DECAY_PER_MS
  check(
    "a flick's tail travels the decay's integral",
    Math.abs(at60.offset - travelled) < travelled * 0.02,
    true,
  )
  check("a flick's tail decelerates over many frames, not a tween", at60.frames > 20, true)
  check(
    "the same flick travels the same distance at twice the frame rate",
    Math.abs(at120.offset - at60.offset) < at60.offset * 0.005,
    true,
  )
}

// ── the viewport cap ──
check("the viewport is the configured height", viewportRows(3, 10), 3)
check("a short list fills the viewport", viewportRows(3, 2), 2)
check("the viewport never exceeds the list", viewportRows(10, 10), 10)
check("a zero height still shows one row", viewportRows(0, 10), 1)

// ── a linear scroll pulls the selection back into the viewport ──
check("the selection is pulled back into view", selectionInView(0, 3, 3, 10), 3)
check("a selection below the window is pulled up", selectionInView(9, 3, 3, 10), 5)
check("a visible selection stays put", selectionInView(4, 3, 3, 10), 4)
check("the pull never selects past the last row", selectionInView(9, 8, 3, 9), 8)

// ── the emoji grid's own scroller is untouched ──
check("the emoji grid still scrolls to keep a cell visible", emojiScrollTop(9, 24, 1, 3, 0), 7)
check("the emoji grid scrolls from the top", emojiScrollTop(1, 24, 1, 3, 0), 0)
check("the emoji grid never scrolls past its last row", emojiScrollTop(23, 24, 1, 3, 0), 21)
check("the emoji grid keeps its own height for 3 rows", emojiGridHeight(3), 3 * 46)
check(
  "the row pitch fallback is a sane single row",
  ROW_PITCH_FALLBACK_PX > 20 && ROW_PITCH_FALLBACK_PX < 80,
  true,
)

// ── the controller's decision, per unit, with the emoji rule ──
check("a wheel notch decides a one-entry selection move", scrollDecision("wheel", 1, false), {
  kind: "selection",
  steps: 1,
})
check("a two-click wheel event moves two entries", scrollDecision("wheel", 2, false), {
  kind: "selection",
  steps: 2,
})
check("a surface delta decides a pixel move", scrollDecision("surface", 12, false), {
  kind: "position",
  pixels: 12,
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
check("the controller asks for the kinetic phase", (SCROLL_CONTROLLER_FLAGS & 8) === 8, true)
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
