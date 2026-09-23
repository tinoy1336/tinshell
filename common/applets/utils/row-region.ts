import cairo from "gi://cairo"
import { ignore } from "@common/log/logger"

/**
 * row-region.ts — the CAPTURE REGION of the shared applet surface
 * (common/applets/surface/surface.ts): the ONE owner of which pixels of a
 * hosted applet row capture pointer input and which stay click-through.
 *
 * The region is a union of SHAPES in surface coordinates:
 *   1. the closed icons — a disc per displayed applet at its current animated
 *      slot (the disc's square corners stay click-through),
 *   2. the open panels — a stadium hugging the grow edge at the panel's slot,
 *      as long as the panel's LATCHED extent (`regionOh`: it grows with the
 *      pill and never shrinks mid-close — a shrinking region re-evaluated by
 *      the compositor under a finger is the documented swallowed-click race),
 *   3. the row BAND — a stadium as long as the applied band, iconSize thick,
 *      flush at the icons' grow edge. Only a substrate whose bar is itself a
 *      hit target adds it (the dock's layer band sits over the desktop, so a
 *      press on the bar must land on the surface, never on the layer below);
 *      an embedded strip (the greeter) leaves the band click-through.
 *
 * ONE shape list, ONE compilation (`compileCaptureRegion`) feeds both
 * consumers, so they can never diverge:
 *   - `unionInto(region)` — the integer-rect union a layer surface installs as
 *     its wl_surface input region (the dock substrate);
 *   - `contains(x, y)` — the SAME rects as a point test, which the renderer's
 *     router applies to every enter/motion/press. That is the capture lock of
 *     a substrate that cannot install a region of its own (an embedded widget
 *     host delivers the pointer across its whole row rect via GTK pick): the
 *     router is what keeps the band above the icons and the discs' corners
 *     inert there, exactly as the region does for the dock.
 *
 * NOTE on the cairo API (gjs): the factory functions region_create_polygon /
 * region_create_rectangle and the methods copy() / translate() do NOT exist in
 * gjs. The working API is `new cairo.Region()` (empty) +
 * `region.unionRectangle(rect)`. So every shape is a stack of integer rects:
 * a disc is one chord rect per scanline (circle equation — at 36px / ~18
 * scanlines it reads as a smooth circle with no perceptible stair-stepping)
 * and a stadium is two chord caps plus a full-width middle band. The caps MUST
 * NOT be full-width squares: their union with the middle would equal the whole
 * bounding rect and the transparent corners would capture hover/click input.
 * The point test reads those same rects, never an analytic circle, so the
 * captured geometry is byte-identical between the two renderings.
 */

/** The subset of the cairo region API gjs actually exposes. */
export interface CairoRegion {
  unionRectangle(rect: CaptureRect): void
}

/** One integer rect of the union. */
export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

/** The surface's axis pair: which SURFACE axis the row runs along and which
 *  one the pill grows along (from the dock geometry — "x"/"y" for a
 *  top/bottom dock, "y"/"x" for a left/right one). A shape names its long
 *  axis LOGICALLY ("row" band / "grow" pill); this pair is what turns that
 *  name into the real orientation, so no shape builder and no consumer has to
 *  know how the row is laid out. */
export interface CaptureAxes {
  row: "x" | "y"
  grow: "x" | "y"
}

/** One capture shape in SURFACE coordinates (the space pointer events arrive
 *  in). `axis` names a stadium's LONG axis LOGICALLY: "row" = the row band
 *  (length along the row axis, `thickness` along the grow axis), "grow" = a
 *  panel pill (length along the grow axis, `thickness` along the row axis).
 *  The real orientation is resolved against the `CaptureAxes` passed to the
 *  compilation. */
export type CaptureShape =
  | { kind: "disc"; x: number; y: number; d: number }
  | {
      kind: "stadium"
      axis: "row" | "grow"
      x: number
      y: number
      length: number
      thickness: number
    }

/** The compiled capture region: the rect union a wl_surface input region
 *  receives, plus the same rects as a point test. */
export interface CaptureRegion {
  unionInto(region: CairoRegion): void
  contains(x: number, y: number): boolean
  /** The union's bounding box (null when the region is empty). */
  extents(): CaptureRect | null
  readonly rectCount: number
}

/** A fresh empty cairo region (null when the cairo region API is unavailable —
 *  callers must treat null as "can't set" and leave the region unchanged). */
export function newRegion(): CairoRegion | null {
  try {
    return new (cairo as any).Region()
  } catch (e) {
    ignore("cairo region create", e)
    return null
  }
}

/** Append the chord-disc rects of a circle of diameter `d` with its top-left
 *  at (x0, y0): one centred rect per scanline from the circle equation. */
function discRects(d: number, x0: number, y0: number, out: CaptureRect[]): void {
  const r = d / 2
  for (let dy = 0; dy < d; dy++) {
    const yc = dy - r + 0.5
    const hw = Math.sqrt(Math.max(0, r * r - yc * yc))
    const width = Math.round(hw * 2)
    if (width <= 0) continue
    out.push({ x: Math.round(x0 + r - hw), y: y0 + dy, width, height: 1 })
  }
}

/** Append the rects of a stadium of the given long axis: two semicircular caps
 *  (chord math, one rect per column/scanline of the cap) + a full-width middle
 *  band (absent when there is no space between the caps). */
