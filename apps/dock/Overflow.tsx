import GLib from "gi://GLib"
import { easeQuadInOut } from "@common/anim/easings"
import { type FrameRunner, runFrames } from "@common/anim/run-frames"
import type { AppletWindow } from "@common/applets/applet-window"
import type { AppletBackend } from "@common/applets/backend"
import { batteryRingColour, type ConfigColour } from "@common/applets/shared/battery-colour"
import { createStepApplet } from "@common/applets/shared/create-step-applet"
import { clamp01, drawDisc, drawGlyph } from "@common/applets/shared/draw-utils"
import { createElementFade, withFadeAlpha } from "@common/applets/shared/element-fade"
import type { DrawIcon } from "@common/applets/types"
import { volumeRingColour } from "@common/applets/volume/colour"
import { Gtk } from "ags/gtk4"
import { onCleanup } from "gnim"
import { config, dock } from "./config"
import type { DockRow } from "./dock-row"

// ── Clock-state snapshot registry (debug/repro) ──
// The overflow clock's visibility is `active = isMoveMode || isRevealed ||
// panelToggled || cursorInOverflow`, live-recomputed from the row + the
// surface-routed hover listeners. All of it is applet-local and otherwise
// unobservable without a real pointer. Mirroring the surface route + map-guard
// repro hooks, each overflow applet registers a snapshot so `dock debug
// overflow route` can assert the clock state after a synthetic hover cycle.
interface OverflowClockHook {
  snapshot: () => {
    active: boolean
    moveMode: boolean
    revealed: boolean
    panelToggled: boolean
    cursorInOverflow: boolean
    fade: number
    reappearPending: boolean
  }
}
const overflowClockHooks = new Map<string, OverflowClockHook>()
export function overflowClockHooksAll(): OverflowClockHook[] {
  return [...overflowClockHooks.values()]
}

/**
 * The overflow applet — the last slot in the dock row. Its icon is a caret
 * glyph (config appearance.icons.overflow); hovering it opens a 4-step pill
 * AND reveals all parked hidden applets alongside the row (see dock-row.ts
 * for the reveal session state machine).
 *
 * The caret is Cairo-rotated to communicate the reveal state: at rest it
 * points perpendicular to the row into the screen (the dock's grow
 * direction); when the reveal session opens it swings 90° (over
 * timing.appearAnim, driven by dock-row.ts, read here through the row's
 * `overflowCaretRot()`) to face the reading-order direction the hidden icons
 * appear from, and swings back on collapse / rebuild teardown. The glyph's
 * shadow is drawn at
 * a SCREEN-space offset (the offset does not swing with the rotation — it
 * stays down-right while the caret turns).
 *
 * Steps:
 *   0 Hide all — force every applet into overflow.
 *   1 Show all — force every applet into the dock.
 *   2 Auto   — status rules drive overflow (wifi/bt/media by
 *     status).
 *   3 Move   — move mode: the dock shrinks to just this icon, which becomes
 *     immediately draggable (a GestureDrag); on release it magnet-snaps to
 *     the nearest of the 12 positions and commits the position. A
 *     double-click (a GestureClick's n_press >= 2 — GTK 4.22.4 gestures do
 *     not claim sequences, so click + drag coexist) exits move mode
 *     immediately (see dock-row.ts enterMoveMode/commitMove).
 *
 * The panel stays open after selecting a mode (like Media); Move
 * closes it instantly (move mode freezes everything). The move gestures are
 * attached ONLY while move mode is active, via the row's move-mode listener —
 * no gesture controller lingers in normal mode.
 */

const MODE_STEP: Record<string, number> = { auto: 2, show: 1, hide: 0 }

const DBG = !!GLib.getenv("DOCK_DEBUG")

/** A radial notch on the disc's outer edge: a short thick-ish line segment
 *  from radius r1 to r2 at `angle`, round-capped. Used by the clock (hour +
 *  minute + second hands riding the disc's circumference). `fade` (0..1)
 *  scales the colour alpha (the clock's pillAnim in/out). */
function drawNotch(
  cr: any,
  cx: number,
  cy: number,
  angle: number,
  r1: number,
  r2: number,
  thickness: number,
  colour: { rgb: number[]; alpha: number },
  fade = 1,
): void {
  cr.save()
  cr.setLineWidth(thickness)
  cr.setLineCap(1) // CAIRO_LINE_CAP_ROUND
  cr.setSourceRGBA(
    colour.rgb[0],
    colour.rgb[1],
    colour.rgb[2],
    colour.alpha * Math.max(0, Math.min(1, fade)),
  )
  cr.moveTo(cx + r1 * Math.cos(angle), cy + r1 * Math.sin(angle))
  cr.lineTo(cx + r2 * Math.cos(angle), cy + r2 * Math.sin(angle))
  cr.stroke()
  cr.restore()
}

/** The dial's rim markers: 12 five-minute ticks on the tick dials (analogue +
 *  digital). Every marker threshold is derived from this count, never from a
 *  constant baked into the arithmetic, so the ring rescales itself if it
 *  changes. */
const RIM_MARKER_COUNT = 12

/** Markers lit for `value` (0..100) on a `count`-marker dial. A value at or
 *  below 0 still lights one marker (the 12 o'clock one) and a value at or above
 *  100 lights every marker, so a dial never reads as dead or as overrun; a
 *  non-finite value counts as 0. */
export function litMarkerCount(value: number, count: number): number {
  const n = Math.floor(count)
  if (n <= 0) return 0
  const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
  return Math.min(n, Math.floor((pct * n) / 100) + 1)
}

/** The dial's rim-marker scale — ONE value + ONE colour → a notch run. Marker i
 *  (0 at 12 o'clock, clockwise) lights once the value REACHES its threshold
 *  `i·100/count`: 12 o'clock at 0 %, 1 o'clock at 8.33 %, the 11 o'clock marker
 *  at 91.67 %. A marker the value has not reached answers null, so the caller
 *  paints its own idle colour there.
 *
 * Every ring readout goes through it: the battery charge in the overflow `hide`
 * mode (the battery icon is parked, so the markers double as the charge scale)
 * and the transient volume/brightness value shown while one of them is being
 * adjusted. Pure — no cairo, no config.
 *
 * `count` is the number of ticks the ring PAINTS, indexed 0..count-1 clockwise
 * from 12 o'clock: the 12 majors on a majors-only scale, or the whole two-tier
 * scale's slot count (`notchTicks`). A major sits at slot `i·(minorPerGap+1)`
 * and slot `s` lights once the value reaches `s·100/count`, so the majors light
 * at exactly the thresholds they light at on the majors-only scale — the
 * sub-ticks only fill in between them. */
export function notchRun(
  value: number,
  count: number,
  colour: ConfigColour,
): (i: number) => ConfigColour | null {
  const lit = litMarkerCount(value, count)
  return (i: number) => (i < lit ? colour : null)
}

/** One tick of the dial's two-tier scale, in slot order clockwise from 12
 *  o'clock. `major` is a rim marker: the minors never move it, resize it or
 *  recolour it — the two tiers are ONE run over ONE ring, so the value lights
 *  the sub-ticks with the same colour policy the majors already use. */
interface NotchTick {
  /** The tick's index on the ring — the index `notchRun` answers for it. */
  slot: number
  major: boolean
}

/** The dial's two-tier scale: `count` majors, each adjacent pair separated by
 *  `minorPerGap` sub-ticks (0 = the majors alone). Every slot is evenly spaced
 *  on one circle, so major `i` keeps the angle AND the threshold it has on a
 *  majors-only scale while the sub-ticks divide its step finer. Pure — the
 *  renderer walks this list, the probe pins it. */
