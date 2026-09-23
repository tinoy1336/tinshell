/**
 * passwordEye — the show/hide password toggle.
 *
 * Wraps the shared hoverGlyph with the standard eye glyphs (eye-slash
 * \uf070 while hidden, eye \uf06e when shown) and wires the
 * visibility toggle onto a Gtk.Entry. Used by promptd's askpass, the
 * greeter's login card and the dock's wifi password entry.
 *
 * `maskedClass` (optional): a CSS class applied ONLY while masked and removed
 * on reveal — used by the greeter for letter-spaced hidden dots, so the
 * revealed text keeps normal character spacing.
 */
import type Gtk from "gi://Gtk"
import { FONT_FAMILY } from "@common/css/tokens"
import { hoverGlyph } from "./hover-glyph"

interface PasswordEyeOpts {
  /** Resolves the target entry at click time (the glyph may be created
   *  before the entry is built). */
  getEntry: () => Gtk.Entry | null
  /** Square glyph box (default 28). */
  box?: number
  /** Glyph font size (default 15). */
  fontSize?: number
  /** Rest colour, rgba 0..1 (default muted grey 0.75). */
  rest?: [number, number, number, number]
  /** Hover glow alpha (default 0.18). */
  glowAlpha?: number
  /** Class applied while masked, removed on reveal. */
  maskedClass?: string
  /** Alternate glyphs (the dock uses config-driven emoji). */
  emojiHidden?: string
  emojiShown?: string
  /** Called after the mask state flips (callers that drive their own
   *  masked-class logic — e.g. spacing dots only when there is text). */
  onToggle?: (masked: boolean) => void
}

export function passwordEye(opts: PasswordEyeOpts): {
  widget: Gtk.DrawingArea
  isMasked(): boolean
} {
  let masked = true
  const { getEntry, maskedClass, emojiHidden = "\uf070", emojiShown = "\uf06e" } = opts

  const glyph = hoverGlyph({
    emoji: () => (masked ? emojiHidden : emojiShown),
    box: opts.box ?? 28,
    fontSize: opts.fontSize ?? 15,
    rest: opts.rest ?? [0.75, 0.75, 0.75, 1],
    fontFamily: FONT_FAMILY,
    hover: { colour: [1, 1, 1, 1], glow: [1, 1, 1, 1], glowAlpha: opts.glowAlpha ?? 0.18 },
    ownHover: true,
    onClick: () => {
      masked = !masked
      const entry = getEntry()
      if (entry) {
        if (maskedClass) {
          if (masked) entry.add_css_class(maskedClass)
          else entry.remove_css_class(maskedClass)
        }
        entry.set_property("visibility", !masked)
      }
      opts.onToggle?.(masked)
    },
  })

  return { widget: glyph.widget, isMasked: () => masked }
}
