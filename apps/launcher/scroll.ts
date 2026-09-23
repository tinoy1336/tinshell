/**
 * Scroll laws — the arithmetic the launcher's result list scrolls by, in one
 * pure module so `./scroll.probe.ts` can pin it without a window.
 *
 * ONE POSITION, TWO FEEDS. GDK reports a mouse wheel and a trackpad through the
 * same `Gtk.EventControllerScroll::scroll(dx, dy)` signal but as different
 * units: `controller.get_unit()` (`@since 4.8`, valid for the LAST signal)
 * answers `Gdk.ScrollUnit.WHEEL` — the delta is a number of wheel CLICKS — or
 * `Gdk.ScrollUnit.SURFACE` — the delta is surface pixels of a continuous
 * gesture, momentum included. The controller MUST NOT be built with the
 * `DISCRETE` flag: with it `get_unit()` always answers WHEEL, which is exactly
 * the information this module needs. So:
 *
 *   - a WHEEL notch moves the SELECTION by whole entries (`wheelSteps`) and
 *     leaves the position on a whole row, which is what makes a notch feel
 *     rigid rather than pixel-slipping;
 *   - a SURFACE delta moves the POSITION proportionally to the pixels
 *     (`linearOffset`), so a trackpad scrolls linearly while the fingers are
 *     down; the TAIL after they lift is not sent by GDK — it is rebuilt from
 *     GTK's own gesture velocity by the glide laws below (`glideVelocity`,
 *     `glideStarts`, `glideStep`), driven by `::decelerate`;
 *   - the SELECTION follows the view (`selectionInView`), so Enter always acts
 *     on a row the user can see — the wheel already moved the selection, and a
 *     linear scroll pulls it back into the viewport.
 *
 * The viewport is `listHeight` entries (`config listHeight`, default 5): the
 * card stops growing there and scrolls instead — the bound is the scroller's own
 * `max-content-height` (`Launcher.tsx` `applyViewport`), the same shape the emoji
 * grid's own `visibleRows` gives its scroller.
 */

/** Which of GDK's two scroll units a delta arrived in. */
export type ScrollUnit = "wheel" | "surface"

/** The rows the list is showing: how many there are, how many are on screen,
 *  which one is selected, and the fractional row the viewport starts at. */
export interface ScrollView {
  selected: number
  offset: number
  rows: number
  viewport: number
}

/**
 * Whole entries a scroll delta moves — the QUANTISATION law.
 *
 * A wheel delta is in clicks, so one notch is one entry; the truncation keeps a
 * fractional click from half-moving the list, and `SURFACE` deltas are not
 * entries at all (they move the position linearly instead).
 */
export function wheelSteps(dy: number, unit: ScrollUnit): number {
  return unit === "wheel" ? Math.trunc(dy) : 0
}

/** How many rows the viewport shows: the configured height, or the whole list
 *  when there is less of it. */
export function viewportRows(listHeight: number, rows: number): number {
  return Math.max(1, Math.min(Math.max(1, Math.floor(listHeight)), Math.max(1, rows)))
}

/** The position, clamped to the list — the end stops are hard, so the view
 *  cannot scroll past the last entry or above the first. */
export function clampOffset(offset: number, rows: number, viewport: number): number {
  return Math.min(Math.max(offset, 0), Math.max(0, rows - viewport))
}

/** The selection after `steps` entries, WRAPPING like the arrow keys already
 *  wrap (Up at the first row is the last one), so a wheel notch and an arrow
 *  key move the list the same way. */
export function stepSelection(selected: number, steps: number, rows: number): number {
  if (rows <= 0) return 0
  return (((selected + steps) % rows) + rows) % rows
}

/**
 * The position to keep `selected` visible — the SELECTION-FOLLOWS law. A
 * selection above the viewport pulls the position up to it; one below pushes
 * the position down so the selection is the last visible row; a selection
 * already inside the viewport moves nothing.
 */