export function notchTicks(count: number, minorPerGap: number): NotchTick[] {
  const n = Math.floor(count)
  if (n <= 0) return []
  const gap = Math.max(0, Math.floor(minorPerGap)) + 1
  const ticks: NotchTick[] = []
  for (let slot = 0; slot < n * gap; slot++) ticks.push({ slot, major: slot % gap === 0 })
  return ticks
}

/** The dial's painted run — the lit fraction it is scaled by and the COLOUR it
 *  paints — in the shape the declared fade element's state must be: an ARRAY,
 *  because the shared mechanism keys a change on the state's own string form.
 *  `key` is the identity that mechanism fades on — the COLOUR alone — so a
 *  change of the lit fraction alone (a charge step, a slider step) adopts at
 *  once and stays the value sweep's business, while a change of colour
 *  cross-fades. Pure. */
interface NotchRun {
  state: [number, number, number, number, number]
  key: string
}

/** The run the dial paints: `value` is the lit fraction, `colour` the colour
 *  every notch the run lights carries. Pure — the probe drives it. */
export function notchRunState(value: number, colour: ConfigColour): NotchRun {
  const [r, g, b] = colour.rgb
  return { state: [value, r, g, b, colour.alpha], key: `${r},${g},${b},${colour.alpha}` }
}

/** The transient lane's state: the reading the readout compares against. It is
 *  the domain's value AT MOUNT when that value is a real reading (a dock row
 *  REBUILD leaves the domains already bound), and null for a source with no
 *  reading yet — a fresh process's volume domain answers `available: false`
 *  until WirePlumber has bound the sink, so its lane opens empty and adopts the
 *  first reading the domain publishes. A reading equal to the baseline shows
 *  nothing (a subscription firing again, or a change in a field the readout does
 *  not paint); anything else is an adjustment and paints. Only the domain judges
 *  readiness — it publishes no reading before the sink is bound, so the lane
 *  needs no settling rule of its own. */
export interface TransientLane {
  baseline: number | null
}

/** The lane's decision for one reading: the next lane state, and the value to
 *  show (null = adopt the reading silently). Pure — the probe drives it. */
export function transientStep(
  lane: TransientLane,
  reading: number,
): { lane: TransientLane; show: number | null } {
  // No reading yet: this one becomes the baseline, adopted, never shown.
  if (lane.baseline === null) return { lane: { baseline: reading }, show: null }
  // The value the lane already holds — a subscription firing for it, or a change
  // in a field the readout does not paint (a mute, a device class).
  if (reading === lane.baseline) return { lane, show: null }
  // An adjustment.
  return { lane: { baseline: reading }, show: reading }
}

/** A small filled circle (the clock's five-minute marker dots). `fade` (0..1)
 *  scales the colour alpha (the clock's pillAnim in/out). */
function drawDot(
  cr: any,
  cx: number,
  cy: number,
  radius: number,
  colour: { rgb: number[]; alpha: number },
  fade = 1,
): void {
  cr.setSourceRGBA(
    colour.rgb[0],
    colour.rgb[1],
    colour.rgb[2],
    colour.alpha * Math.max(0, Math.min(1, fade)),
  )
  cr.arc(cx, cy, radius, 0, Math.PI * 2)
  cr.fill()
}

/** Clock geometry — hard-coded ratios of the tuned 36px look, scaled by the
 *  disc radius r (= iconSize/2) so every element grows proportionally with
 *  `config.layout.iconSize`. Values are fractions of r: the dot centres sit
 *  near the rim (16/18), the hands are length-ordered hour < minute <
 *  second, 50% longer than the original notches, with outer tips kept INSIDE
 *  the disc (r2 + round-cap t/2 ≤ 18/18 − 0.5px — the caps must not poke
 *  past the icon border): hour 11→15.5, minute 10→16, second 10.2→16.5, with
 *  thicknesses 3/18·r, 2/18·r, 1.275/18·r — the second hand is the thinnest,
 *  chronograph-red so it reads as the timing hand. */
const CLOCK_GEOM = {
  dotCentre: 16 / 18,
  dotRadius: (1.3 * 0.75) / 18,
  centreDot: 3 / 18,
  hour: { r1: 11 / 18, r2: 15.5 / 18, t: 3 / 18 },
  minute: { r1: 10 / 18, r2: 16 / 18, t: 2 / 18 },
  second: { r1: 10.2 / 18, r2: 16.5 / 18, t: 1.275 / 18 },
  /** Rim tick marks (12, every 5 minutes): short radial lines (the clean mode
   *  keeps dots, drawRimDots). Width-matched to the second hand (t 1.275/18);
   *  geometric length 1.5/18 so that WITH the round
   *  caps
   *  (+t/2 each end) the visual bar is ~2.8/18 — 2.2x its width: reads as a
   *  short LINE, still hugging the rim instead of radiating inward like a
   *  sunburst (2.5/18 crowded the digits). Outer tip 16.5/18 matches the
   *  second hand's tip; cap-included reach 17.14/18 stays inside the 17.5/18
   *  border margin. */
  tick: { r1: 15 / 18, r2: 16.5 / 18, t: 1.275 / 18 },
}

/** The MINOR sub-ticks — the ticks BETWEEN adjacent rim markers (see
 *  `notchTicks`). Four knobs, all fractions of the disc radius r except the
 *  alpha, which scales the finished tick colour (lit AND unlit, so the two
 *  tiers keep their contrast at every crossfade fraction):
 *
 *  - `inset`  inner radius — where the sub-tick starts; larger pulls the whole
 *             tick closer to the rim.
 *  - `length` the tick's drawn length; the outer radius is `inset + length`
 *             (round caps add t/2 at each end: 2.2x its own width, so it still
 *             reads as a short LINE rather than a dot).
 *  - `t`      stroke width.
 *  - `alpha`  how far under the majors it reads.
 *
 *  Counted so the outer tip stays inside the majors' tip (16.5/18) and the
 *  cap-included reach stays inside the 17.5/18 border margin. */
const MINOR_TICK = {
  inset: 15.5 / 18,
  length: 0.85 / 18,
  t: 0.7 / 18,
  alpha: 0.65,
}

/** The dial's pinned time: the ONE reading every repaint paints. `second` is
 *  the SECOND BOUNDARY — an integer — so the hand's angle is constant for a
 *  whole second however many frames repaint the dial in between. */
export interface DialTime {
  second: number
  minute: number
  hour: number
  /** Zero-padded local clock text — the digital dial's two lines. */
  hh: string
  mm: string
}

/** The reading a `Date` pins: the second boundary (milliseconds deliberately
 *  ignored — the hand steps, it never sweeps), the minute hand carrying the
 *  seconds, the hour hand the minutes. */
export function dialTimeOf(date: Date): DialTime {
  const second = date.getSeconds()
  const minute = date.getMinutes() + second / 60
  const hour = (date.getHours() % 12) + minute / 60
  return {
    second,
    minute,
    hour,
    hh: String(date.getHours()).padStart(2, "0"),
    mm: String(date.getMinutes()).padStart(2, "0"),
  }
}

/** The second hand's angle for a pinned reading (12 o'clock = -π/2). */
export function secondHandAngle(t: DialTime): number {
  return -Math.PI / 2 + t.second * ((Math.PI * 2) / 60)
}

/** The smooth repaint rate while a transient volume/brightness reading is live —
 *  60 fps. The clock's frame loop is frame-synced, so this is the rate it admits
 *  a frame at: a panel at or below it paints every frame it gets, a faster one is
 *  held to the declared rate. It is the knob for the transient window's
 *  smoothness against its cost, and the only rate the clock ever paints at,
 *  because the loop runs only while something is animating (`smoothLoopRuns`).
 *  The idle path never reads it: idle repaint is the `timing.clockTickMs` tick. */
