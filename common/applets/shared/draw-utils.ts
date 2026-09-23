/**
 * Cairo drawing primitives for applet icons and rings.
 *
 * All visible content in the dock is Cairo-drawn (per the spec: "No PNGs, no
 * SVGs, no GTK labels"). These primitives are the lowest layer — every applet
 * icon composes a disc + glyph + ring arcs from them.
 *
 * Colour convention: all colours are Cairo RGBA tuples, each channel 0..1.
 */

import type { AppletConfig } from "@common/applets/config"

// ── Types ──

/** A non-overlapping ring arc segment. Drawn in declaration order by drawRings. */
export interface RingSpec {
  start: number // 0-100 start percentage
  end: number // 0-100 end percentage
  colour: [number, number, number, number]
}

/**
 * A ring that starts at a common base angle and sweeps independently. Used by
 * drawOverlapRings for CPU+RAM-style rings that share a start point.
 */
export interface OverlapRing {
  value: number // 0–100, how far this ring sweeps
  colour: [number, number, number, number]
  radiusOffset?: number // push ring outward (stack rings radially)
  thickness?: number // per-ring override
}

// ── Primitives ──

/** Clamp v to [0, 1]. Used for ringFill / intro clamps in the applet draws. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// ── Pill-backdrop alpha compensation ──
// Discs paint OVER the shared surface's translucent pill backdrop, and
// OVER-compositing stacks the alphas: the disc-over-band composite reads more
// opaque than the disc's configured alpha. The shared surface renderer latches
// the compensation ON (common/applets/surface/surface.ts module scope) — that
// is the module painting the backdrop under the discs, for every host (the
// dock's layer-shell band and the greeter's embedded strip alike). Effective
// disc alpha over any backdrop layer (the icon strip AND the open-panel
// stadium — same alpha) = discAlpha − pillAlpha, clamped ≥ 0. Read LIVE from
// config so appearance changes restyle without re-latching.
let discOverBackdrop = false

/** Latch the backdrop alpha compensation for this process's discs. */
export function setDiscOverBackdrop(v: boolean): void {
  discOverBackdrop = v
}

/** Any disc paint alpha, backdrop-compensated on the shared surface (the
 *  disabled-disc variants pass explicit colours — same backdrop beneath). */
export function compensatedAlpha(alpha: number, config: AppletConfig): number {
  return discOverBackdrop ? clamp01(alpha - config.appearance.backdrop.alpha) : alpha
}

/** The alpha the standard disc paints with: backdrop-compensated on the
 *  shared surface, raw everywhere else. */
export function effectiveDiscAlpha(config: AppletConfig): number {
  return compensatedAlpha(config.appearance.disc.alpha, config)
}

/**
 * The surface LIFT: the layer that raises the backdrop's own paint (the bar's
 * base glass) to the tone the bar and an open panel's unfilled surface read at.
 * ONE source for both surfaces that wear it:
 *
 *   - the dock strip / stadiums' visible tone (the backdrop base + this lift,
 *     painted where no disc sits — see `drawPillBackdrop`'s `lift` input), and
 *   - the panel's unfilled region (`trackColour` in the panel framework).
 *
 * The discs never composite over it: a disc's rendered colour stays exactly the
 * backdrop base + the disc's own weight, i.e. it keeps the tone it had before
 * the bar's tone was raised, with no dependence on this lift.
 *
 * Derived from the live config (`unfilled.rgb` at half the disc's on-surface
 * weight) so a retune of the palette moves all three together.
 */
export function backdropLiftColour(config: AppletConfig): number[] {
  return [...config.appearance.unfilled.rgb, effectiveDiscAlpha(config) / 2]
}

/**
 * Draw a frosted-glass disc centred at (cx, cy). This is the icon background
 * — the translucent white circle every applet sits on.
 */
