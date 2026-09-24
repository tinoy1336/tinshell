/**
 * Scroll laws — the arithmetic a row-scroll surface scrolls by: the wheel step,
 * the two conversions between a scroller's pixels and the surface's own row
 * unit, and the viewport bound, in one pure (gi-free) module so
 * `./scroll.probe.ts` can pin them without a window.
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
 *   - a WHEEL notch moves a surface by whole row units (`wheelSteps`) and leaves
 *     the position on a whole row, which is what makes a notch feel rigid rather
 *     than pixel-slipping — the launcher's result list spends a notch on its
 *     SELECTION and its glyph grid spends it on its view, a difference of unit
 *     and not of law;
 *   - a SURFACE delta is a CONTINUOUS gesture: it belongs to the surface's own
 *     scroller, and all this module does with it is name it (`scrollDecision`'s
 *     `continuous` kind) so the app hands the event on;
 *   - the SELECTION follows the view (`selectionInView`), so Enter always acts
 *     on a row the user can see — the wheel already moved the selection, and a
 *     scroll that moved the view pulls the selection back into the viewport.
 *
 * A GtkScrolledWindow ALREADY SCROLLS ITSELF, MOMENTUM INCLUDED. It runs its own
 * scroll controllers: a continuous delta is scaled by its own surface factor,
 * and at the end of the gesture its `::decelerate` handler spends the velocity
 * it measured in `GtkKineticScrolling` — a friction curve with an overshoot
 * spring at either end — driven per frame from the widget's frame clock. A row
 * list inside one therefore gets kinetic scrolling WITHOUT this module, and the
 * one thing that takes it away is a second, NON-GESTURE `Gtk.EventControllerScroll`
 * installed over the same gesture: `gtk_widget_run_controllers` stops the
 * dispatch at the first non-gesture controller that returns TRUE (a controller
 * is non-gesture), the scroller's own scroll handler then never runs, the state
 * its `::decelerate` handler gates on stays unset, and GTK's kinetic path is
 * latched off for the whole gesture. So consume a wheel notch when the surface
 * MUST act on it, and return FALSE for a `continuous` decision so the scroller
 * keeps the drag, the friction and the end spring: the only momentum any row
 * surface in this suite has is GTK's own.
 *
 * The viewport is the caller's — the launcher's result list shows `config
 * listHeight` rows (default 5) and its emoji grid shows `grid.visibleRows`,
 * while a probe or another surface brings its own numbers: the card stops
 * growing there and scrolls instead, because the bound is the scroller's own
 * `max-content-height` (`viewportPixels`), which binds only while its VERTICAL
 * policy is `AUTOMATIC`.
 *
 * ANY ROW UNIT. A surface counts its own rows and owns the widget side of its
 * scroller (the adjustment, the selection); this module supplies the laws and
 * the two conversions between those rows and the scroller's pixels
 * (`offsetPixels` out, `rowOffset` back).
 */

/** Which of GDK's two scroll units a delta arrived in. */
export type ScrollUnit = "wheel" | "surface"

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

/** The pixel position of a scroller's adjustment as row units — the inverse of
 *  `offsetPixels`, for a position that arrives from OUTSIDE the surface: GTK's
 *  own scroll path (see the module note), a dragged scrollbar, or a view pulled
 *  past an end. The caller clamps the result (`clampOffset`), because an
 *  overshooting scroll can report a position outside the row range. */
export function rowOffset(pixels: number, rowPitchPx: number): number {
  if (!Number.isFinite(pixels) || rowPitchPx <= 0) return 0
  return pixels / rowPitchPx
}

/** What one scroll event should DO — see `scrollDecision`. Exported as a named
 *  contract because the surfaces' controllers, and the probes, all read it. */
export type ScrollDecision =
  | { kind: "ignore" }
  | { kind: "step"; steps: number }
  | { kind: "continuous" }

/** The row pitch the surface mapping uses when no row has been measured yet
 *  (a row's chrome at its resting height) — a fallback, not the rule: the caller
 *  passes the measured height of a rendered row when it has one. */
export const ROW_PITCH_FALLBACK_PX = 44

/**
 * The `Gtk.EventControllerScrollFlags` an app-side controller over a scroller's
 * gesture is built with: `VERTICAL` (1) alone.
 *
 * `DISCRETE` (4) is deliberately ABSENT — with it `get_unit()` answers WHEEL for
 * every event, which would turn a trackpad into a notched wheel. `KINETIC` (8) is
 * absent too: it only toggles the emission of `::decelerate`, and the momentum
 * after a gesture belongs to the widget's own `GtkScrolledWindow`, which installs
 * its own controllers with `BOTH_AXES | KINETIC` whatever an app-side one asks
 * for.
 *
 * These flags are for a controller over a gesture the surface KEEPS: a
 * non-gesture controller that returns TRUE for a continuous delta stops the
 * scroller's own handler from running and latches GTK's kinetic path off (see
 * the module note). A surface that wants GTK's momentum leaves the continuous
 * delta alone and reads the position back through `rowOffset`.
 */
export const SCROLL_CONTROLLER_FLAGS = 1

/** The flag the constant above must never carry (the trap it documents). */
export const SCROLL_FLAG_DISCRETE = 4

/**
 * The decision for one `::scroll` event.
 *
 * The EMOJI RULE lives here: the emoji row's glyph grid owns its own scroller
 * (and GTK's native wheel/kinetic handling for it), so while that row is
 * selected the LIST ignores the event entirely — the two scrollers must never
 * consume the same one. Otherwise a wheel notch is a `step` of whole row units
 * and a continuous delta is `continuous` — a gesture the calling surface's own
 * scroller owns, which is why its controller must return FALSE for it (the
 * module note).
 */
export function scrollDecision(unit: ScrollUnit, dy: number, gridActive: boolean): ScrollDecision {
  if (gridActive) return { kind: "ignore" }
  const steps = wheelSteps(dy, unit)
  if (steps !== 0) return { kind: "step", steps }
  return unit === "surface" ? { kind: "continuous" } : { kind: "ignore" }
}

/** The scroller's maximum content height for a viewport of `listHeight` rows. */
export function viewportPixels(listHeight: number, rowPitchPx: number): number {
  return viewportRows(listHeight, Number.MAX_SAFE_INTEGER) * rowPitchPx
}