export const CLOCK_SMOOTH_FPS = 60

/** Slack subtracted from a nominal frame at `CLOCK_SMOOTH_FPS`. A 60 Hz frame
 *  clock's own deltas land a hair UNDER 16.67 ms, and a strict frame budget
 *  would then refuse every one of them — one paint per two frames, i.e. judder. */
const SMOOTH_FRAME_SLACK_US = 1000

/** The frame budget `fps` admits, in microseconds. Pure — the probe pins it. */
export function smoothFrameBudgetUs(fps: number): number {
  return 1_000_000 / fps - SMOOTH_FRAME_SLACK_US
}

/** Whether the clock's frame loop is still needed: while a transition is in
 *  flight, while the notch scale's lit fraction is still easing toward its
 *  reading, or while a transient reading is live on a VISIBLE clock — a hidden
 *  clock paints nothing, so its smooth window is not worth the frames. False
 *  means the loop stops and the clock is back on its idle tick: an ordinary
 *  battery update therefore buys a BOUNDED sweep, never a running loop. Pure
 *  policy. */
export function smoothLoopRuns(state: {
  animating: boolean
  easing: boolean
  transient: boolean
  clockVisible: boolean
}): boolean {
  return state.animating || ((state.easing || state.transient) && state.clockVisible)
}

/** The notch scale's per-frame approach to its reading — the shape the applet
 *  rings animate with (the closed-state ring smoothing in
 *  `common/applets/shared/create-applet-core.ts`: a frame moves
 *  `ringValue += diff * 0.3` and the sweep settles under 0.3). Mirrored here
 *  VERBATIM rather than shared: that mechanism is an inline closure inside the
 *  applet core's factory, not an exported primitive, and it belongs to another
 *  file. The two factors below are that shape's, not new ones. */
export const NOTCH_SMOOTH_FACTOR = 0.3
export const NOTCH_SMOOTH_EPSILON = 0.3

interface NotchSmoother {
  /** The value to paint: the eased value, snapped to its reading once settled. */
  readonly value: number
  /** True while a frame still moved it — the frame loop has work to do. */
  readonly moving: boolean
  /** True once a reading has been adopted. False only before the lane's first
   *  reading, when `behind` answers false for EVERY value — a caller that arms
   *  a frame loop on `behind` alone therefore never seeds a fresh lane. */
  readonly seeded: boolean
  /** True when it is not yet on `reading` (false before its first reading). */
  behind: (reading: number) => boolean
  /** Advance one frame toward `reading`. False once settled on it. */
  advance: (reading: number) => boolean
  /** Land on `reading` at once, no sweep (a transition that animates another
   *  way — the source crossfade — must not sweep the value as well). */
  adopt: (reading: number) => void
}

/** One frame moves a fraction of what is left, so a sweep's length scales with
 *  the size of the change; the value SNAPS to the reading as it settles, so a
 *  caller that stops its loop on the false return knows the lit fraction is
 *  exactly the reading's. `initial: null` = no reading yet: the first `advance`
 *  ADOPTS it instead of sweeping from a made-up value. Pure — the probe drives
 *  it. */
export function createNotchSmoother(initial: number | null): NotchSmoother {
  let value = initial ?? 0
  let seeded = initial !== null
  let moving = false
  return {
    get value() {
      return value
    },
    get moving() {
      return moving
    },
    get seeded() {
      return seeded
    },
    behind: (reading) => seeded && Math.abs(reading - value) >= NOTCH_SMOOTH_EPSILON,
    advance: (reading) => {
      if (!seeded) {
        seeded = true
        value = reading
        moving = false
        return false
      }
      const diff = reading - value
      if (Math.abs(diff) < NOTCH_SMOOTH_EPSILON) {
        value = reading
        moving = false
        return false
      }
      value += diff * NOTCH_SMOOTH_FACTOR
      moving = true
      return true
    },
    adopt: (reading) => {
      seeded = true
      value = reading
      moving = false
    },
  }
}

/** Clean-mode geometry: 4 cardinal dots instead of 12, and a deliberately
 *  length/thickness-contrasted hour+minute pair. A 4.5px vs 6px hand-length
 *  gap reads as IDENTICAL at 36px; here the hour is SHORT + THICK (r1
 *  12→15, t 4/18) and the minute LONG + THIN (r1 8→16.5, t 1.8/18) so the
 *  contrast is unambiguous. No second hand — only hour+minute are needed.
 *  Values are fractions of r (= iconSize/2). */
const CLEAN_GEOM = {
  dotCentre: 16 / 18,
  dotRadius: (1.5 * 0.75) / 18,
  centreDot: 3 / 18,
  hour: { r1: 12 / 18, r2: 15 / 18, t: 4 / 18 },
  minute: { r1: 8 / 18, r2: 16.5 / 18, t: 1.8 / 18 },
}