export function drawDisc(
  config: AppletConfig,
  cr: any,
  cx: number,
  cy: number,
  radius: number,
  colour?: [number, number, number, number],
): void {
  const c =
    colour ??
    ([...config.appearance.disc.rgb, effectiveDiscAlpha(config)] as [
      number,
      number,
      number,
      number,
    ])
  cr.setSourceRGBA(...c)
  cr.arc(cx, cy, radius, 0, Math.PI * 2)
  cr.fill()
}

/**
 * Draw non-overlapping ring arcs in declaration order. Each ring sweeps from its
 * start% to its end%, measured clockwise from the top (-π/2).
 *
 * `ringFill` (0→1) shrink-wraps every ring's arc toward the top centre: both the
 * start and end angles scale by `rf`. This is the close-animation contract — at
 * ringFill=0 nothing is drawn, at ringFill=1 the full arc shows. Volume/Brightness
 * drive ringFill via the panel's icon-travel animation.
 */
export function drawRings(
  cr: any,
  cx: number,
  cy: number,
  radius: number,
  thickness: number,
  rings: RingSpec[],
  ringFill: number = 1,
  capStyle: number = 1, // CAIRO_LINE_CAP_ROUND (default); pass 0 for CAIRO_LINE_CAP_BUTT
  baseAngle: number = -Math.PI / 2,
): void {
  const rf = Math.max(0, Math.min(1, ringFill))
  if (rf < 0.001) return
  cr.setLineWidth(thickness)
  cr.setLineCap(capStyle)
  for (const ring of rings) {
    const s = Math.max(0, Math.min(ring.start, 100))
    const e = Math.max(s, Math.min(ring.end, 100))
    if (e <= s) continue
    const a1 = baseAngle + ((Math.PI * 2 * s) / 100) * rf
    const a2 = baseAngle + ((Math.PI * 2 * e) / 100) * rf
    cr.setSourceRGBA(ring.colour[0], ring.colour[1], ring.colour[2], ring.colour[3])
    cr.arc(cx, cy, radius, a1, a2)
    cr.stroke()
  }
}

/**
 * Draw overlapping rings that share a common start angle.
 *
 * Rings are decomposed into non-overlapping angular segments, each with a pre-
 * blended colour. The segments are drawn via drawRings with BUTT caps so
 * adjacent bands meet flush. No compositing operators — uniform alpha everywhere,
 * including at ring intersections (the pill pattern; see panel-framework.tsx).
 *
 * Colour blending for overlapping bands uses the SCREEN-equivalent formula
 * (1 - ∏(1 - c)) per RGB channel so the overlap is brighter than either ring
 * alone, matching SCREEN compositing without alpha accumulation.
 *
 * Rings with different `radiusOffset` values never overlap geometrically so
 * they are drawn independently (each as its own single segment). Same-radius
 * rings (the common case, e.g. CPU + RAM) are decomposed into N bands for N
 * sorted values.
 */
