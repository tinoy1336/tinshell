/**
 * Overflow.probe — the overflow clock's rim-marker scale, headless: no window,
 * no display, no pointer. It pins the ONE function every ring readout runs
 * through (`notchRun` / `litMarkerCount`, exported from ./Overflow) at the
 * boundaries the clock documents, the two-tier scale that divides each gap
 * between the majors into sub-ticks (`notchTicks`), the run state the dial hands
 * its declared fade element and the BAND identity it fades on
 * (`notchRunState` / `notchRunBands`), the shared battery band policy
 * (`batteryRingBands`) the charge scale's colours come from, the lane rule that
 * decides which
 * reading paints (`transientStep`), the hands' 1 Hz pinned reading
 * (`dialTimeOf` / `secondHandAngle`), plus the timings the transient readout
 * reads from the dock config.
 *
 * Why the boundaries matter: the dial's markers are the battery readout in the
 * overflow `hide` mode AND the transient volume/brightness readout while one of
 * them is being adjusted, so an off-by-one in the threshold arithmetic shows a
 * WRONG CHARGE for a battery that is not on the row, a fade identity that moves
 * with the lit fraction cross-fades every charge step instead of adopting it,
 * and a lane that swallows the first change loses the
 * user's first adjustment after a dock row rebuild. Readiness itself is the
 * volume domain's decision — it publishes no reading until WirePlumber has bound
 * the sink — so the lane carries no settling rule of its own.
 *
 * Run:
 *   ags bundle --gtk 4 apps/dock/Overflow.probe.ts /tmp/overflow-probe.sh
 *   bash /tmp/overflow-probe.sh     # exit 1 on any violated invariant
 */

import {
  type BatteryBand,
  batteryRingBands,
  batteryRingColour,
  type ConfigColour,
} from "@common/applets/shared/battery-colour"
import { config } from "./config"
import OverflowApplet, {
  CLOCK_SMOOTH_FPS,
  createNotchSmoother,
  type DialTime,
  dialTimeOf,
  intendedClockVisible,
  litMarkerCount,
  NOTCH_SMOOTH_EPSILON,
  NOTCH_SMOOTH_FACTOR,
  type NotchBand,
  notchRun,
  notchRunBands,
  notchRunState,
  notchTicks,
  secondHandAngle,
  smoothFrameBudgetUs,
  smoothLoopRuns,
  type TransientLane,
  transientStep,
  uniformNotchBands,
} from "./Overflow.tsx"