function stadiumRects(
  shape: CaptureShape & { kind: "stadium" },
  axes: CaptureAxes,
  out: CaptureRect[],
): void {
  const { x: xOff, y: yOff, length, thickness } = shape
  const w = thickness
  const r = w / 2
  // The long axis in SURFACE coordinates, resolved from the shape's logical
  // name. Reading either name as a fixed orientation is what rotated every
  // left/right dock's region by 90°: the bar band capped x-long on a vertical
  // row, and an open panel's stadium grew down its row instead of out along
  // the pill — so a hover on the panel (or on the icon it replaced) fell
  // outside the capture region and the router closed it.
  if (axes[shape.axis] === "y") {
    // Long axis = y (vertical stadium): caps at the bottom and the top.
    for (let dy = 0; dy < r; dy++) {
      const yc = dy - r + 0.5
      const hw = Math.sqrt(Math.max(0, r * r - yc * yc))
      const width = Math.round(hw * 2)
      if (width <= 0) continue
      const x = xOff + Math.round(r - hw)
      out.push({ x, y: yOff + dy, width, height: 1 })
      out.push({ x, y: yOff + length - 1 - dy, width, height: 1 })
    }
    const midStart = yOff + r
    const midEnd = yOff + length - r
    if (midEnd > midStart) {
      out.push({
        x: xOff,
        y: Math.round(midStart),
        width: w,
        height: Math.round(midEnd - midStart),
      })
    }
  } else {
    // Long axis = x (horizontal stadium): caps left and right, transposed.
    for (let dx = 0; dx < r; dx++) {
      const xc = dx - r + 0.5
      const hw = Math.sqrt(Math.max(0, r * r - xc * xc))
      const height = Math.round(hw * 2)
      if (height <= 0) continue
      const y = yOff + Math.round(r - hw)
      out.push({ x: xOff + dx, y, width: 1, height })
      out.push({ x: xOff + length - 1 - dx, y, width: 1, height })
    }
    const midStart = xOff + r
    const midEnd = xOff + length - r
    if (midEnd > midStart) {
      out.push({
        x: Math.round(midStart),
        y: yOff,
        width: Math.round(midEnd - midStart),
        height: w,
      })
    }
  }
}

/** The row bar's capture shape — the silhouette a substrate whose bar absorbs
 *  input across it installs: as long as the applied band along the ROW axis,
 *  `thickness` (iconSize) thick along the GROW axis, flush at the icons' grow
 *  edge. The caller supplies the live band/extents; this places and orients the
 *  shape, so the bar and the panels can never disagree about which way the row
 *  runs. */
export function bandCaptureShape(
  axes: CaptureAxes,
  opts: { growDir: 1 | -1; growDim: number; bandLen: number; thickness: number },
): CaptureShape {
  const flush = opts.growDir < 0 ? opts.growDim - opts.thickness : 0
  return {
    kind: "stadium",
    axis: "row",
    x: axes.grow === "y" ? 0 : Math.round(flush),
    y: axes.grow === "y" ? Math.round(flush) : 0,
    length: Math.round(opts.bandLen),
    thickness: opts.thickness,
  }
}

/** An open panel's capture shape: `oh` long along the GROW axis (the latched
 *  extent of the pill — never smaller than one icon), `thickness` (iconSize)
 *  along the ROW axis, flush at the icons' grow edge and placed at the applet's
 *  own row coordinate. */
export function panelCaptureShape(
  axes: CaptureAxes,
  opts: {
    growDir: 1 | -1
    growDim: number
    rowOffset: number
    oh: number
    thickness: number
  },
): CaptureShape {
  const flush = opts.growDir < 0 ? opts.growDim - opts.oh : 0
  return {
    kind: "stadium",
    axis: "grow",
    x: axes.grow === "y" ? opts.rowOffset : flush,
    y: axes.grow === "y" ? flush : opts.rowOffset,
    length: opts.oh,
    thickness: opts.thickness,
  }
}

/** Compile a shape list into the capture region: union a layer surface
 *  installs, plus the point test every substrate's router enforces. `axes`
 *  carries the surface's row/grow orientation — the ONE place a logical shape
 *  becomes real geometry, exactly as `backdrop.ts` maps its band rects through
 *  the geometry rather than assuming an orientation. */
export function compileCaptureRegion(shapes: CaptureShape[], axes: CaptureAxes): CaptureRegion {
  const rects: CaptureRect[] = []
  for (const s of shapes) {
    if (s.kind === "disc") discRects(s.d, s.x, s.y, rects)
    else stadiumRects(s, axes, rects)
  }
  let bounds: CaptureRect | null = null
  for (const r of rects) {
    if (!bounds) {
      bounds = { ...r }
      continue
    }
    const x1 = Math.max(bounds.x + bounds.width, r.x + r.width)
    const y1 = Math.max(bounds.y + bounds.height, r.y + r.height)
    bounds.x = Math.min(bounds.x, r.x)
    bounds.y = Math.min(bounds.y, r.y)
    bounds.width = x1 - bounds.x
    bounds.height = y1 - bounds.y
  }
  return {
    unionInto(region: CairoRegion): void {
      for (const r of rects) region.unionRectangle(r)
    },
    contains(x: number, y: number): boolean {
      // Integer rects vs fractional pointer coords: floor the probe, so a
      // position inside a rect's pixel is inside the region whichever edge it
      // is nearest (a point is in [x, x+width) — half-open, like the union).
      const ix = Math.floor(x)
      const iy = Math.floor(y)
      for (const r of rects) {
        if (ix >= r.x && ix < r.x + r.width && iy >= r.y && iy < r.y + r.height) return true
      }
      return false
    },
    extents: () => (bounds ? { ...bounds } : null),
    rectCount: rects.length,
  }
}
