/**
 * hoverGlyph — the shared Cairo glyph primitive.
 * At rest the glyph draws in `rest`; on hover it
 * brightens to `hover.colour` at full alpha with a soft `hover.glow`-tinted
 * radial halo behind it (core alpha = glowAlpha, proportional falloff).
 * Returns the DrawingArea and a setHover() setter so rows can drive glyph
 * hover from their own motion controller; pass ownHover for standalone
 * interactive glyphs (action buttons, the eyeball).
 *
 * GJS Cairo has NO cr.createRadialGradient — build the pattern with the
 * cairo.RadialGradient constructor instead (the context-method call threw
 * every frame).
 *
 * Colours are plain [r, g, b, a] tuples (0..1) — no config coupling; the
 * caller resolves its palette. Cairo has no font fallback: pass a Nerd Font
 * family and use Nerd Font glyph codepoints.
 */

import cairo from "gi://cairo"
import Gtk from "gi://Gtk"

interface HoverGlyphOpts {
  /** Nerd Font glyph, or a live-resolving getter (the eyeball swaps glyphs). */
  emoji: string | (() => string)
  /** Square drawing-area size. The glow halo radius = box/2, so it scales
   *  with the element: 15px row glyphs → 7.5px halo, 24px action → 12px. */
  box: number
  /** Glyph font size. */
  fontSize: number
  /** Colour at rest, rgba 0..1. */
  rest: [number, number, number, number]
  /** Nerd Font family for the glyph. */
  fontFamily: string
  /** Hover treatment: glyph brightens to `colour` (full alpha), radial
   *  `glow` halo behind (core alpha = glowAlpha ?? 0.22). */
  hover?: {
    colour: [number, number, number, number]
    glow: [number, number, number, number]
    glowAlpha?: number
  }
  /** Attach the glyph's own motion controller (hover = the glyph itself).
   *  Off for row glyphs, whose hover is driven by the row via setHover. */
  ownHover?: boolean
  /** Non-interactive: always draws `rest` — no hover brighten, no glow
   *  (rows without an action use flat glyphs). */
  flat?: boolean
  onClick?: () => void
}

export function hoverGlyph(opts: HoverGlyphOpts): {
  widget: Gtk.DrawingArea
  setHover(v: boolean): void
} {
  const da = new Gtk.DrawingArea()
  da.set_size_request(opts.box, opts.box)
  let hover = false
  da.set_draw_func((_d: any, cr: any, w: number, h: number) => {
    const emoji = typeof opts.emoji === "function" ? opts.emoji() : opts.emoji
    const hov = hover && !opts.flat && !!opts.hover
    if (hov) {
      const g = opts.hover!.glow
      // SUBTLE: a soft halo sized to the glyph box, not a disc.
      const glow = new (cairo as any).RadialGradient(w / 2, h / 2, 0.5, w / 2, h / 2, w / 2)
      const a = opts.hover!.glowAlpha ?? 0.22
      glow.addColorStopRGBA(0, g[0], g[1], g[2], a)
      glow.addColorStopRGBA(0.6, g[0], g[1], g[2], a * 0.36)
      glow.addColorStopRGBA(1, g[0], g[1], g[2], 0)
      cr.setSource(glow)
      cr.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2)
      cr.fill()
    }
    const rest = opts.rest
    const c = hov ? opts.hover!.colour : rest
    cr.selectFontFace(opts.fontFamily, 0, 0)
    cr.setFontSize(opts.fontSize)
    const ext = cr.textExtents(emoji)
    cr.moveTo(w / 2 - ext.width / 2 - ext.xBearing, h / 2 - ext.height / 2 - ext.yBearing)
    cr.setSourceRGBA(c[0], c[1], c[2], hover ? 1 : Math.min(1, rest[3]))
    cr.showText(emoji)
  })
  if (opts.ownHover) {
    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => {
      hover = true
      da.queue_draw()
    })
    motion.connect("leave", () => {
      hover = false
      da.queue_draw()
    })
    da.add_controller(motion)
  }
  if (opts.onClick) {
    const click = new Gtk.GestureClick()
    click.connect("pressed", () => {
      opts.onClick!()
      da.queue_draw()
    })
    da.add_controller(click)
  }
  return {
    widget: da,
    setHover: (v: boolean) => {
      if (hover !== v) {
        hover = v
        da.queue_draw()
      }
    },
  }
}
