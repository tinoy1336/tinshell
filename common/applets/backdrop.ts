/**
 * backdrop — the dock's shared pill-backdrop paint: BOTH the dock's layer
 * surface AND the greeter's hosted dock strip render the IDENTICAL backdrop.
 * This is the single paint primitive: no surface may draw its own backdrop
 * shape/colour; the greeter calls this same function the dock calls.
 *
 * What it paints, in two passes:
 *   (a) the icon strip — iconSize thick, flush at the icons' grow edge,
 *       spanning the LIVE icon extent (row axis); and
 *   (b) a full pillHeight stadium behind every OPEN panel, so an expanded
 *       applet's backdrop reads uniform instead of switching between
 *       band-alpha and bare wallpaper.
 * Those two accumulate into ONE path and fill ONCE — a single rasterization
 * gives uniform alpha across the union; a panel stadium contains its stretch of
 * strip, and the overlap reads as one tint, never two stacked ones.
 *
 * The optional third pass is the LIFT: the same bar/pill visible tone the panel
 * framework's unfilled region wears (one source: `draw-utils`
 * `backdropLiftColour`). It is painted over the strip ONLY where the strip is
 * actually visible as bar:
 *   - with a hole at the cell of every disc that is NOT inside a panel (an
 *     open panel's own surface paints the lift instead, and clips its riding
 *     disc out of it), and
 *   - never under an open panel's stadium (that panel's own surface paints the
 *     lift over its footprint).
 * Consequence, and the reason the holes exist: a disc composites over the
 * backdrop's own base, never over the lift — so a disc's rendered colour stays
 * the base glass + the disc's weight, independent of the bar's raised tone.
 *
 * Colour comes from `config.appearance.backdrop` at call time (live), the same
 * source the dock reads. This file is a pure paint helper — no GTK state, no
 * window, no surface. Geometry is caller-supplied (row/grow coords) so the
 * dock's band bookkeeping and the greeter's strip both drive it.
 */

import type { Axis } from "@common/applets/layout"

/** The backdrop's colour/alpha (config.appearance.backdrop: rgb + alpha). */
type BackdropColour = [number, number, number, number]

/** Geometry inputs the paint needs (a DockGeometry subset). */
interface BackdropGeometry {
  growAxis: Axis
  growDir: 1 | -1
  iconSize: number
  pillHeight: number
}

/** An open panel's stadium footprint, in band-local row coords. */
interface BackdropPanel {
  /** Band-local row coord of the panel's leading edge (a slot start). */
  slot: number
  /** The panel's live grow-axis open height (panelOh). */
  panelOh: number
}

/** The bar's raised tone over the strip (see the module doc). */
interface BackdropLift {
  /** The lift's own colour/alpha — `draw-utils` `backdropLiftColour(config)`. */
  colour: BackdropColour
  /** Band-local row coord of every disc that sits on the strip (a slot start),
   *  i.e. every displayed applet whose panel is CLOSED. */
  discSlots: number[]
}

/** Everything drawPillBackdrop needs, per frame. */
interface BackdropInput {
  geometry: BackdropGeometry
  /** The live icon strip's band-local row extent (drawnRow). */
  strip: { a: number; b: number }
  /** Open panels (empty when none). */
  panels: BackdropPanel[]
  colour: BackdropColour
  /** The bar's visible tone over the strip; omitted = the strip stays at
   *  `colour` (the greeter's strip paints no lift). */
  lift?: BackdropLift
}

/** The dock's stadium pill path: a fully-rounded rectangle (radius = min(w,h)/2). */
function roundedRect(cr: any, x: number, y: number, w: number, h: number): void {
  const r = Math.min(w, h) / 2
  cr.moveTo(x + r, y)
  cr.lineTo(x + w - r, y)
  cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0)
  cr.lineTo(x + w, y + h - r)
  cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2)
  cr.lineTo(x + r, y + h)
  cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI)
  cr.lineTo(x, y + r)
  cr.arc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2)
  cr.closePath()
}

