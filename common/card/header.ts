/**
 * common/card/header.ts — the card header row and its glyph controls.
 *
 * MDI codepoints sit above the BMP, so the escape MUST carry braces:
 * "\u{f004d}" is the back arrow; the same hex digits written unbraced parse
 * as U+F004 followed by a literal "d". Verify with the `nf` tool
 * (nf search / nf audit).
 */
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"

export const GLYPH = {
  back: "\u{f004d}", // md-arrow_left
  fwd: "\u{f0054}", // md-arrow_right
  up: "\u{f005d}", // md-arrow_up
  eye: "\u{f0208}", // md-eye
  eyeOff: "\u{f0209}", // md-eye_off
  reload: "\u{f0453}", // md-reload
  // md-home_variant, not md-home: GTK centres the glyph's ADVANCE box (the
  // 0.6 em monospace cell). md-home's artwork overflows that cell from its left
  // edge, so its ink centre lands ~20% of the advance right of the button
  // centre — obvious next to the arrow glyph. md-home_variant overflows far
  // less and reads centred.
  home: "\u{f02de}", // md-home_variant
  chevron: "\u{f0142}", // md-chevron_right
  newFolder: "\u{f0257}", // md-folder_plus
} as const

/** Horizontal header box with the app's css class + spacing. */
export function headerBox(cssClass: string, spacing = 2): Gtk.Box {
  const box = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing,
    hexpand: true,
  })
  box.add_css_class(cssClass)
  return box
}

/** Flat glyph nav button (label glyph + tooltip + app css class). */
export function glyphButton(cssClass: string, glyph: string, tip: string): Gtk.Button {
  const b = new Gtk.Button({ label: glyph })
  // Space-separated class list (Gtk.Button.add_css_class takes one name).
  for (const c of cssClass.split(/\s+/).filter(Boolean)) b.add_css_class(c)
  b.set_tooltip_text(tip)
  centreGlyphInk(b, glyph)
  return b
}

/** The card header's standard flat glyph button. */
export function headerButton(glyph: string, tip: string): Gtk.Button {
  return glyphButton("card-btn", glyph, tip)
}

interface CardHeaderOptions {
  /** Spacing between the row's controls (default 2). */
  spacing?: number
  /** Controls before the title slot, left to right. */
  leading?: Gtk.Widget[]
  /** The title slot — a path bar (common/card/path-bar) or a path label. It
   *  stretches only if the widget itself is set to hexpand. */
  title?: Gtk.Widget
  /** Controls after the title slot, left to right. */
  trailing?: Gtk.Widget[]
}

/** The card header row: a `card-header` box with leading / title / trailing
 *  slots, in that order. The caller keeps every control it needs to drive
 *  (sensitivity, label swap) — the row only places them. */
export function createCardHeader(opts: CardHeaderOptions = {}): Gtk.Box {
  const box = headerBox("card-header", opts.spacing ?? 2)
  for (const w of opts.leading ?? []) box.append(w)
  if (opts.title) box.append(opts.title)
  for (const w of opts.trailing ?? []) box.append(w)
  return box
}

/** Optical centring for an icon button.
 *
 * GTK centres the label's LOGICAL box, and a Nerd Font glyph's artwork is
 * often wider than the monospace advance cell it sits in (MDI icons run
 * ~0.83 em of ink in a 0.6 em cell) — the ink then overflows to the right and
 * the icon reads off-centre (md-eye +27% of the advance, md-reload +23%,
 * md-home +20%, while the narrow md-arrow_up only +5%).
 *
 * Measure the ink against the logical box once the widget is mapped (that is
 * when the CSS font size is in effect) and add a trailing margin, which
 * shifts the label — and with it the visible ink — back onto the centre line.
 * Cosmetic only: any failure leaves the button exactly as it was. */
function centreGlyphInk(button: Gtk.Button, glyph: string): void {
  button.connect("map", () => {
    try {
      const label = button.get_child()
      if (!label) return
      const layout = Pango.Layout.new(label.get_pango_context())
      layout.set_text(glyph, -1)
      const [ink, logical] = layout.get_extents()
      if (!ink || !logical) return
      const dx = Math.round((ink.x + ink.width / 2 - (logical.x + logical.width / 2)) / Pango.SCALE)
      // margin_end = 2*dx shifts the label left by dx at the button's centre.
      label.set_margin_end(dx > 0 ? dx * 2 : 0)
    } catch {
      // Metrics are decorative — never let them break the control.
    }
  })
}