const failures: string[] = []
const check = (name: string, ok: boolean): void => {
  if (!ok) failures.push(name)
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

// ── The documented boundary table (12 markers, 100/12 ≈ 8.33 % apart) ──
// The thresholds are EXACT fractions (i·100/count), so the vectors are too: a
// rounded 8.33 sits just BELOW the 1 o'clock threshold and lights 1 marker.

const COUNT = 12
const STEP = 100 / COUNT
const cases: [number, number][] = [
  [0, 1], // 12 o'clock lights at 0 % — a dial with no lit marker reads as dead
  [STEP, 2], // 1 o'clock, exactly on its threshold
  [2 * STEP, 3], // 2 o'clock
  [50, 7],
  [11 * STEP, 12], // 11 o'clock
  [100, 12],
]
for (const [value, lit] of cases) {
  check(
    `${value}% lights ${lit} of ${COUNT} markers (got ${litMarkerCount(value, COUNT)})`,
    litMarkerCount(value, COUNT) === lit,
  )
}
check(
  "a hair under a threshold has not reached it",
  litMarkerCount(STEP - 0.01, COUNT) === 1 && litMarkerCount(2 * STEP - 0.01, COUNT) === 2,
)
check(
  "a hair over a threshold has reached it",
  litMarkerCount(STEP + 0.01, COUNT) === 2 && litMarkerCount(11 * STEP + 0.01, COUNT) === 12,
)

// ── The edges ──

check("a value below 0 keeps the first marker lit", litMarkerCount(-5, COUNT) === 1)
check("a value above 100 lights every marker", litMarkerCount(140, COUNT) === COUNT)
check("a non-finite value reads as 0", litMarkerCount(Number.NaN, COUNT) === 1)
check("a 4-marker dial rescales (50 % → 3)", litMarkerCount(50, 4) === 3)
check("a zero-marker dial lights nothing", litMarkerCount(50, 0) === 0)
check("a fractional count is floored", litMarkerCount(50, 12.9) === 7)

// ── The run itself: the band each LIT marker falls in, null past the lit run ──

const colour = { rgb: [1, 0.5, 0.25], alpha: 0.8 }
/** ONE uniform band over the whole dial — the transient readout's own shape. */
const oneBand = uniformNotchBands(colour)
const dark = notchRun(0, COUNT, oneBand)
check("0 % lights only the 12 o'clock marker", dark(0) !== null && dark(1) === null)
check(
  "the run answers the colour of the band it was given",
  dark(0)?.alpha === 0.8 && dark(0)?.rgb[0] === 1,
)
const full = notchRun(100, COUNT, oneBand)
check("100 % lights the last marker", full(COUNT - 1) !== null)
check("the run never answers a marker past the dial", full(COUNT) === null)
const mid = notchRun(50, COUNT, oneBand)
check(
  "a mid value lights through the 6 o'clock marker, not past it",
  mid(6) !== null && mid(7) === null,
)

// ── Several bands in ONE run: the charge scale's split at the charge limit ──
// A lit marker carries the colour of the band its OWN threshold falls in, so one
// run paints the level colour below the limit and the charging blue above it. A
// marker sitting exactly ON a boundary belongs to the LOWER band — the marker the
// reading itself sits on keeps the reading's colour — and a run with no bands
// answers nothing at all.

const underColour = { rgb: [0.2, 0.8, 0.2], alpha: 0.9 }
const overColour = { rgb: [0.3, 0.6, 0.95], alpha: 0.9 }
const splitBands: NotchBand[] = [
  { start: 0, end: 80, colour: underColour },
  { start: 80, end: 100, colour: overColour },
]
const split = notchRun(100, COUNT, splitBands)
check(
  "a marker below the boundary carries the lower band's colour",
  split(9)?.rgb[0] === underColour.rgb[0],
)
check(
  "a marker past the boundary carries the upper band's colour",
  split(10)?.rgb[0] === overColour.rgb[0],
)
// A 10-marker dial puts a marker exactly ON 80 %, which is the boundary case.
const splitAt = notchRun(100, 10, splitBands)
check(
  "a marker exactly ON the boundary belongs to the lower band, the one after it to the upper",
  splitAt(8)?.rgb[0] === underColour.rgb[0] && splitAt(9)?.rgb[0] === overColour.rgb[0],
)
check(
  "a run with no bands lights nothing",
  notchRun(100, COUNT, [])(0) === null && notchRun(100, COUNT, [])(COUNT - 1) === null,
)

/** The distinct colours a run answers for its lit slots (nulls excluded). */
function litColours(run: (i: number) => ConfigColour | null, slots: number): string[] {
  const seen = new Set<string>()
  for (let i = 0; i < slots; i++) {
    const c = run(i)
    if (c) seen.add(`${c.rgb.join(",")}@${c.alpha}`)
  }
  return [...seen]
}

// ── The two-tier scale: minor sub-ticks between the majors ──
// `notchTicks` divides each gap between adjacent majors into minorTicksPerGap + 1
// slots on ONE ring. The value lights the WHOLE scale by the same run, so the
// majors keep the slot index, the angle and the exact threshold they have on a
// majors-only scale while the sub-ticks between them light at the finer
// granularity. That invariant is what makes the change additive: nothing about
// the ring's colour policy or the majors' positions moves.

/** The lit flags of the majors at `value` on a scale with `minorPerGap` sub-ticks. */
const majorLit = (value: number, minorPerGap: number): boolean[] => {
  const ticks = notchTicks(COUNT, minorPerGap)
  const run = notchRun(value, ticks.length, oneBand)
  return ticks.filter((t) => t.major).map((t) => run(t.slot) !== null)
}
/** The lit flags of the 12 markers on the majors-only scale. */
const singleTierLit = (value: number): boolean[] => {
  const run = notchRun(value, COUNT, oneBand)
  return Array.from({ length: COUNT }, (_, i) => run(i) !== null)
}

check("0 minors draws the majors alone", notchTicks(COUNT, 0).length === COUNT)
check(
  "the majors-only scale is all majors",
  notchTicks(COUNT, 0).every((t) => t.major),
)
check("1 minor per gap doubles the tick count", notchTicks(COUNT, 1).length === 2 * COUNT)
check(
  "3 minors per gap give 4 slots per gap",
  notchTicks(COUNT, 3).length === 4 * COUNT &&
    notchTicks(COUNT, 3).filter((t) => t.major).length === COUNT,
)
check(
  "the majors keep their slot index at every subdivision",
  [1, 3, 7].every((m) => notchTicks(COUNT, m).every((t) => t.major === (t.slot % (m + 1) === 0))),
)
check("a fractional gap is floored", notchTicks(COUNT, 2.9).length === 3 * COUNT)
check("a negative gap degrades to the majors alone", notchTicks(COUNT, -4).length === COUNT)
check("a zero-marker dial has no scale", notchTicks(0, 3).length === 0)

// Every slot is evenly spaced on the SAME ring: major i keeps the angle it has
// on a majors-only scale, so the sub-ticks land between the markers and nowhere
// else.
const twoPi = Math.PI * 2
for (const m of [1, 3, 7]) {
  const slots = notchTicks(COUNT, m).length
  check(
    `major i keeps its 12-marker angle at ${m} minor(s) per gap`,
    Array.from({ length: COUNT }, (_, i) => i).every((i) =>
      near((i * (m + 1) * twoPi) / slots, (i * twoPi) / COUNT),
    ),
  )
}

// The majors light at the SAME values whatever the subdivision — the sub-ticks
// fill in between their thresholds instead of shifting them.
for (const value of [0, 4.17, 100 / COUNT, 12.5, 50, 11 * (100 / COUNT), 99.9, 100]) {
  for (const m of [0, 1, 3, 7]) {
    check(
      `the majors light the same set at ${value}% with ${m} minor(s) per gap`,
      majorLit(value, m).every((lit, i) => lit === singleTierLit(value)[i]),
    )
  }
}

// The finer subdivision really does change the lit fraction at a value the
// majors alone rounded away: 6 % has not reached the 1 o'clock marker, but it
// is two thirds of the way to it, which the sub-ticks show.
const at6Majors = singleTierLit(6)
const at6Fine = notchTicks(COUNT, 3)
const at6Run = notchRun(6, at6Fine.length, oneBand)
const at6Lit = at6Fine.filter((t) => at6Run(t.slot) !== null)
check(
  "6 % lights only the 12 o'clock marker on the majors-only scale",
  at6Majors.filter(Boolean).length === 1 && at6Majors[0],
)
check(
  "...the same single major on the fine scale",
  at6Fine.filter((t) => t.major && at6Run(t.slot) !== null).length === 1,
)
check(
  "6 % lights the first gap's sub-ticks on the fine scale",
  at6Fine.every((t) => t.slot === 0 || t.slot >= 3 || at6Run(t.slot) !== null) &&
    at6Run(3) === null,
)
check(
  "the lit fraction the majors alone rounded away is visible on the fine scale",
  at6Lit.length > at6Majors.filter(Boolean).length,
)

// Finer subdivision never lights FEWER ticks at a fixed value: the scale grows
// towards the value's threshold, it does not shift it.
const litCountAt = (value: number, m: number): number => {
  const ticks = notchTicks(COUNT, m)
  const run = notchRun(value, ticks.length, oneBand)
  return ticks.filter((t) => run(t.slot) !== null).length
}
for (const value of [6, 17, 55, 83.4]) {
  check(
    `the lit tick count grows with the subdivision at ${value}%`,
    litCountAt(value, 0) <= litCountAt(value, 1) && litCountAt(value, 1) <= litCountAt(value, 3),
  )
}

// ── The run's declared fade state and the BAND identity it fades on ──
// The dial hands its run to the shared declared fade element as ONE state
// (`notchRunState`). That mechanism keys a change on BOTH the state's own string
// form and the identity the caller declares: it cross-fades only when the two
// move together, and ADOPTS when either stays put. The run therefore passes its
// BANDS — spans and colours — as the identity, so a change of the lit fraction
// alone (a charge step, a slider step) moves the state, keeps the identity and
// adopts at once, while a change of colour, of a span, or of the number of bands
// moves both and cross-fades. Two consequences are load-bearing, and the checks
// below bite on both: the state must carry the lit fraction where the string form
// sees it (then one six-number record per band), and the key must carry every
// band in FULL, alpha included — a colour change is never hidden behind an adopt.

const runColour = { rgb: [0.54, 0.71, 0.97], alpha: 0.9 }
/** The same colour in a fresh object — a paint re-states its run every frame. */
const runColourAgain = { rgb: [0.54, 0.71, 0.97], alpha: 0.9 }
const runBands: NotchBand[] = [{ start: 0, end: 100, colour: runColour }]
const runBandsAgain: NotchBand[] = [{ start: 0, end: 100, colour: runColourAgain }]
const runAt20 = notchRunState(20, runBands)
const runAt35 = notchRunState(35, runBands)

check(
  "the run's state is an ARRAY (the mechanism keys on its string form) opening on the lit fraction",
  Array.isArray(runAt20.state) &&
    runAt20.state.length === 7 &&
    near(runAt20.state[0], 20) &&
    near(runAt35.state[0], 35),
)
check(
  "...followed by one record per band: start, end, r, g, b, a",
  near(runAt20.state[1], 0) &&
    near(runAt20.state[2], 100) &&
    near(runAt20.state[3], runColour.rgb[0]) &&
    near(runAt20.state[4], runColour.rgb[1]) &&
    near(runAt20.state[5], runColour.rgb[2]) &&
    near(runAt20.state[6], runColour.alpha),
)
// The painter reads the run back out of the state it is handed, so the round trip
// is what the multi-colour paint depends on.
const roundTrip = notchRunBands(runAt20.state)
check(
  "the bands round-trip out of the painted state (the painter's only input)",
  roundTrip.length === 1 &&
    roundTrip[0]?.start === 0 &&
    roundTrip[0]?.end === 100 &&
    roundTrip[0]?.colour.rgb[0] === runColour.rgb[0] &&
    roundTrip[0]?.colour.alpha === runColour.alpha,
)

// The lit fraction moves the state and NOT the identity: one charge step adopts,
// so the run grows or shrinks under the value sweep instead of cross-fading.
check(
  "a change of the lit fraction alone moves the state and keeps the identity",
  String(runAt20.state) !== String(runAt35.state) && runAt20.key === runAt35.key,
)
// The SAME identity at two lit fractions: an identity that carried the fraction
// would start a transition on every charge step the user already sees sweeping.
check(
  "...so two lit fractions of ONE band list are one identity at any pair of fractions",
  notchRunState(0, runBands).key === notchRunState(100, runBands).key &&
    notchRunState(0, runBands).key === runAt20.key,
)

// A colour change moves BOTH, which is what a transition needs: the identity
// moved and the state's string form moved with it.
const runOtherColour = notchRunState(20, [
  { start: 0, end: 100, colour: { rgb: [0.98, 0.89, 0.33], alpha: 0.8 } },
])
check(
  "a change of colour at the SAME lit fraction moves the identity AND the state",
  runOtherColour.key !== runAt20.key && String(runOtherColour.state) !== String(runAt20.state),
)
// A SPAN change is a colour change's equal: the charge limit moving under an
// otherwise identical reading re-draws where the bands split, and the identity
// must move with it or the new split snaps into place.
const runSplitBands = notchRunState(20, [
  { start: 0, end: 80, colour: runColour },
  { start: 80, end: 100, colour: { rgb: [0.98, 0.89, 0.33], alpha: 0.8 } },
])
check(
  "a change of the band SPANS at the same colours moves the identity",
  runSplitBands.key !== runAt20.key,
)
// Alpha is part of the colour, not a detail the identity may drop: a colour that
// reads as one identity hides the change behind an adopt, and a run that fades
// in and out of strength would snap instead.
const runSameRgbAlpha = notchRunState(20, [
  { start: 0, end: 100, colour: { rgb: [0.54, 0.71, 0.97], alpha: 0.6 } },
])
check(
  "two colours differing ONLY in alpha are two identities (and two states)",
  runSameRgbAlpha.key !== runAt20.key && String(runSameRgbAlpha.state) !== String(runAt20.state),
)
check(
  "the colour the run paints is the colour the key names, rgb and alpha together",
  runAt20.key ===
    `0-100:${runColour.rgb[0]},${runColour.rgb[1]},${runColour.rgb[2]}@${runColour.alpha}`,
)
// An UNCHANGED run moves neither: a repaint of the same reading must start no
// transition at all, whatever object the colour arrives in.
const runRestated = notchRunState(20, runBandsAgain)
check(
  "an unchanged run re-stated in a fresh object moves neither the state nor the identity",
  String(runRestated.state) === String(runAt20.state) && runRestated.key === runAt20.key,
)
check(
  "...while the same bands at a DIFFERENT fraction move the state alone (the adopt path)",
  String(runRestated.state) !== String(runAt35.state) && runRestated.key === runAt35.key,
)

// ── The transient lane's baseline rule ──
// The lane compares each reading against the reading it holds. Readiness is the
// DOMAIN's decision (`common/applets/domains/volume` answers `available: false`
// until WirePlumber has bound the sink with its volume parameter, so no
// pre-settle reading is ever published), so the lane carries no settling rule of
// its own: the first reading a lane with no baseline adopts becomes that
// baseline, and every later change paints.

const seeded: TransientLane = { baseline: 40 }
const same = transientStep(seeded, 40)
check(
  "a subscription firing for the value the lane already holds shows nothing",
  same.show === null && same.lane.baseline === 40,
)
const rebuilt = transientStep(seeded, 25)
check(
  "a lane seeded from a dock row rebuild shows the user's FIRST adjustment",
  rebuilt.show === 25 && rebuilt.lane.baseline === 25,
)
check("a further change keeps showing", transientStep(rebuilt.lane, 30).show === 30)

// The startup sequence a fresh process produces: the domain reports no sink at
// mount, so the lane is seeded empty and the ONE real reading it then publishes
// is adopted, never shown.
const fresh = transientStep({ baseline: null }, 25)
check(
  "a fresh process's first real reading is adopted, not shown",
  fresh.show === null && fresh.lane.baseline === 25,
)
check("the user's first adjustment after that IS shown", transientStep(fresh.lane, 42).show === 42)

// The adoption is by POSITION, not by value: the brightness domain publishes its
// first reading whatever the screen sits at, so a machine at 100 % publishes 100
// as its first reading — still adopted, still no boot readout, and the first
// adjustment off it paints.
const atFull = transientStep({ baseline: null }, 100)
check(
  "a first reading of 100 % is adopted, not shown",
  atFull.show === null && atFull.lane.baseline === 100,
)
check(
  "the first adjustment off a full-brightness baseline paints",
  transientStep(atFull.lane, 90).show === 90,
)

// ── The repaint policy: per frame only while the dial is actually moving ──
// The clock paints per frame while a transition is in flight, while the notch
// scale's lit fraction is still EASING toward its reading, and while a transient
// volume/brightness reading is live on a VISIBLE clock — `smoothLoopRuns` is that
// policy, and it is what keeps the clock from ever becoming a permanently 60fps
// surface (the idle repaint stays the `timing.clockTickMs` tick, checked below).
// `smoothFrameBudgetUs(CLOCK_SMOOTH_FPS)` is the rate the loop admits a frame at.
// What this does NOT cover: whether the frame source actually fires on a mapped
// widget, and how the result looks — the visual check is the user's.

const smoothFps = CLOCK_SMOOTH_FPS
check(
  `the smooth rate is a positive number (${smoothFps} fps)`,
  Number.isFinite(smoothFps) && smoothFps > 0,
)
const budget = smoothFrameBudgetUs(smoothFps)
check(
  `the frame budget is one frame at ${smoothFps} fps less the judder slack ` +
    `(${Math.round(budget)} µs)`,
  near(budget, 1_000_000 / smoothFps - 1000) && budget > 0 && budget < 1_000_000 / smoothFps,
)
// A 60 Hz panel's own frame delta must clear the budget: a strict budget would
// refuse every frame at exactly the nominal rate and paint one frame in two.
const frame60 = 1_000_000 / 60
check("a 60 Hz frame clears the budget (a strict one would judder)", frame60 >= budget)
check(
  "a 120 Hz frame is refused, so a faster panel is held to the declared rate",
  frame60 / 2 < budget && frame60 >= budget,
)
check("a slower rate admits a longer budget", smoothFrameBudgetUs(30) > budget)
check(
  "the budget follows the rate it is given",
  near(smoothFrameBudgetUs(120), 1_000_000 / 120 - 1000),
)

// The phases of a transient window, as the policy sees them.
check(
  "an idle visible clock stops the loop (its repaint stays the idle tick)",
  !smoothLoopRuns({ animating: false, easing: false, transient: false, clockVisible: true }),
)
check(
  "the HOLD keeps the loop alive — nothing is tweening, only the reading is up",
  smoothLoopRuns({ animating: false, easing: false, transient: true, clockVisible: true }),
)
check(
  "a transition in flight keeps the loop alive with no reading on the dial",
  smoothLoopRuns({ animating: true, easing: false, transient: false, clockVisible: true }),
)
check(
  "a hidden clock does not spend frames on a live reading",
  !smoothLoopRuns({ animating: false, easing: false, transient: true, clockVisible: false }),
)
check(
  "...but it still finishes a transition in flight (the fade must land)",
  smoothLoopRuns({ animating: true, easing: false, transient: true, clockVisible: false }),
)
// An ordinary charge change is neither of those: the scale eases, and that alone
// keeps the loop — until it settles.
check(
  "an easing lit fraction keeps the loop alive on a visible clock",
  smoothLoopRuns({ animating: false, easing: true, transient: false, clockVisible: true }),
)
check(
  "...and not on a hidden one (a hidden clock paints nothing)",
  !smoothLoopRuns({ animating: false, easing: true, transient: false, clockVisible: false }),
)
check(
  "a settled scale stops the loop again",
  !smoothLoopRuns({ animating: false, easing: false, transient: false, clockVisible: false }),
)

// ── The tick kind reads the clock's INTENDED visibility ──
// The idle tick is chosen from this: a 1 s repaint while the clock is visible,
// the 500 ms watchdog while it is hidden. A fade in flight has not moved
// `clockFade` yet when the tick is armed, so the pending tween's TARGET is what
// answers — reading the raw fade armed the hidden watchdog for a clock fading
// IN, and the watchdog then re-armed a reappear delay over a clock already on
// screen: the hands froze for `appearMs` and stamped forward by it.
check(
  "with no fade pending the current fade decides",
  intendedClockVisible(1, null) && !intendedClockVisible(0, null),
)
check("a fade IN is visible before its tween has moved the fade", intendedClockVisible(0, 1))
check("a fade OUT is hidden before its tween has moved the fade", !intendedClockVisible(1, 0))
check(
  "a tween target of exactly 0 is hidden, however far the fade has run",
  !intendedClockVisible(0.9, 0),
)

// ── The notch-value easing: the applet rings' own animation ──
// The dial's painted values ease toward their readings a frame at a time — the
// shape the applet cores smooth their closed-state ring with (`ringValue += diff
// * 0.3`, settled under 0.3, in common/applets/shared/create-applet-core.ts).
// `createNotchSmoother` is that shape: it SNAPS on settle, which is the frame
// loop's stop condition, and it ADOPTS the first reading it is handed instead of
// sweeping from a made-up value. What this cannot cover: whether the frames land
// smoothly on screen — that is the eye's judgement, not a probe's.

check(
  `the settle shape is the applet rings' own (factor ${NOTCH_SMOOTH_FACTOR}, settle ${NOTCH_SMOOTH_EPSILON})`,
  NOTCH_SMOOTH_FACTOR === 0.3 && NOTCH_SMOOTH_EPSILON === 0.3,
)

const eased = createNotchSmoother(0)
check("a seeded smoother starts on its initial value", eased.value === 0 && !eased.moving)
check("...and is behind a reading it has not reached", eased.behind(50))
const firstFrame = eased.advance(50)
check(
  "one frame moves the smoothing factor of the way",
  firstFrame && near(eased.value, 50 * NOTCH_SMOOTH_FACTOR) && eased.moving,
)
eased.advance(50)
check("...approaching without overshooting", eased.value > 15 && eased.value < 50)

// A step DOWN is the mirror image: only the distance matters, never the sign.
const easedDown = createNotchSmoother(50)
easedDown.advance(0)
check(
  "a step down moves by the same fraction",
  near(easedDown.value, 50 * (1 - NOTCH_SMOOTH_FACTOR)),
)

// Settling bounds the frames one change costs: the value SNAPS onto its reading
// and the loop's step answers false, which is what stops the loop.
const settling = createNotchSmoother(0)
let settleFrames = 0
while (settling.advance(50)) settleFrames++
check(`a 50-unit change settles in ${settleFrames} frames`, settleFrames > 0 && settleFrames < 25)
check("...landing on the reading EXACTLY, not near it", settling.value === 50)
check(
  "...and reporting no further work",
  !settling.moving && !settling.behind(50) && !settling.advance(50),
)

// The frames a change costs scale with its SIZE (an exponential approach, not a
// fixed-duration tween): a 1 % charge step is a handful of frames, a full-scale
// jump stays bounded, and both stop.
const framesFor = (delta: number): number => {
  const s = createNotchSmoother(0)
  let n = 0
  while (s.advance(delta)) n++
  return n
}
check("a 1-unit change costs a handful of frames", framesFor(1) <= 6)
check(
  "...a bigger change costs more and stays bounded",
  framesFor(100) > framesFor(1) && framesFor(100) <= 25,
)

// `initial: null` = no reading yet: the first reading is ADOPTED, never swept
// from a made-up value (a fresh process has no charge to sweep from).
const unseeded = createNotchSmoother(null)
check("a smoother with no reading is behind nothing", !unseeded.behind(80) && !unseeded.moving)
check(
  "...and adopts the first reading it is handed",
  !unseeded.advance(80) && unseeded.value === 80,
)
check(
  "...before easing the next one",
  unseeded.advance(60) && near(unseeded.value, 80 - 20 * NOTCH_SMOOTH_FACTOR),
)

// `adopt` lands at once: a transition that animates another way (the source
// crossfade) must not sweep the value as well.
const adopted = createNotchSmoother(0)
adopted.adopt(42)
check("adopt lands on the reading with no sweep", adopted.value === 42 && !adopted.moving)

// The sweep is what the eye sees on the ring: the lit fraction walks through the
// scale's intermediate counts instead of jumping to its end count.
const sweepSlots = notchTicks(COUNT, 3).length
const sweep = createNotchSmoother(0)
const litCounts: number[] = [litMarkerCount(sweep.value, sweepSlots)]
while (sweep.advance(50) && litCounts.length < 500)
  litCounts.push(litMarkerCount(sweep.value, sweepSlots))
check(
  `the lit fraction walks ${new Set(litCounts).size} counts up to the reading's`,
  new Set(litCounts).size >= 5,
)
check(
  "...never going backwards, never past it, and landing exactly on it",
  litCounts.every((v, i) => i === 0 || v >= litCounts[i - 1]) &&
    litCounts[litCounts.length - 1] <= litMarkerCount(50, sweepSlots) &&
    litMarkerCount(sweep.value, sweepSlots) === litMarkerCount(50, sweepSlots),
)
check(
  "a value mid-transition maps to a lit fraction BETWEEN the endpoints",
  litCounts.length > 5 &&
    litCounts[2] > litCounts[0] &&
    litCounts[2] < litCounts[litCounts.length - 1],
)

// ── The config contract the transient readout reads ──
// A missing/zero key would arm a 0 ms hold (inert), so the key being present
// and positive is part of the clock's behaviour.

const clk = config.appearance.clock
check(
  `appearance.clock.transientHoldMs is a positive number (${clk.transientHoldMs})`,
  typeof clk.transientHoldMs === "number" && clk.transientHoldMs > 0,
)
// The two-tier scale's knob: an integer ≥ 0 sub-ticks per gap, and the tick
// count the renderer will paint follows it (0 = the 12 majors alone).
check(
  `appearance.clock.minorTicksPerGap is a whole number ≥ 0 (${clk.minorTicksPerGap})`,
  typeof clk.minorTicksPerGap === "number" &&
    Number.isInteger(clk.minorTicksPerGap) &&
    clk.minorTicksPerGap >= 0,
)
check(
  `the scale follows the config key (${notchTicks(COUNT, clk.minorTicksPerGap).length} ticks at ` +
    `${clk.minorTicksPerGap} per gap)`,
  notchTicks(COUNT, clk.minorTicksPerGap).length === COUNT * (clk.minorTicksPerGap + 1),
)
check(
  `timing.pillAnim is a positive number (${config.timing.pillAnim}) — the transient fade length`,
  typeof config.timing.pillAnim === "number" && config.timing.pillAnim > 0,
)
check(
  `timing.clockTickMs is a positive number (${config.timing.clockTickMs}) — the repaint that advances the hands`,
  typeof config.timing.clockTickMs === "number" && config.timing.clockTickMs > 0,
)

// ── The hands' 1 Hz source ──
// The dial paints ONE pinned reading: `dialTimeOf` is stamped by the 1 s tick
// and by every appearance, and every repaint reads the stamp. The second hand
// therefore steps a whole 2π/60 per second and cannot be dragged along by a
// frame repaint in between — which is what lets the frame loop animate the
// notch ring, its value sweep and the crossfade without advancing a hand.
const t1: DialTime = dialTimeOf(new Date(2026, 0, 1, 10, 30, 15, 250))
const t1Late: DialTime = dialTimeOf(new Date(2026, 0, 1, 10, 30, 15, 999))
check(
  `the reading takes the second boundary, not the milliseconds (${t1.second})`,
  t1.second === 15 && t1Late.second === 15,
)
check(
  "two readings inside one second paint the SAME angle",
  near(secondHandAngle(t1), secondHandAngle(t1Late)),
)
check(
  "the minute hand carries the seconds, the hour hand the minutes",
  near(t1.minute, 30 + 15 / 60) && near(t1.hour, (10 % 12) + t1.minute / 60),
)
const frameAngles = new Set<number>()
for (let f = 0; f < 30; f++) {
  frameAngles.add(secondHandAngle(dialTimeOf(new Date(2026, 0, 1, 10, 30, 15, f * 33))))
}
check(
  `30 frame repaints inside one second paint ONE angle (${frameAngles.size}) — the hand steps, it never sweeps`,
  frameAngles.size === 1,
)
check(
  "the next second advances the hand by exactly 2π/60",
  near(
    secondHandAngle(dialTimeOf(new Date(2026, 0, 1, 10, 30, 16, 0))) - secondHandAngle(t1),
    (Math.PI * 2) / 60,
  ),
)
const padded = dialTimeOf(new Date(2026, 0, 1, 9, 5, 0, 0))
check(
  `the digital text rides the same reading (${padded.hh}:${padded.mm})`,
  padded.hh === "09" && padded.mm === "05",
)
const stampBefore = new Date()
const freshDial = dialTimeOf(new Date())
const stampAfter = new Date()
check(
  `a fresh stamp is the CURRENT second (${freshDial.second})`,
  freshDial.second === stampBefore.getSeconds() || freshDial.second === stampAfter.getSeconds(),
)

// ── The battery colour table: the SAME policy the clock's charge notches and the
// battery applet's ring both colour a reading through. A fixture palette gives
// every token a distinctive triple, so a returned colour names its branch. ──

const PALETTE: Record<string, ConfigColour> = {
  charging: { rgb: [1, 0, 0], alpha: 0.9 },
  plugged: { rgb: [0, 1, 0], alpha: 0.9 },
  ok: { rgb: [0, 0, 1], alpha: 0.9 },
  warn: { rgb: [1, 1, 0], alpha: 0.9 },
  low: { rgb: [1, 0, 1], alpha: 0.9 },
  cap: { rgb: [0.5, 0.5, 0.5], alpha: 0.85 },
}
const PALETTE_WITHOUT_PLUGGED: Record<string, ConfigColour> = {
  charging: PALETTE.charging,
  ok: PALETTE.ok,
  warn: PALETTE.warn,
  low: PALETTE.low,
  cap: PALETTE.cap,
}
/** The same palette with no reserved-span token: the open map a config written
 *  before `cap` existed resolves to. */
const PALETTE_WITHOUT_CAP: Record<string, ConfigColour> = {
  charging: PALETTE.charging,
  plugged: PALETTE.plugged,
  ok: PALETTE.ok,
  warn: PALETTE.warn,
  low: PALETTE.low,
}
const COL_THRESHOLDS = { batteryLow: 15, batteryWarn: 30 }

function tokenOf(c: ConfigColour, palette: Record<string, ConfigColour> = PALETTE): string {
  for (const [name, entry] of Object.entries(palette)) {
    if (entry.rgb[0] === c.rgb[0] && entry.rgb[1] === c.rgb[1] && entry.rgb[2] === c.rgb[2])
      return name
  }
  return `unknown(${c.rgb.join(",")})`
}

function colourOf(status: string, percentage: number, palette = PALETTE): string {
  return tokenOf(batteryRingColour({ percentage, status }, COL_THRESHOLDS, palette), palette)
}

check("Charging wins at every level (100)", colourOf("Charging", 100) === "charging")
check(
  "Charging wins at every level (below the low threshold)",
  colourOf("Charging", 5) === "charging",
)
for (const status of ["Full", "Not charging"]) {
  check(`${status} at 100 takes the plugged colour`, colourOf(status, 100) === "plugged")
  check(`${status} below the low threshold stays plugged`, colourOf(status, 10) === "plugged")
}
check("Discharging at 31 is ok, above the warn threshold", colourOf("Discharging", 31) === "ok")
check("Discharging at 30 is warn, the threshold itself", colourOf("Discharging", 30) === "warn")
check("Discharging at 16 is warn, above the low threshold", colourOf("Discharging", 16) === "warn")
check("Discharging at 15 is low, the threshold itself", colourOf("Discharging", 15) === "low")
check("Discharging at 0 is low", colourOf("Discharging", 0) === "low")
check("an unknown STATUS keeps its level colour, never plugged", colourOf("Unknown", 50) === "ok")
check("the pre-poll seed (Unknown, 100 %) is a level colour", colourOf("Unknown", 100) === "ok")
check("a percentage above 100 clamps to ok", colourOf("Discharging", 140) === "ok")
check("a negative percentage clamps to low", colourOf("Discharging", -5) === "low")
check(
  "a config without the plugged token falls back to the level colour",
  colourOf("Full", 100, PALETTE_WITHOUT_PLUGGED) === "ok" &&
    colourOf("Not charging", 25, PALETTE_WITHOUT_PLUGGED) === "warn",
)

// The token the surfaces actually read: the LIVE dock config (defaults merged
// with the user's file), not the fixture. Purple is red + blue with green below
// both, and the plugged token carries the same alpha as its siblings.
const liveBatteryColours = config.appearance.ringColours.battery
const livePlugged = liveBatteryColours.plugged
check("the live config carries a plugged battery token", livePlugged !== undefined)
if (livePlugged) {
  const [r, g, bl] = livePlugged.rgb
  check(`the plugged token is a purple (rgb ${r}, ${g}, ${bl})`, r > g && bl > g && bl >= r)
  check(
    "the plugged token matches its siblings' alpha",
    livePlugged.alpha === liveBatteryColours.charging.alpha,
  )
  check(
    "the live plugged token is the colour a plugged-idle reading resolves to",
    tokenOf(
      batteryRingColour(
        { percentage: 80, status: "Not charging" },
        COL_THRESHOLDS,
        liveBatteryColours,
      ),
      liveBatteryColours,
    ) === "plugged",
  )
}

// ── The charge scale's bands: the shared policy is what colours the run ──
// The charge run's colours are not decided here: `batteryRingBands` — the policy
// the battery applet's ring renders through — splits the reading at the machine's
// charge limit, and the run colours each lit marker by its own threshold. These
// checks pin that split at the clock's own boundaries, then the run it produces.

const SLOTS = notchTicks(COUNT, 3).length
const chargeBands = (status: string, percentage: number, cap: number | null): BatteryBand[] =>
  batteryRingBands({ percentage, status }, COL_THRESHOLDS, PALETTE, cap)

check(
  "no readable charge limit paints ONE level band, ending at the reading",
  chargeBands("Discharging", 60, null).length === 1 &&
    chargeBands("Discharging", 60, null)[0].kind === "level" &&
    chargeBands("Discharging", 60, null)[0].end === 60,
)
const reserved = chargeBands("Not charging", 60, 80)
check(
  "a limit above the reading reserves the span up to it in the cap colour",
  reserved.length === 2 &&
    reserved[0].kind === "level" &&
    tokenOf(reserved[0].colour) === "plugged" &&
    reserved[1].kind === "cap" &&
    tokenOf(reserved[1].colour) === "cap" &&
    reserved[1].start === 60 &&
    reserved[1].end === 80,
)
const overcharged = chargeBands("Not charging", 100, 80)
check(
  "a reading ABOVE its limit paints the over-cap span in the charging colour",
  overcharged.length === 2 &&
    overcharged[1].kind === "overcharge" &&
    tokenOf(overcharged[1].colour) === "charging" &&
    overcharged[1].start === 80 &&
    overcharged[1].end === 100,
)
check(
  "...while the span below it keeps the reading's own plugged colour",
  overcharged[0].kind === "level" &&
    overcharged[0].end === 80 &&
    tokenOf(overcharged[0].colour) === "plugged",
)
check(
  "a reading exactly ON its limit paints ONE band (no empty span)",
  chargeBands("Discharging", 80, 80).length === 1,
)
check(
  "a config without the cap token reserves no span (the open-map fallback)",
  batteryRingBands(
    { percentage: 60, status: "Discharging" },
    COL_THRESHOLDS,
    PALETTE_WITHOUT_CAP,
    80,
  ).length === 1,
)

// The run those bands produce: several colours across the lit markers, and null
// past the charge's fraction whatever the bands say.
const overchargedRun = notchRun(100, SLOTS, overcharged)
const overchargedColours = litColours(overchargedRun, SLOTS)
check(
  "the overcharged run paints exactly the two band colours",
  overchargedColours.length === 2 &&
    overchargedColours.includes(`${PALETTE.plugged.rgb.join(",")}@${PALETTE.plugged.alpha}`) &&
    overchargedColours.includes(`${PALETTE.charging.rgb.join(",")}@${PALETTE.charging.alpha}`),
)
{
  // 24/48 slots is the 50 % marker (inside the plugged span), 43/48 the 89.6 %
  // one (past the limit).
  const below = overchargedRun(24)
  const above = overchargedRun(43)
  check(
    "a marker inside the plugged span carries purple; one past the limit carries blue",
    below?.rgb[0] === PALETTE.plugged.rgb[0] && above?.rgb[0] === PALETTE.charging.rgb[0],
  )
}
const litFraction = (value: number): number => Math.floor((value * SLOTS) / 100) + 1
check(
  `the lit run still lights the charge's fraction (${litFraction(90)} of ${SLOTS}) and nothing past it`,
  litMarkerCount(90, SLOTS) === litFraction(90) &&
    notchRun(90, SLOTS, overcharged)(litMarkerCount(90, SLOTS)) === null,
)

// A flat reading below its limit stays ONE colour over the whole lit run — the
// split is the charge limit's business, not the run's.
const pluggedRun = notchRun(80, SLOTS, uniformNotchBands(PALETTE.plugged))
check(
  "a plugged reading below its limit paints one colour over every lit marker",
  litColours(pluggedRun, SLOTS).length === 1 &&
    litColours(pluggedRun, SLOTS)[0] ===
      `${PALETTE.plugged.rgb.join(",")}@${PALETTE.plugged.alpha}`,
)
check(
  "the charging run differs from the plugged run, marker for marker",
  litColours(notchRun(80, SLOTS, uniformNotchBands(PALETTE.charging)), SLOTS)[0] !==
    litColours(pluggedRun, SLOTS)[0],
)

// The startup arithmetic: an UNSEEDED lane paints its initial 0 — the 12 o'clock
// notch alone, in the run's colour — and adoption is what fills the ring, which
// is why the idle tick must arm the loop for an unseeded lane and not only for a
// lane behind a changed reading.
const unseededLane = createNotchSmoother(null)
check(
  "a fresh idle lane is unseeded and paints exactly ONE marker",
  !unseededLane.seeded && litMarkerCount(unseededLane.value, SLOTS) === 1,
)
{
  const run = notchRun(unseededLane.value, SLOTS, uniformNotchBands(PALETTE.plugged))
  check(
    "...so its run lights the 12 o'clock notch alone, in the plugged colour",
    run(0) !== null && run(0)?.rgb[0] === PALETTE.plugged.rgb[0] && run(1) === null,
  )
}
check(
  "the first reading ADOPTS (no sweep) and seeds the lane",
  !unseededLane.advance(80) && unseededLane.seeded && unseededLane.value === 80,
)
check(
  `the seeded lane's run lights the charge's fraction (${litMarkerCount(unseededLane.value, SLOTS)} of ${SLOTS})`,
  litMarkerCount(unseededLane.value, SLOTS) === litFraction(80),
)
check(
  "an unseeded lane is behind nothing, which is why the tick arms on `seeded` too",
  createNotchSmoother(null).behind(80) === false && createNotchSmoother(null).seeded === false,
)

// ── The applet built with NO row: the degrade path ──
// The dock sets a row before constructing this applet, so the branch that paints a
// plain disc instead is the applet's fallback for the case it does not. That branch
// touches no row API, which is what makes it checkable without a window: a fake
// icon records the painter it installs, and the painter is invoked with a recording
// cairo context.

const drawCalls: string[] = []
let installed: ((...a: any[]) => void) | null = null
const fakeAw: any = {
  row: null,
  icon: {
    set_draw_func: (fn: (...a: any[]) => void): void => {
      installed = fn
    },
  },
}
let buildThrew: string | null = null
try {
  OverflowApplet(fakeAw, {} as any)
} catch (e) {
  buildThrew = String(e)
}
check(`the applet builds with no row (${buildThrew ?? "no throw"})`, buildThrew === null)
check("and installs a painter on the icon", typeof installed === "function")

if (typeof installed === "function") {
  const cr: any = {
    setSourceRGBA: (...a: number[]): void => void drawCalls.push(`setSourceRGBA(${a.length})`),
    arc: (cx: number, cy: number, r: number): void => void drawCalls.push(`arc(${cx},${cy},${r})`),
    fill: (): void => void drawCalls.push("fill"),
  }
  try {
    ;(installed as any)(null, cr, 40, 20)
  } catch (e) {
    drawCalls.push(`throw:${String(e)}`)
  }
}
check(
  `the painter fills a disc sized to the smaller side (${drawCalls.join(" ") || "nothing painted"})`,
  drawCalls.includes("arc(10,10,10)") && drawCalls.includes("fill"),
)

console.log()
if (failures.length > 0) {
  console.log(`FAIL — ${failures.length} violated invariant(s):`)
  for (const f of failures) console.log(`  - ${f}`)
  imports.system.exit(1)
}
console.log(
  `OK — the marker scale holds at all ${cases.length} documented boundaries, the two-tier scale lights the sub-ticks between the majors without moving or re-thresholding one of them (0 sub-ticks per gap reproduces the majors-only scale), the run the dial declares carries its lit fraction where the fade mechanism's string form sees it and its BANDS — spans and colours, alpha included — as the whole of the identity it fades on, so a lit-fraction change adopts at once while a colour or span change cross-fades (an unchanged run moving neither, and the bands round-tripping out of the painted state), the notch value eases to its reading with the applet rings' own shape (adopting the first reading, sweeping through intermediate lit fractions) and settles exactly on it, a fresh lane adopts its first reading so the run paints the whole charge fraction instead of its initial single marker, the charge scale's bands split the reading at the machine's charge limit (the level span, the reserved cap span, and the over-cap span in the charging colour) so one run paints several colours across its lit markers while a flat reading below its limit stays one colour, the frame loop runs for a transition in flight, for an easing lit fraction and for a live reading on a visible clock and for neither else, the idle tick's KIND is read from the clock's intended visibility (a pending fade's target, never the fade a tween has not moved yet, so a reappear fade cannot arm the hidden watchdog), the lane adopts a fresh process's first reading (a full-brightness 100 % included) and shows the first adjustment after it in both the fresh and the rebuilt lane, the hands step one whole second per second off a single pinned reading (no frame repaint can move them), the battery colour policy holds for charging, for plugged-and-idle (Full / Not charging at any level), for the level colour on every other status including an unknown one, at both level boundaries and in the missing-token fallback, and the clock's timings and sub-tick count are live config`,
)
imports.system.exit(0)