/** Map (row0,row1,grow0,grow1) → da coords. Row = applets' axis (x for
 *  top/bottom docks, y for left/right), grow = the other. */
function bandRect(
  g: BackdropGeometry,
  r0: number,
  r1: number,
  g0: number,
  g1: number,
): { x: number; y: number; w: number; h: number } {
  return g.growAxis === "y"
    ? { x: r0, y: g0, w: r1 - r0, h: g1 - g0 }
    : { x: g0, y: r0, w: g1 - g0, h: r1 - r0 }
}

/**
 * Paint the dock's pill backdrop on `cr` (a Cairo context, da coords). Caller
 * must have set the DrawingArea's size to the window's band extent (bandLen ×
 * pillHeight, row × grow).
 */
export function drawPillBackdrop(cr: any, input: BackdropInput): void {
  const g = input.geometry
  const th = Math.round(g.iconSize)
  const lg = Math.round(g.pillHeight)
  const flush = Math.round(g.growDir < 0 ? lg - th : 0)

  const strip = bandRect(g, input.strip.a, input.strip.b, flush, flush + th)

  // The open panels' stadium footprints (shared by both passes: the base paints
  // them, the lift keeps out of them).
  const stadiums: { x: number; y: number; w: number; h: number }[] = []
  for (const e of input.panels) {
    const oh = Math.max(th, Math.min(lg, Math.round(e.panelOh)))
    const go = g.growDir < 0 ? lg - oh : 0
    const p = bandRect(g, e.slot, e.slot + th, go, go + oh)
    if (p.w > 0 && p.h > 0) stadiums.push(p)
  }

  // ── Pass 1: the backdrop base (strip + stadiums), one path, one fill ──
  cr.setFillRule(0) // CAIRO_FILL_RULE_WINDING: strip + stadiums union, no holes
  cr.setSourceRGBA(input.colour[0], input.colour[1], input.colour[2], input.colour[3])
  if (strip.w > 0 && strip.h > 0) roundedRect(cr, strip.x, strip.y, strip.w, strip.h)
  for (const p of stadiums) roundedRect(cr, p.x, p.y, p.w, p.h)
  cr.fill()

  // ── Pass 2: the bar's visible tone (the lift) over the strip only ──
  const lift = input.lift
  if (!lift || lift.colour[3] <= 0 || strip.w <= 0 || strip.h <= 0) return
  cr.save()
  // Clip to the strip itself. The lift never paints outside the strip, and the
  // clip is what keeps the EVEN-ODD holes below strip-shaped cutouts: a panel
  // stadium's subpath reaches past the strip, and unclipped its outside part
  // would toggle back ON and paint the whole panel footprint a second time.
  cr.newPath()
  roundedRect(cr, strip.x, strip.y, strip.w, strip.h)
  cr.clip()
  cr.newPath()
  roundedRect(cr, strip.x, strip.y, strip.w, strip.h)
  // A hole at every disc sitting on the strip: it must composite over the base,
  // not over the lift (see the module doc).
  for (const slot of lift.discSlots) {
    const c = bandRect(g, slot, slot + th, flush, flush + th)
    if (c.w <= 0 || c.h <= 0) continue
    cr.newSubPath()
    cr.arc(c.x + c.w / 2, c.y + c.h / 2, th / 2 + 0.5, 0, Math.PI * 2)
  }
  // Never under an open panel: that panel's own surface paints the lift.
  for (const p of stadiums) {
    cr.newSubPath()
    roundedRect(cr, p.x, p.y, p.w, p.h)
  }
  // EVEN-ODD: the outer strip + one subpath per hole = the holes knock out (the
  // holes are disjoint from each other inside the strip).
  cr.setFillRule(1) // CAIRO_FILL_RULE_EVEN_ODD
  cr.setSourceRGBA(lift.colour[0], lift.colour[1], lift.colour[2], lift.colour[3])
  cr.fill()
  cr.restore()
}