export default function OverflowApplet(aw: AppletWindow<DockRow>, backend: AppletBackend) {
  const row = aw.row!
  if (!row) {
    // Shouldn't happen (Dock.tsx always sets the row before constructing),
    // but degrade to a plain non-interactive disc rather than crashing.
    aw.icon.set_draw_func((_, cr, w, h) => {
      const size = Math.min(w, h)
      drawDisc(config, cr, size / 2, size / 2, size / 2)
    })
    return
  }

  // Caret glyph rotated by the row's live caret angle (0 = resting
  // caret-up). The rotation is applied around the disc centre. The SHADOW is
  // drawn separately at a screen-space offset (translate BEFORE rotate), so
  // the offset stays down-right in screen space while the caret swings —
  // drawing it inside the rotated context would swing the offset with the
  // glyph.
  const drawOverflowIcon: DrawIcon = (
    cr,
    w,
    h,
    _value,
    _state,
    ringFill = 1,
    _skipDisc,
    _textValue,
  ) => {
    const rf = clamp01(ringFill)
    const size = Math.min(w, h)
    const cx = size / 2
    const cy = size / 2
    drawDisc(config, cr, cx, cy, size / 2)
    const gc = config.appearance.glyphColour
    const sh = config.appearance.textShadow
    const rot = row.overflowCaretRot()
    const glyph = config.appearance.icons.overflow
    const fs = config.fonts.iconSize
    const family = config.fonts.family
    // Recording attention: the caret blinks red (soft pulse, the same render
    // value as the screengrab icon) when a recording applet is parked in overflow.
    const attention = aw.render.attention
    // Latch the recording phase: once attention is active, stay "recording"
    // until the row clears the value to exactly 0 (the blink tick stops).
    // The pulse is a sine that dips to ~1e-16 at the trough — a raw
    // `> 0.001` threshold flipped the caret/dot to their WHITE variants for
    // a frame or two every blink cycle. The latch makes that impossible.
    if (attention > 0.001) recordingLatch = true
    else if (attention <= 0) recordingLatch = false
    const recording = recordingLatch
    const rc = config.appearance.recordingColour
    // As the clock fades in, the caret glyph cross-fades into the centre
    // dot (which keeps the glyph's screen-space shadow — the morph preserves
    // depth). The morph runs even while recording so the readout shows ONE
    // blinking-red element, never caret+dot together.
    const clockOn = config.appearance.clock.enabled && clockFade > 0.001
    const caretFade = clockOn ? 1 - clockFade : 1
    const colour: [number, number, number, number] = recording
      ? [rc.rgb[0], rc.rgb[1], rc.rgb[2], gc.alpha * rf * caretFade * (0.3 + 0.7 * attention)]
      : [gc.rgb[0], gc.rgb[1], gc.rgb[2], gc.alpha * rf * caretFade]
    const shadowAlpha = sh.alpha * rf * caretFade

    // Shadow: rotated glyph at a screen-space offset (stays down-right).
    if (shadowAlpha > 0.001) {
      cr.save()
      cr.translate(cx + sh.offset, cy + sh.offset)
      cr.rotate(rot)
      drawGlyph(
        config,
        cr,
        0,
        0,
        glyph,
        fs,
        recording
          ? [rc.rgb[0], rc.rgb[1], rc.rgb[2], shadowAlpha * 0.5]
          : [sh.rgb[0], sh.rgb[1], sh.rgb[2], shadowAlpha],
        family,
        0,
      )
      cr.restore()
    }
    // Main glyph: rotated, centred.
    cr.save()
    cr.translate(cx, cy)
    cr.rotate(rot)
    drawGlyph(config, cr, 0, 0, glyph, fs, colour, family, 0)
    cr.restore()

    // Clock: 12 five-minute dots + hour/minute/second hands riding the
    // disc's outer edge, rotating radially (12 o'clock = -π/2). Hidden on
    // hover / panel / reveal / move mode, and re-appearing `reappearMs` after
    // the last interaction. The hands ride the clock's pinned reading (see
    // `DialTime`): one step per second, whatever repaints the dial in between.
    //
    // As the clock fades in, the caret glyph cross-fades into a centre dot
    // (which keeps the glyph's screen-space shadow — the morph preserves
    // depth). The morph runs while recording too: exactly ONE blinking-red
    // element at a time — the caret in dock view, the centre dot in clock
    // view, a crossfade between them (caretFade applies to the red caret).
    if (clockOn) {
      // The hands read the PINNED dial time, never the wall clock: the 1 s tick
      // is the only thing that advances it, so every other repaint — a fade
      // frame, the transient readout, a config change — paints the hand already
      // on screen instead of jumping it forward.
      const min = dialTime.minute
      const hour = dialTime.hour
      const r = size / 2
      const fade = Math.max(0, Math.min(1, clockFade))
      const clk = config.appearance.clock
      const mode = clk.mode ?? "analogue"
      // The two-tier scale: `appearance.clock.minorTicksPerGap` sub-ticks
      // between adjacent majors (0 = majors alone). The scale is ONE ring, so
      // every slot — major and minor alike — is a tick of ONE run: the lit
      // fraction is computed over the slot count below, which is what gives the
      // ring its finer granularity without moving a single major.
      const scaleTicks = notchTicks(RIM_MARKER_COUNT, clk.minorTicksPerGap ?? 0)
      const scaleSlots = scaleTicks.length
      const {
        hour: hourColour,
        minute: minuteColour,
        second: secondColour,
        dot: dotColour,
        centre: centreColour,
      } = clk
      // Battery notches: in the overflow "hide" mode every other applet is
      // parked, so the battery icon is not on the row and the dial's rim
      // markers double as the charge readout. The charge is coloured by the
      // policy every battery surface renders through
      // (common/applets/shared/battery-colour: charging, plugged while AC is
      // present with the pack neither filling nor draining, else the level's
      // warn / low / ok) and turned into lit markers by `notchRun` — the dial's
      // ONE scale. The policy is handed the WHOLE reading (status included), so
      // the plugged state reaches the dial without a decision of its own here.
      // A depleted marker keeps the clock's dot colour. Tick dials
      // only (analogue + digital) — clean mode's 4 cardinal dots carry no such
      // scale.
      const batteryNotches = batteryScaleUp()
      const batteryState = batteryNotches
        ? backend.battery.batteryState(config.timing.poll.batteryPower).peek()
        : null
      /** The colour the battery policy paints this reading with — the colour the
       *  idle scale's charge run carries, and part of the state the dial's fade
       *  element is fed. */
      const batteryColour = batteryState
        ? batteryRingColour(
            batteryState,
            config.appearance.thresholds,
            config.appearance.ringColours.battery,
          )
        : null
      // The dial paints ONE run of rim notches: the idle scale's charge run, or
      // the transient volume/brightness reading while one is being adjusted. Its
      // colour is the charge policy's in the first case and the adjusting
      // applet's own ring colour in the second; its lit fraction is the run's
      // own painted value.
      //
      // The run — either one — belongs to the overflow `hide` mode alone: that
      // mode parks every other applet, so the dial is the only readout, while in
      // `auto`/`show` the volume and brightness applets are on the row and a
      // coloured notch would only repeat what is already visible. Read per
      // paint, so a mode switch takes effect on the next frame whatever the
      // transient lane still holds.
      const notchesUp = hideMode()
      let run: NotchRun | null = null
      if (notchesUp) {
        if (transient !== null) run = notchRunState(transientSmoother.value, transient.colour)
        else if (batteryColour !== null) run = notchRunState(batterySmoother.value, batteryColour)
      }
      // Every clock element (the 12 dots, the three hands, the centre dot)
      // carries the same screen-space shadow the caret glyph uses
      // (appearance.textShadow, down-right offset): the shadow is drawn
      // FIRST at the offset, then the real element over it. The offset is a
      // plain translate — NOT a radial shift — so the shadow stays fixed
      // down-right in screen space while the hands sweep, exactly like the
      // glyph shadow stays put while the caret rotates.
      const shadowColour = { rgb: sh.rgb, alpha: sh.alpha }
      const drawShadowedDot = (
        x: number,
        y: number,
        radius: number,
        colour: { rgb: number[]; alpha: number },
      ) => {
        drawDot(cr, x + sh.offset, y + sh.offset, radius, shadowColour, fade)
        drawDot(cr, x, y, radius, colour, fade)
      }
      const drawShadowedNotch = (
        angle: number,
        r1: number,
        r2: number,
        thickness: number,
        colour: { rgb: number[]; alpha: number },
      ) => {
        drawNotch(cr, cx + sh.offset, cy + sh.offset, angle, r1, r2, thickness, shadowColour, fade)
        drawNotch(cr, cx, cy, angle, r1, r2, thickness, colour, fade)
      }
      // The dial's tick scale, shared by every mode: the slots of `notchTicks`
      // (analogue 12 five-minute majors with their sub-ticks, digital borrows
      // the analogue dial, clean keeps its 4 cardinal dots via drawRimDots
      // below). Every slot is a SHORT RADIAL TICK — the majors width-matched to
      // the second hand, the minors shorter, thinner and pulled in from the rim
      // (MINOR_TICK). The radii and thickness are fractions of r, scaled here:
      // drawShadowedNotch takes ABSOLUTE px (an unscaled thickness renders a
      // 0.07px invisible hairline). The caller supplies the finished colour of
      // every slot, so this pass paints each slot exactly once — the sub-ticks
      // take the same colour as the majors they sit beside.
      const drawRimTicks = (
        ticks: NotchTick[],
        major: { r1: number; r2: number; t: number },
        minor: typeof MINOR_TICK,
        colourAt: (i: number) => { rgb: number[]; alpha: number } | null,
      ) => {
        const slots = Math.max(1, ticks.length)
        for (const tick of ticks) {
          const a = -Math.PI / 2 + tick.slot * ((Math.PI * 2) / slots)
          const colour = colourAt(tick.slot)
          if (colour === null) continue // the other element paints this slot
          if (tick.major) {
            drawShadowedNotch(a, r * major.r1, r * major.r2, r * major.t, colour)
          } else {
            drawShadowedNotch(a, r * minor.inset, r * (minor.inset + minor.length), r * minor.t, {
              rgb: colour.rgb,
              alpha: colour.alpha * minor.alpha,
            })
          }
        }
      }
      const drawRimDots = (count: number, dotCentre: number, dotRadius: number) => {
        for (let i = 0; i < count; i++) {
          const a = -Math.PI / 2 + i * ((Math.PI * 2) / count)
          drawShadowedDot(
            cx + r * dotCentre * Math.cos(a),
            cy + r * dotCentre * Math.sin(a),
            r * dotRadius,
            dotColour,
          )
        }
      }
      /** Paint the tick scale. The RUN of rim notches is the dial's declared fade
       *  element (see notchRunFade above): it is painted THROUGH the fade, so a
       *  change of the run's COLOUR cross-fades — the outgoing run painted at
       *  (1 − α) as the incoming one reaches α, each pass painting its OWN run's
       *  lit slots, so a change of the lit fraction rides the same transition
       *  rather than landing under it. Every notch no run lights is painted once
       *  per paint, at full opacity, in the clock's own dot colour — which is what
       *  keeps the unlit notches byte-identical through a transition. With no run
       *  up (a mode that shows no coloured notches, a reading not there yet) the
       *  whole scale is the dot colour. */
      const paintTickScale = (major: { r1: number; r2: number; t: number }): void => {
        const shown = run
        if (shown === null) {
          drawRimTicks(scaleTicks, major, MINOR_TICK, () => dotColour)
          return
        }
        notchRunFade.paint(
          shown.state,
          (painted, alpha) => {
            const faded = withFadeAlpha([painted[1], painted[2], painted[3], painted[4]], alpha)
            const lit: ConfigColour = { rgb: [faded[0], faded[1], faded[2]], alpha: faded[3] }
            const litAt = notchRun(painted[0], scaleSlots, lit)
            drawRimTicks(scaleTicks, major, MINOR_TICK, (i) => (litAt(i) === null ? null : lit))
          },
          shown.key,
        )
        const unlitAt = notchRun(shown.state[0], scaleSlots, dotColour)
        drawRimTicks(scaleTicks, major, MINOR_TICK, (i) => (unlitAt(i) === null ? dotColour : null))
      }
      if (mode === "digital") {
        // Digital: HH:MM on the disc over the analogue dial's 12 rim ticks and
        // its sweeping second hand — both drawn FIRST so the text sits on top
        // (the hand passes BEHIND the glyphs). No hour/minute hands (the text
        // is the hour and minute) and no pivot dot (it would collide with the
        // glyphs). The single blinking-red recording indicator is the TEXT
        // itself. Text size is fonts.labelSize — the same size every other
        // on-disc text label (46°, 11W, pct) uses, so the clock reads
        // consistently.
        const g = CLOCK_GEOM
        paintTickScale(g.tick)
        drawShadowedNotch(
          secondHandAngle(dialTime),
          r * g.second.r1,
          r * g.second.r2,
          r * g.second.t,
          secondColour,
        )
        const fs = config.fonts.labelSize
        const t = clk.text ?? centreColour
        const baseAlpha = t.alpha * rf * fade
        const textColour: [number, number, number, number] = recording
          ? [rc.rgb[0], rc.rgb[1], rc.rgb[2], baseAlpha * (0.3 + 0.7 * attention)]
          : [t.rgb[0], t.rgb[1], t.rgb[2], baseAlpha]
        const hh = dialTime.hh
        const mm = dialTime.mm
        const shadowAlpha = sh.alpha * fade
        if (clk.digitalLayout === "one-line") {
          drawGlyph(config, cr, cx, cy, `${hh}:${mm}`, fs, textColour, family, shadowAlpha, 1)
        } else {
          // stacked: two lines, bigger glyphs (favours the 36px disc).
          // Tight leading: the two numbers read as ONE clock, not two labels.
          // BOLD so the digits stay legible over the rim dots and the second
          // hand sweeping behind them.
          const lineH = fs * 1.0
          drawGlyph(config, cr, cx, cy - lineH * 0.55, hh, fs, textColour, family, shadowAlpha, 1)
          drawGlyph(config, cr, cx, cy + lineH * 0.55, mm, fs, textColour, family, shadowAlpha, 1)
        }
      } else if (mode === "clean") {
        // Clean: 4 cardinal dots + a length/thickness-contrasted hour & minute
        // pair — a 1.5px hand-length gap reads as IDENTICAL at 36px. No second
        // hand (only hour+minute are needed).
        const g = CLEAN_GEOM
        drawRimDots(4, g.dotCentre, g.dotRadius)
        // Centre pivot dot (caret morph) — red blink while recording.
        if (recording) {
          drawDot(cr, cx + sh.offset, cy + sh.offset, r * g.centreDot, shadowColour, fade)
          drawDot(
            cr,
            cx,
            cy,
            r * g.centreDot,
            { rgb: rc.rgb, alpha: gc.alpha * (0.3 + 0.7 * attention) },
            fade,
          )
        } else {
          drawDot(cr, cx + sh.offset, cy + sh.offset, r * g.centreDot, shadowColour, fade)
          drawDot(cr, cx, cy, r * g.centreDot, centreColour, fade)
        }
        drawShadowedNotch(
          -Math.PI / 2 + hour * ((Math.PI * 2) / 12),
          r * g.hour.r1,
          r * g.hour.r2,
          r * g.hour.t,
          hourColour,
        )
        drawShadowedNotch(
          -Math.PI / 2 + min * ((Math.PI * 2) / 60),
          r * g.minute.r1,
          r * g.minute.r2,
          r * g.minute.t,
          minuteColour,
        )
      } else {
        // Analogue (default): the original 12-tick dial with hour/minute/second
        // hands — unchanged.
        const g = CLOCK_GEOM
        // 12 five-minute tick marks (white) right at the disc's rim, each gap
        // divided into `minorTicksPerGap + 1` by the sub-ticks.
        paintTickScale(g.tick)
        // The centre dot the caret morphed into — shadow FIRST at the same
        // screen-space offset the glyph shadow uses (down-right), then the dot.
        // While recording the dot turns RED and blinks (the recording pulse) —
        // the clock-view stop indicator.
        if (recording) {
          drawDot(cr, cx + sh.offset, cy + sh.offset, r * g.centreDot, shadowColour, fade)
          drawDot(
            cr,
            cx,
            cy,
            r * g.centreDot,
            { rgb: rc.rgb, alpha: gc.alpha * (0.3 + 0.7 * attention) },
            fade,
          )
        } else {
          drawDot(cr, cx + sh.offset, cy + sh.offset, r * g.centreDot, shadowColour, fade)
          drawDot(cr, cx, cy, r * g.centreDot, centreColour, fade)
        }
        drawShadowedNotch(
          -Math.PI / 2 + hour * ((Math.PI * 2) / 12),
          r * g.hour.r1,
          r * g.hour.r2,
          r * g.hour.t,
          hourColour,
        )
        drawShadowedNotch(
          -Math.PI / 2 + min * ((Math.PI * 2) / 60),
          r * g.minute.r1,
          r * g.minute.r2,
          r * g.minute.t,
          minuteColour,
        )
        drawShadowedNotch(
          secondHandAngle(dialTime),
          r * g.second.r1,
          r * g.second.r2,
          r * g.second.t,
          secondColour,
        )
      }
    }
  }

  const steps = [
    {
      label: "Hide all",
      get emoji() {
        return config.appearance.icons.overflowHideAll
      },
    },
    {
      label: "Show all",
      get emoji() {
        return config.appearance.icons.overflowShowAll
      },
    },
    {
      label: "Auto",
      get emoji() {
        return config.appearance.icons.overflowAuto
      },
    },
    {
      label: "Move",
      get emoji() {
        return config.appearance.icons.overflowMove
      },
    },
  ]

  // ── Move-mode gestures (attached only while move mode is active) ──
  // ONE GestureDrag for the drag + ONE GestureClick for the double-click
  // commit. In GTK 4.22.4 neither gesture claims sequences (verified from
  // source), so they coexist on the window: GestureClick fires pressed with
  // n_press=1,2,… and resets its counter on motion beyond the drag
  // threshold, so a real drag can't be misread as a double-click.
  let moveGesturesAttached = false

  const moveDrag = new Gtk.GestureDrag()
  moveDrag.connect("drag-begin", () => {
    if (DBG) print(`[move] drag-begin`)
    row.beginMoveDrag()
  })
  moveDrag.connect("drag-update", (_g: any, ox: number, oy: number) => {
    if (DBG) print(`[move] drag-update ox=${ox} oy=${oy}`)
    row.updateMoveDrag(ox, oy)
  })
  moveDrag.connect("drag-end", () => {
    if (!row.isMoveMode()) return
    // A real drag → endMoveDrag commits the magnet-snap. A click → it
    // returns false (the GestureClick below handles the double-click).
    if (DBG) print(`[move] drag-end`)
    row.endMoveDrag()
  })

  // Double-click commits: exit move mode immediately (rebuild at the
  // committed position or restore in place). The commit is DEFERRED out of
  // the gesture's own signal emission: the exit path detaches these very
  // controllers (remove_controller) and may start the rebuild teardown, and
  // doing that inside the "pressed" dispatch leaves GTK walking a controller
  // list mid-modification — a freed-controller use-after-free in
  // gtk_event_controller_get_propagation_phase (segfault). The idle callback runs after
  // the event dispatch has fully unwound.
  const moveClick = new Gtk.GestureClick()
  moveClick.connect("pressed", (_c: any, nPress: number) => {
    if (!row.isMoveMode()) return
    if (DBG) print(`[move] click pressed n=${nPress}`)
    if (nPress < 2) return
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      row.commitMove()
      return GLib.SOURCE_REMOVE
    })
  })

  function attachMoveGestures(): void {
    if (moveGesturesAttached) return
    aw.window.add_controller(moveDrag)
    aw.window.add_controller(moveClick)
    moveGesturesAttached = true
    if (DBG) print(`[move] attach gestures`)
  }
  function detachMoveGestures(): void {
    if (!moveGesturesAttached) return
    aw.window.remove_controller(moveDrag)
    aw.window.remove_controller(moveClick)
    moveGesturesAttached = false
    if (DBG) print(`[move] detach gestures`)
  }
  row.setMoveModeListener((active) => {
    if (active) attachMoveGestures()
    else detachMoveGestures()
  })
  // If the applet's scope is disposed while move mode is active (a rebuild
  // triggered by e.g. a config reload mid-move-mode), detach the move
  // gestures so no controller stays attached to a window about to be
  // destroyed (the freed-controller UAF class). remove_controller on an
  // already-destroyed widget is a no-op.
  onCleanup(detachMoveGestures)

  // True while the overflow pill is open (set by onPanelOpen/onPanelClosed).
  let panelToggled = false

  // ── Clock visibility: hidden on hover / panel / reveal / move mode;
  //    re-appears `reappearMs` after the last interaction. The elements fade
  //    in/out over timing.pillAnim (clockFade 0..1). ──
  let clockFade = 1
  let cursorInOverflow = false
  // Sticky recording state for the caret/dot colour (see drawOverflowIcon):
  // latched on by the attention pulse, cleared only when the row stops the
  // blink tick (value = 0). Kills the white-variant flash at the sine
  // trough.
  let recordingLatch = false
  let reappearTimer: number | null = null

  // ── The hands' time ──
  // ONE pinned reading, stamped at mount, by the 1 s tick, and on every
  // appearance (BEFORE the fade, so the first visible frame carries the CURRENT
  // second). Every repaint reads the stamp, so nothing but the tick can move
  // the hands: a fade frame, the transient readout and a config reload all
  // paint the second already on screen.
  let dialTime = dialTimeOf(new Date())

  function stampDialTime(): void {
    dialTime = dialTimeOf(new Date())
  }

  // ── Transient readout ──
  // While the volume or the screen brightness is being adjusted the dial shows
  // THAT value, in the adjusting applet's own ring colour, instead of the idle
  // readout; it holds for appearance.clock.transientHoldMs after the last
  // change and then cross-fades back. The readings come from the backend
  // domains the two applets read, so a slider drag, a media key and an external
  // change all read the same.
  //
  // `transient` is the reading the dial is on (null = the idle charge scale).
  // EVERY change of what the dial shows — a reading arriving, leaving, or
  // switching source — is a change of the run's COLOUR, so it goes through the
  // dial's ONE declared fade element (`notchRunFade`): the outgoing run's alpha
  // falls as the incoming one rises, each pass painting that run's own lit slots.
  // The lane owns no transition animation of its own.
  interface Transient {
    /** WHICH applet's adjustment the reading came from: a step within one
     *  adjustment tracks the run in place (its lit fraction eases toward the new
     *  reading), while a switch between the two is a colour change the fade
     *  cross-fades. */
    source: "volume" | "brightness"
    value: number
    colour: ConfigColour
  }
  let transient: Transient | null = null
  let transientTimer: number | null = null

  // ── The clock's own frame loop ──
  // The clock's fade in/out is a TWEEP stepped by this single per-frame source,
  // and while a transient reading is live the loop keeps painting, so the whole
  // adjustment animates smoothly instead of at the idle 1 s tick. The ring's
  // colour transitions are NOT stepped here: they belong to the declared fade
  // element (`notchRunFade`), which runs its own frame source for the length of
  // a transition. There is never a second clock loop: every start request goes
  // through `ensureSmoothLoop` (a request while it runs joins the running loop),
  // and the loop clears its own slot when it stops, so `stopSmoothLoop` is safe
  // to call on a loop that already ended. The tween holds only its endpoints: an
  // interrupted transition is re-based from the live value, never left
  // half-applied.
  interface FrameTween {
    from: number
    to: number
    startUs: number
    durUs: number
  }
  let clockTween: FrameTween | null = null
  let smoothLoop: FrameRunner | null = null
  let smoothLastUs = 0

  // The dial's two PAINTED values, each easing toward its reading like an applet
  // ring: the idle scale's charge and the live transient reading. Holding the
  // last painted value is what makes a change sweep the lit fraction instead of
  // snapping it.
  const batterySmoother = createNotchSmoother(null)
  const transientSmoother = createNotchSmoother(null)

  // The dial's ONE declared fade element: the RUN of rim notches — the run the
  // colour policy colours on the idle scale (the battery charge) and the
  // transient volume/brightness reading while one is being adjusted. Its painted
  // state is the run itself and its change identity is the run's COLOUR, so every
  // colour change cross-fades (a battery state change — charging, plugged, a
  // level's warn/low, the charger plugged in or out — and a reading arriving,
  // leaving or switching source) exactly as the battery applet's ring arc does:
  // the mechanism is shared (common/applets/shared/element-fade) and the dial
  // declares it here. A change of the lit fraction alone is the value sweep's
  // business and adopts at once.
  const notchRunFade = createElementFade<[number, number, number, number, number]>(
    aw,
    config,
    "notches",
  )
  onCleanup(() => notchRunFade.dispose())

  /** True while the row's overflow mode is `hide`. The row OWNS the mode —
   *  dock-row.ts persists `overflowMode`, the pill's steps write it and the
   *  reveal session answers to it — so the dial reads it from the row, never
   *  from a copy of its own. */
  function hideMode(): boolean {
    return row.getMode() === "hide"
  }

  /** True when the dial's rim ticks double as the charge scale: tick dials only
   *  (clean mode's 4 cardinal dots carry no run), and only in the row's `hide`
   *  mode, where the battery icon is parked in overflow. */
  function batteryScaleUp(): boolean {
    return (config.appearance.clock.mode ?? "analogue") !== "clean" && hideMode()
  }

  /** The charge that scale is heading for, or null when no tick scale is up.
   *  The battery reactive is memoized in the domain, so reading it per frame is
   *  a `peek`, not a subscription. */
  function batteryScaleReading(): number | null {
    if (!batteryScaleUp()) return null
    const state = backend.battery.batteryState(config.timing.poll.batteryPower).peek()
    return state ? state.percentage : null
  }

  /** One frame of notch-value easing on both painted runs. The idle scale is
   *  advanced even while a transient is up (it is the run the dial falls BACK to),
   *  so the return never lands on a stale charge. */
  function advanceNotchValues(): void {
    const reading = batteryScaleReading()
    if (reading !== null) batterySmoother.advance(reading)
    if (transient !== null) transientSmoother.advance(transient.value)
  }

  /** A transient reading is on the dial. */
  function transientLive(): boolean {
    return transient !== null
  }

  /** One frame of the loop: advance both tweens, paint once, then decide whether
   *  the loop is still needed. Returning false stops the source; the slot is
   *  cleared here so a later start is not refused by a dead runner. */
  function smoothStep(nowUs: number): boolean {
    if (nowUs - smoothLastUs < smoothFrameBudgetUs(CLOCK_SMOOTH_FPS)) return true
    smoothLastUs = nowUs
    advanceNotchValues()
    if (clockTween) {
      const t = clockTween
      const p = Math.min(1, (nowUs - t.startUs) / t.durUs)
      clockFade = t.from + (t.to - t.from) * easeQuadInOut(p)
      if (p >= 1) {
        clockFade = t.to
        clockTween = null
        updateClockState() // may arm the reappear timer (the fade-out completed)
        ensureClockTick() // fade done: fast tick if visible, watchdog if hidden
      }
    }
    aw.icon.queue_draw()
    const running = smoothLoopRuns({
      animating: clockTween !== null,
      easing: batterySmoother.moving || transientSmoother.moving,
      transient: transientLive(),
      clockVisible: clockFade > 0.001,
    })
    if (running) return true
    smoothLoop = null
    return false
  }

  /** Start the frame loop unless it is already running. */
  function ensureSmoothLoop(): void {
    if (smoothLoop !== null) return
    smoothLastUs = 0 // paint the first frame at once
    smoothLoop = runFrames(aw.icon, smoothStep, CLOCK_SMOOTH_FPS)
  }

  /** Stop the frame loop and leave the clock SETTLED: the in-flight tween lands
   *  on its end value, so a stopped clock never holds a half-faded frame. */
  function stopSmoothLoop(): void {
    smoothLoop?.cancel() // no-op on a runner that already self-removed
    smoothLoop = null
    if (clockTween) {
      clockFade = clockTween.to
      clockTween = null
    }
  }

  function clearTransientTimer(): void {
    if (transientTimer !== null) {
      GLib.source_remove(transientTimer)
      transientTimer = null
    }
  }

  function showTransient(next: Transient): void {
    // The dial's rim notches are the `hide` mode's readout (see the draw path),
    // so no reading is taken up outside it: in `auto`/`show` the volume and
    // brightness applets are on the row, and a run there would arm the frame
    // loop and a hold timer for a dial that paints none of it.
    if (!hideMode()) return
    if (transient !== null && transient.source === next.source) {
      // A step within one adjustment (a slider drag, a held media key): the run
      // the dial is on is RETARGETED in place — the lit fraction EASES to the new
      // reading (the applet rings' own animation) instead of snapping, and the
      // run's colour is unchanged, so no transition is owed. Restarting a
      // transition per step would reset it on each one, and a drag's steps arrive
      // far faster than a fade lasts: the dial would never arrive on the reading
      // it is being dragged to.
      transient = next
    } else {
      // A new reading, or a switch between the two sources: the run's COLOUR
      // changes, so the dial's declared fade element cross-fades the pair (the
      // outgoing run out, the new one in). The transition IS this change's
      // animation, so the arriving value is ADOPTED — easing it too would move
      // the lit fraction and the colour at the same time.
      transient = next
      transientSmoother.adopt(next.value)
    }
    clearTransientTimer()
    // The reading holds for transientHoldMs and then hands the dial back to the
    // charge, and the frame loop paints that whole window, the hold included, so
    // the dial animates smoothly for as long as the adjustment is on screen.
    ensureSmoothLoop()
    transientTimer = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(0, config.appearance.clock.transientHoldMs),
      () => {
        transientTimer = null
        hideTransient()
        return GLib.SOURCE_REMOVE
      },
    )
  }

  /** Take the reading off the dial: the run falls back to the idle charge scale,
   *  a colour change the declared fade cross-fades from the settled reading the
   *  hold left on screen. */
  function hideTransient(): void {
    if (transient === null) return
    transient = null
    aw.icon.queue_draw()
  }

  /** The volume ring colour (the cairo tuple the applet paints with) in the
   *  `{ rgb, alpha }` shape the notch run takes. */
  function notchColour(c: [number, number, number, number]): ConfigColour {
    return { rgb: [c[0], c[1], c[2]], alpha: c[3] }
  }

  // One lane per source (see `transientStep`): the reading the readout compares
  // against. The volume lane starts from the sink's value when the domain
  // reports a reading, so the first adjustment is measured against a real level
  // even when the source publishes nothing further (a dock row REBUILD: the
  // domains are already bound and the reactive holds the sink's level); in a
  // fresh process the domain is not yet bound and the lane opens empty,
  // adopting the first reading it publishes. The brightness lane starts empty:
  // its domain's state opens at a placeholder 100 % until its first async read
  // lands, so a mount snapshot there is not necessarily the screen's real level.
  let volumeLane: TransientLane = { baseline: null }
  let brightnessLane: TransientLane = { baseline: null }

  // Volume is OPTIONAL in the backend contract (a host with no session has no
  // sink): without it the dial simply has no volume reading to show.
  const volumeRead = backend.volume?.volumeState(config.timing.poll.volume)
  const brightnessRead = backend.brightness.brightnessState(config.timing.poll.brightness)
  const volumeSeed = volumeRead?.peek()
  if (volumeSeed?.available) volumeLane = { baseline: volumeSeed.volume }

  function onVolumeChanged(): void {
    if (!volumeRead) return
    const state = volumeRead.peek()
    if (!state.available) return
    const step = transientStep(volumeLane, state.volume)
    volumeLane = step.lane
    if (step.show === null) return
    showTransient({
      source: "volume",
      value: state.volume,
      colour: notchColour(volumeRingColour(state.kind, config)),
    })
  }

  function onBrightnessChanged(): void {
    const step = transientStep(brightnessLane, brightnessRead.peek().screen)
    brightnessLane = step.lane
    if (step.show === null) return
    showTransient({
      source: "brightness",
      value: step.show,
      colour: config.appearance.ringColours.brightness,
    })
  }

  if (volumeRead) onCleanup(volumeRead.subscribe(onVolumeChanged))
  onCleanup(brightnessRead.subscribe(onBrightnessChanged))

  function clearReappearTimer(): void {
    if (reappearTimer !== null) {
      GLib.source_remove(reappearTimer)
      reappearTimer = null
    }
  }

  function animateClockFade(to: number): void {
    if (Math.abs(to - clockFade) < 0.001) {
      clockFade = to
      aw.icon.queue_draw()
      ensureClockTick() // (re)arm the fast tick or the hidden-state watchdog
      return
    }
    ensureClockTick()
    if (clockTween && clockTween.to === to) return // already heading there
    const from = clockFade
    const durMs = Math.max(0, config.timing.pillAnim)
    if (durMs <= 0) {
      clockFade = to
      aw.icon.queue_draw()
      updateClockState()
      ensureClockTick()
      return
    }
    clockTween = { from, to, startUs: GLib.get_monotonic_time(), durUs: durMs * 1000 }
    ensureSmoothLoop()
  }

  let lastClockActive: boolean | null = null
  function updateClockState(): void {
    const active = row.isMoveMode() || row.isRevealed() || panelToggled || cursorInOverflow
    if (DBG && active !== lastClockActive) {
      lastClockActive = active
      print(
        `[clk] active=${active} (move=${row.isMoveMode()} rev=${row.isRevealed()} pill=${panelToggled} cur=${cursorInOverflow}) fade=${clockFade.toFixed(2)}`,
      )
    }
    if (active) {
      clearReappearTimer()
      animateClockFade(0)
    } else if (clockFade <= 0.001 && reappearTimer === null) {
      // Fade-out finished and no interaction: re-appear after reappearMs.
      reappearTimer = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        Math.max(0, config.appearance.clock.reappearMs),
        () => {
          reappearTimer = null
          stampDialTime() // the first visible frame carries the CURRENT second
          animateClockFade(1)
          return GLib.SOURCE_REMOVE
        },
      )
    }
  }

  // Clock tick: a 1-second repaint timer while the clock is visible (the
  // hands step once per second — a quartz-style tick); a 500ms watchdog
  // while it is hidden (waits for the interaction to end, then arms the
  // reappear timer). Neither runs when the clock is disabled via config
  // (a live toggle would otherwise keep a 1Hz no-op source alive). This is the
  // IDLE repaint and it must stay the idle repaint: a permanently 60fps
  // frame-synced clock costs ~2W (4W→6W). The frame loop exists only while
  // something is animating — a clock fade, a notch crossfade, or a live
  // transient reading (`smoothLoopRuns`) — and hands the clock back to this tick
  // when it stops.
  let clockTickId: number | null = null
  function stopClockTick(): void {
    if (clockTickId !== null) {
      GLib.source_remove(clockTickId)
      clockTickId = null
    }
  }
  function ensureClockTick(): void {
    if (clockTickId !== null) return
    if (!config.appearance.clock.enabled) return
    if (clockFade > 0.001) {
      // Visible: repaint tick, once per second.
      const myId = (clockTickId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        Math.max(1, config.timing.clockTickMs),
        () => {
          updateClockState()
          if (config.appearance.clock.enabled && clockFade > 0.001) {
            // The 1 s tick is the ONLY thing that advances the hands: stamp the
            // current second, then repaint. The idle tick is also the first to
            // see an ORDINARY charge change (the dial reads the battery with
            // `peek` — it holds no subscription of its own), so hand the dial to
            // the frame loop for the sweep: the loop stops by itself once the
            // value has settled.
            stampDialTime()
            const reading = batteryScaleReading()
            // An UNSEEDED lane must arm the loop too, not only a lane behind a
            // changed reading: `behind` is false while anything is unseeded, and
            // the loop is the only place the lane adopts its first reading — the
            // ring would otherwise paint its initial 0 (ONE lit marker, the
            // 12 o'clock one) until an unrelated transient starts the loop.
            if (reading !== null && (!batterySmoother.seeded || batterySmoother.behind(reading)))
              ensureSmoothLoop()
            aw.icon.queue_draw()
            return GLib.SOURCE_CONTINUE
          }
          // Hidden mid-flight: hand off to the slow watchdog. The fade
          // completion's ensureClockTick can't start it (this fast tick is
          // still alive then), so start it here, after nulling our slot.
          if (clockTickId === myId) clockTickId = null
          ensureClockTick()
          return GLib.SOURCE_REMOVE
        },
      ))
    } else {
      // Hidden: slow watchdog. It keeps running while the interaction that
      // hid the clock persists, and the moment the interaction ends it arms
      // the reappear timer (without this, the reappear would
      // never arm after a reveal collapse and the clock would stay hidden
      // forever). Stops once the reappear is scheduled; the reappear's
      // fade-in restarts the fast tick.
      clockTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        const myId = clockTickId
        if (!config.appearance.clock.enabled) {
          if (clockTickId === myId) clockTickId = null
          return GLib.SOURCE_REMOVE
        }
        const active = row.isMoveMode() || row.isRevealed() || panelToggled || cursorInOverflow
        if (!active && reappearTimer === null) {
          reappearTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(0, config.appearance.clock.reappearMs),
            () => {
              reappearTimer = null
              stampDialTime() // the first visible frame carries the CURRENT second
              animateClockFade(1)
              return GLib.SOURCE_REMOVE
            },
          )
        }
        if (!active) {
          if (clockTickId === myId) clockTickId = null
          return GLib.SOURCE_REMOVE
        }
        return GLib.SOURCE_CONTINUE
      })
    }
  }
  onCleanup(() => {
    stopClockTick()
    clearReappearTimer()
    stopSmoothLoop()
    clearTransientTimer()
  })
  // Live config changes (e.g. appearance.clock.enabled toggled at runtime)
  // must arm/stop the tick — the tick's own body also self-removes when it
  // sees the clock hide, but only a config listener can RESTART it. A disabled
  // clock also drops the frame loop: nothing it paints would be visible.
  onCleanup(
    dock.onConfigChanged(() => {
      if (config.appearance.clock.enabled) ensureClockTick()
      else {
        stopClockTick()
        stopSmoothLoop()
      }
    }),
  )

  // Hovering the overflow applet's band hides the clock immediately; leaving
  // arms the reappear timer. (Routed via the shared surface — a second motion
  // listener on the entry coexists with the applet core's handlers. The
  // hover-enter here is INDICATOR-level: delivered on every routed enter,
  // never held back by the open-suppression grace — a pointer resting on the
  // disc after a recent geometry commit must still hide the clock promptly.)
  aw.addHoverListener({
    onEnter: () => {
      cursorInOverflow = true
      updateClockState()
    },
    onLeave: () => {
      cursorInOverflow = false
      updateClockState()
    },
  })

  // Clock starts visible (fade=1): stamp the hands' time so the first painted
  // frame carries the CURRENT second, then arm the repaint tick. The tick
  // self-stops when the clock hides and restarts via animateClockFade on
  // re-appear.
  stampDialTime()
  ensureClockTick()

  // Register the clock-state snapshot (see overflowClockHooks above).
  overflowClockHooks.set(aw.name, {
    snapshot: () => {
      // `active` is recomputed identically to updateClockState.
      const active = row.isMoveMode() || row.isRevealed() || panelToggled || cursorInOverflow
      return {
        active,
        moveMode: row.isMoveMode(),
        revealed: row.isRevealed(),
        panelToggled,
        cursorInOverflow,
        fade: clockFade,
        reappearPending: reappearTimer !== null,
      }
    },
  })

  // Test/debug hook: toggle the overflow pill (`debug overflow panel`).
  const handle = createStepApplet(aw, {
    config,
    steps,
    getStepColour: (i: number) => config.appearance.stepColours.overflow[i],
    getInitialStep: () => MODE_STEP[row.getMode()] ?? 0,
    drawIcon: drawOverflowIcon,
    onPanelOpen: () => {
      panelToggled = true
      row.setOverflowPanelOpen(true)
      row.beginReveal()
    },
    onPanelClosed: () => {
      panelToggled = false
      row.setOverflowPanelOpen(false)
      row.endReveal()
    },
    onSelect: (step, close) => {
      switch (step) {
        case 0:
          row.setMode("hide")
          break
        case 1:
          row.setMode("show")
          break
        case 2:
          row.setMode("auto")
          break
        case 3:
          row.enterMoveMode()
          // Instant close: the closing pill's GestureDrag would claim presses
          // and starve the move drag on the window — with an instant close the
          // overlay is gone before the user can double-click.
          handle.closeInstant()
          break
      }
    },
    logLabel: "overflow",
  })
  row.setPanelForceOpen(() => {
    if (panelToggled) handle.close()
    else handle.forceOpen()
  })
}