export function drawOverlapRings(
  cr: any,
  cx: number,
  cy: number,
  radius: number,
  thickness: number,
  rings: OverlapRing[],
  baseAngle: number = -Math.PI / 2,
  ringFill: number = 1,
): void {
  const rf = Math.max(0, Math.min(1, ringFill))
  if (rf < 0.001) return

  // Filter to rings with a visible sweep.
  const active = rings.filter((r) => r.value > 0 && r.value <= 100)
  if (active.length === 0) return

  // Group rings by radius so same-radius rings are decomposed together.
  const groups = new Map<number, OverlapRing[]>()
  for (const ring of active) {
    const r = radius + (ring.radiusOffset ?? 0)
    const g = groups.get(r)
    if (g) g.push(ring)
    else groups.set(r, [ring])
  }

  for (const [r, group] of groups) {
    const t = group[0].thickness ?? thickness

    if (group.length === 1) {
      // Single ring at this radius — no overlap, draw directly.
      const ring = group[0]
      drawRings(
        cr,
        cx,
        cy,
        r,
        t,
        [
          {
            start: 0,
            end: ring.value,
            colour: ring.colour,
          },
        ],
        ringFill,
        0,
        baseAngle,
      ) // BUTT caps
      continue
    }

    // Two or more rings at the same radius — decompose into non-overlapping bands.
    // Sort by sweep value ascending.
    const sorted = [...group].sort((a, b) => a.value - b.value)

    // SCREEN-equivalent blend for N colours (per RGB channel, ignoring alpha —
    // alpha comes from the contributing ring's own alpha, blended by averaging).
    const blendScreen = (
      colours: [number, number, number, number][],
    ): [number, number, number, number] => {
      let rBlend = 0,
        gBlend = 0,
        bBlend = 0,
        aBlend = 0
      // SCREEN-equivalent: 1 - ∏(1 - c_i) for each channel.
      let rProd = 1,
        gProd = 1,
        bProd = 1
      for (const c of colours) {
        rProd *= 1 - c[0]
        gProd *= 1 - c[1]
        bProd *= 1 - c[2]
        aBlend += c[3]
      }
      rBlend = 1 - rProd
      gBlend = 1 - gProd
      bBlend = 1 - bProd
      // Average alpha across contributing rings.
      const a = aBlend / colours.length
      return [rBlend, gBlend, bBlend, a]
    }

    // Build bands: each band spans [prev, current.value] and includes all
    // rings whose sweep ≥ current.value (those that reach past this band).
    const segments: RingSpec[] = []
    let prev = 0
    for (const ring of sorted) {
      if (ring.value <= prev) continue
      const contributing = sorted.filter((x) => x.value >= ring.value)
      segments.push({
        start: prev,
        end: ring.value,
        colour: blendScreen(contributing.map((x) => x.colour)),
      })
      prev = ring.value
    }

    if (segments.length > 0) {
      drawRings(cr, cx, cy, r, t, segments, ringFill, 0, baseAngle) // BUTT caps
    }
  }
}

/**
 * Draw a glyph centred at (cx, cy). Uses the canonical two-subtraction
 * centring formula from text extents (width/2 + xBearing, height/2 + yBearing)
 * — this is pixel-accurate where naive width/2 centring is not.
 *
 * `shadowAlpha`: when > 0, draw a config-colored offset copy first (same style
 * as the inline shadows in Performance/Battery/Power) for legibility against the
 * translucent disc + blurred background. Defaults to 0 (no shadow); pass a value
 * > 0 to enable.
 */
export function drawGlyph(
  config: AppletConfig,
  cr: any,
  cx: number,
  cy: number,
  text: string,
  fontSize: number,
  colour: [number, number, number, number] = [
    config.appearance.glyphColour.rgb[0],
    config.appearance.glyphColour.rgb[1],
    config.appearance.glyphColour.rgb[2],
    config.appearance.glyphColour.alpha,
  ] as [number, number, number, number],
  family: string = config.fonts.family,
  shadowAlpha: number = 0,
  // Cairo font weight: 0 = NORMAL, 1 = BOLD (gjs takes the raw enum value).
  weight: 0 | 1 = 0,
): void {
  const sh = config.appearance.textShadow
  cr.selectFontFace(family, 0, weight)
  cr.setFontSize(fontSize)
  const ext = cr.textExtents(text)
  const tx = cx - ext.width / 2 - ext.xBearing
  const ty = cy - ext.height / 2 - ext.yBearing
  if (shadowAlpha > 0) {
    cr.setSourceRGBA(sh.rgb[0], sh.rgb[1], sh.rgb[2], shadowAlpha)
    cr.moveTo(tx + sh.offset, ty + sh.offset)
    cr.showText(text)
  }
  cr.setSourceRGBA(...colour)
  cr.moveTo(tx, ty)
  cr.showText(text)
}

/**
 * Get the centre and radius for a size-constrained drawing area. Uses the
 * min(w,h) convention so non-square allocations still centre correctly.
 */
export function layoutBox(w: number, h: number): { cx: number; cy: number } {
  const size = Math.min(w, h)
  return { cx: size / 2, cy: size / 2 }
}