export function offsetForSelection(
  selected: number,
  offset: number,
  viewport: number,
  rows: number,
): number {
  if (selected < offset) return clampOffset(selected, rows, viewport)
  if (selected > offset + viewport - 1) {
    return clampOffset(selected - viewport + 1, rows, viewport)
  }
  return clampOffset(offset, rows, viewport)
}

/**
 * A trackpad's surface delta as a position delta — the LINEAR law: the shift is
 * the pixels divided by the height of one row, so twice the finger travel is
 * twice the scroll and the momentum tail keeps moving the same way. GDK's
 * `::scroll` reports a positive `dy` for a downward scroll, which moves the
 * viewport FURTHER DOWN the list, so the delta adds to the position.
 */
export function linearOffset(
  offset: number,
  deltaPx: number,
  rowPitchPx: number,
  rows: number,
  viewport: number,
): number {
  if (rowPitchPx <= 0) return clampOffset(offset, rows, viewport)
  return clampOffset(offset + deltaPx / rowPitchPx, rows, viewport)
}

/** The position that brings a selection the viewport has scrolled past back
 *  into view, so Enter still acts on something visible. */
export function selectionInView(
  selected: number,
  offset: number,
  viewport: number,
  rows: number,
): number {
  const last = Math.max(0, Math.min(Math.floor(offset) + viewport - 1, rows - 1))
  return Math.min(Math.max(selected, Math.floor(offset)), last)
}

/** The pixel position a row offset maps to. GTK owns the pixels; this is the
 *  bridge between this module's row units and the adjustment's. */
export function offsetPixels(offset: number, rowPitchPx: number): number {
  return offset * rowPitchPx
}

/**
 * The glide — the momentum tail a CONTINUOUS gesture gets after the fingers
 * lift.
 *
 * GDK sends no momentum: the deltas stop arriving with the gesture. The
 * velocity of the gesture is measured by GTK, though — a controller built with
 * `KINETIC` emits `::decelerate(vel_x, vel_y)` in pixels per millisecond at the
 * end of a continuous scroll — and the laws below turn that velocity into row
 * movement: `glideVelocity` maps it into row units, `glideStarts` decides
 * whether it is a flick at all, and `glideStep` advances one frame and decays
 * it.
 *
 * Decay is EXPONENTIAL, never a fixed-duration tween: each frame keeps
 * `e^(−decay·dt)` of the velocity, so the tail's length follows the flick's
 * speed and it stops asymptotically instead of on a schedule.
 */

/** Velocity retained per millisecond — the friction coefficient of the decay
 *  (`e^(−GLIDE_DECAY_PER_MS·dt)` per frame; the time constant is 1/0.0025 = 400
 *  ms, so a flick spends most of its travel inside half a second and its total
 *  distance is the starting velocity divided by this). */
export const GLIDE_DECAY_PER_MS = 0.0025

/** The velocity below which a gesture is a drag, not a flick: lifting the
 *  fingers after a slow drag leaves the list where it is. */
export const GLIDE_START_ROWS_PER_MS = 0.005

/** The velocity at which the glide is over (2 rows per second, an eighth of a
 *  row per frame — slow enough to read as stopped). */
export const GLIDE_STOP_ROWS_PER_MS = 0.002

/** The longest frame the glide may integrate: a stalled frame clock must not
 *  let one tick spend the whole tail at once. */
export const GLIDE_MAX_STEP_MS = 50

/** A gesture velocity in pixels/ms as a glide velocity in rows/ms. */
export function glideVelocity(velocityPxPerMs: number, rowPitchPx: number): number {
  if (!Number.isFinite(velocityPxPerMs) || rowPitchPx <= 0) return 0
  return velocityPxPerMs / rowPitchPx
}

/** Whether a gesture was a flick that should keep moving. */
export function glideStarts(velocityRowsPerMs: number): boolean {
  return (
    Number.isFinite(velocityRowsPerMs) && Math.abs(velocityRowsPerMs) >= GLIDE_START_ROWS_PER_MS
  )
}

