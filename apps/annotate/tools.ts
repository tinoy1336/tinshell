/**
 * annotate/tools.ts — the annotation stroke model + cairo rendering.
 *
 * All stroke geometry lives in IMAGE space (pixels of the source image).
 * The canvas replays strokes under a fit-scale transform; the export
 * replays them at scale 1 onto a pixel-sized surface. Same transform
 * composition in both places is what keeps preview and export WYSIWYG.
 *
 * gjs cairo gotcha: context methods are camelCase —
 * moveTo / lineTo / setSourceRGB / setLineCap ... NOT the C snake_case.
 * Surface export is `ImageSurface.writeToPNG` (capital PNG — there is no
 * writeToPng). Text strokes use a PangoLayout (PangoCairo.create_layout)
 * so canvas + export render identically.
 */

import Pango from "gi://Pango"
import PangoCairo from "gi://PangoCairo"
import { FONT_FAMILY } from "@common/css/tokens"
import Cairo from "cairo"

export type ToolMode = "freehand" | "highlight" | "arrow" | "rect" | "ellipse" | "text"

interface StrokeBase {
  /** hex #rrggbb */
  colour: string
  /** line width in image-space pixels */
  width: number
}

interface FreehandStroke extends StrokeBase {
  type: "freehand"
  points: [number, number][]
  /** Highlighter: translucent, wide, drawn under the rest of the ink. */
  highlighter?: boolean
}

interface ArrowStroke extends StrokeBase {
  type: "arrow"
  from: [number, number]
  to: [number, number]
}

interface RectStroke extends StrokeBase {
  type: "rect"
  from: [number, number]
  to: [number, number]
  /** Circle/ellipse inscribed in the drag rectangle (the circle tool). */
  ellipse?: boolean
}

interface TextStroke extends StrokeBase {
  type: "text"
  pos: [number, number]
  text: string
  fontSize: number
}

export type Stroke = FreehandStroke | ArrowStroke | RectStroke | TextStroke

/** Arrowhead wing length in image-space px. */
const ARROW_WING = 14

/** Highlighter geometry: a wide, translucent wash rather than a pen line. */
const HIGHLIGHT_ALPHA = 0.35
const HIGHLIGHT_WIDTH_MULT = 3

/** Parse #rrggbb → [r, g, b] 0..1. Unknown → neutral grey. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0.15, 0.15, 0.15]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

function dot(cr: any, x: number, y: number, r: number): void {
  cr.moveTo(x + r, y)
  cr.arc(x, y, r, 0, 2 * Math.PI)
  cr.fill()
}

/**
 * Replay one stroke onto a cairo context. `scale` maps image-space units to
 * device pixels — the canvas passes the fit scale, the export passes 1.
 */
export function renderStroke(cr: any, stroke: Stroke, scale: number): void {
  const [r, g, b] = hexToRgb(stroke.colour)
  cr.save()
  cr.scale(scale, scale)
  if (stroke.type === "freehand" && stroke.highlighter) cr.setSourceRGBA(r, g, b, HIGHLIGHT_ALPHA)
  else cr.setSourceRGB(r, g, b)

  switch (stroke.type) {
    case "freehand": {
      const pts = stroke.points
      if (pts.length === 0) break
      const width = stroke.highlighter ? stroke.width * HIGHLIGHT_WIDTH_MULT : stroke.width
      if (pts.length === 1) {
        dot(cr, pts[0][0], pts[0][1], Math.max(width / 2, 1))
        break
      }
      cr.setLineWidth(width)
      cr.setLineCap(Cairo.LineCap.ROUND)
      cr.setLineJoin(Cairo.LineJoin.ROUND)
      cr.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length; i++) cr.lineTo(pts[i][0], pts[i][1])
      cr.stroke()
      break
    }
    case "arrow": {
      const [x0, y0] = stroke.from
      const [x1, y1] = stroke.to
      const dx = x1 - x0
      const dy = y1 - y0
      const len = Math.hypot(dx, dy)
      if (len < 1) {
        dot(cr, x1, y1, Math.max(stroke.width / 2, 1))
        break
      }
      const ang = Math.atan2(dy, dx)
      const wing = Math.max(ARROW_WING, stroke.width * 4)
      cr.setLineWidth(stroke.width)
      cr.setLineCap(Cairo.LineCap.ROUND)
      cr.setLineJoin(Cairo.LineJoin.ROUND)
      cr.moveTo(x0, y0)
      cr.lineTo(x1, y1)
      cr.stroke()
      // Two 30-degree wings behind the tip.
      for (const sign of [1, -1]) {
        const a = ang + sign * (Math.PI / 6)
        cr.moveTo(x1, y1)
        cr.lineTo(x1 - wing * Math.cos(a), y1 - wing * Math.sin(a))
        cr.stroke()
      }
      break
    }
    case "rect": {
      const [x0, y0] = stroke.from
      const [x1, y1] = stroke.to
      cr.setLineWidth(stroke.width)
      cr.setLineCap(Cairo.LineCap.ROUND)
      cr.setLineJoin(Cairo.LineJoin.ROUND)
      if (stroke.ellipse) {
        const rx = Math.abs(x1 - x0) / 2
        const ry = Math.abs(y1 - y0) / 2
        // scale() then arc(): the stroke is transformed, the line width is not.
        if (rx < 0.5 || ry < 0.5) break
        cr.save()
        cr.translate((x0 + x1) / 2, (y0 + y1) / 2)
        cr.scale(rx, ry)
        cr.arc(0, 0, 1, 0, 2 * Math.PI)
        cr.restore()
        cr.stroke()
        break
      }
      cr.rectangle(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
      cr.stroke()
      break
    }
    case "text": {
      const layout = PangoCairo.create_layout(cr)
      layout.set_text(stroke.text, -1)
      const fd = Pango.FontDescription.from_string(`${FONT_FAMILY} ${stroke.fontSize}px`)
      layout.set_font_description(fd)
      layout.set_alignment(Pango.Alignment.LEFT)
      cr.moveTo(stroke.pos[0], stroke.pos[1])
      PangoCairo.show_layout(cr, layout)
      break
    }
  }

  cr.restore()
}