/** A glide's position and velocity after one frame. */
export interface Glide {
  offset: number
  velocity: number
}

/**
 * One frame of the glide: the position moves by the distance this frame's
 * velocity decays through, the velocity decays, and the glide ENDS (velocity
 * zero, so the caller stops the frame source) on the stop threshold or on
 * either end of the list — a hard end stop spends the momentum instead of
 * pushing against it.
 *
 * The frame's travel is the decay's integral over `dt`
 * (`v·(1 − e^(−decay·dt))/decay`) rather than `v·dt`, which is what makes the
 * tail frame-rate independent: the same flick travels the same distance at 60
 * and at 120 fps.
 */
export function glideStep(
  offset: number,
  velocity: number,
  dtMs: number,
  rows: number,
  viewport: number,
): Glide {
  const held = clampOffset(offset, rows, viewport)
  if (!Number.isFinite(velocity) || velocity === 0) return { offset: held, velocity: 0 }
  const dt = Math.min(Math.max(Number.isFinite(dtMs) ? dtMs : 0, 0), GLIDE_MAX_STEP_MS)
  if (dt === 0) return { offset: held, velocity }
  const decay = Math.exp(-GLIDE_DECAY_PER_MS * dt)
  const moved = held + (velocity * (1 - decay)) / GLIDE_DECAY_PER_MS
  const next = clampOffset(moved, rows, viewport)
  if (next !== moved) return { offset: next, velocity: 0 }
  const decayed = velocity * decay
  return { offset: next, velocity: Math.abs(decayed) < GLIDE_STOP_ROWS_PER_MS ? 0 : decayed }
}

/** The row pitch the surface mapping uses when no row has been measured yet
 *  (the launcher's row chrome at its resting height) — a fallback, not the
 *  rule: the caller passes the measured height of a rendered row when it has
 *  one. */
export const ROW_PITCH_FALLBACK_PX = 44

/**
 * The `Gtk.EventControllerScrollFlags` the launcher builds its controller with:
 * `VERTICAL | KINETIC` (1 | 8). `KINETIC` is what makes `::decelerate` fire when
 * a continuous gesture ends; `DISCRETE` (4) is deliberately ABSENT — with it
 * `get_unit()` answers WHEEL for every event, which would turn every trackpad
 * into a notched wheel and erase the linear mapping.
 */
export const SCROLL_CONTROLLER_FLAGS = 1 | 8

/** The flag the constant above must never carry (the trap it documents). */
export const SCROLL_FLAG_DISCRETE = 4

/** What one scroll event should DO — the controller's decision, in one place so
 *  it can be probed without a window. */
export type ScrollDecision =
  | { kind: "ignore" }
  | { kind: "selection"; steps: number }
  | { kind: "position"; pixels: number }

/**
 * The decision for one `::scroll` event.
 *
 * The EMOJI RULE lives here: the emoji row's glyph grid owns its own scroller
 * (and GTK's native wheel/kinetic handling for it), so while that row is
 * selected the LIST ignores the event entirely — the two scrollers must never
 * consume the same one. Otherwise a wheel delta moves the SELECTION by whole
 * entries and a surface delta moves the POSITION by its pixels.
 */
export function scrollDecision(unit: ScrollUnit, dy: number, gridActive: boolean): ScrollDecision {
  if (gridActive) return { kind: "ignore" }
  const steps = wheelSteps(dy, unit)
  if (steps !== 0) return { kind: "selection", steps }
  return unit === "surface" ? { kind: "position", pixels: dy } : { kind: "ignore" }
}

/** The scroller's maximum content height for a viewport of `listHeight` rows. */
export function viewportPixels(listHeight: number, rowPitchPx: number): number {
  return viewportRows(listHeight, Number.MAX_SAFE_INTEGER) * rowPitchPx
}
