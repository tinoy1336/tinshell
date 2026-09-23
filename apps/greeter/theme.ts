/**
 * greeter/theme — the greeter's COLOUR layer (the greeter paints no surface).
 *
 * With no panel behind the clock and the fields, every colour has to hold its
 * own contrast against a wallpaper of unknown brightness. The greeter therefore
 * owns no palette: it derives from the SAME tokens the dock's discs and the
 * centred menus read — `appearance.menu` (bg / rowHighlight / rowActive / text
 * / mutedText / accent / danger / glowAlpha), `appearance.textShadow` and
 * `appearance.glyphColour` (schema: common/applets/config.schema.ts) — out of the
 * dock config the greeter already loads for the applet strip (config.ts
 * `dockConfigView()`). With that config readable, this CSS tracks the suite by
 * itself; nothing here is a second source of truth.
 *
 * `MIRRORED_DEFAULTS` is the ONE place the greeter carries suite numbers: the
 * fallback for a deployment where the dock config is not readable (the pre-login
 * `greeter` user — the dock trio under /etc/greetd/ags-greeter/dock is a root
 * copy, install.sh's manual step). The values reproduce
 * apps/dock/config.defaults.json (`appearance.menu`, `appearance.textShadow`)
 * verbatim; re-mirror them if that palette changes.
 *
 * Style only — layouts, radii and paddings stay in style.css; the rules here
 * carry colour properties alone.
 */
import type { AppletConfig } from "@common/applets/config"
import { dockConfigView } from "./config"

/** The dock/menu colour idiom: `rgb` as 0..1 floats, `alpha` 0..1. */
export interface CfgColour {
  rgb: number[]
  alpha: number
}

interface GreeterPalette {
  /** menu.text — clock, entry text, button labels. */
  text: CfgColour
  /** menu.mutedText — the glyphs at rest, which sit on the field glass; NOT for
   *  text over the wallpaper (0.65 grey does not carry contrast there — see the
   *  legibility note in greeterThemeCss). */
  mutedText: CfgColour
  /** menu.accent — focus edge, caret, glyph hover. */
  accent: CfgColour
  /** menu.danger — the wrong-password text and mask. */
  danger: CfgColour
  /** menu.bg — the suite's dark glass; the fields' and buttons' scrim. */
  glass: CfgColour
  /** menu.rowHighlight — the resting edge drawn on that glass. */
  row: CfgColour
  /** menu.rowActive — the hover/selected lightening over that glass. */
  rowActive: CfgColour
  /** appearance.textShadow — the suite's device for text over unknown backdrops. */
  shadow: CfgColour
  shadowOffset: number
  /** menu.glowAlpha — the glyph hover halo (the menus' convention). */
  glowAlpha: number
}

/** apps/dock/config.defaults.json — appearance.menu + appearance.textShadow. */
export const MIRRORED_DEFAULTS: GreeterPalette = {
  text: { rgb: [0.9, 0.9, 0.9], alpha: 0.9 },
  mutedText: { rgb: [0.65, 0.65, 0.65], alpha: 0.8 },
  accent: { rgb: [0.54, 0.71, 0.97], alpha: 0.95 },
  danger: { rgb: [0.9, 0.3, 0.3], alpha: 0.9 },
  glass: { rgb: [0.04, 0.05, 0.07], alpha: 0.55 },
  row: { rgb: [1, 1, 1], alpha: 0.1 },
  rowActive: { rgb: [1, 1, 1], alpha: 0.16 },
  shadow: { rgb: [0, 0, 0], alpha: 0.44 },
  shadowOffset: 1,
  glowAlpha: 0.22,
}

function fromAppearance(a: AppletConfig["appearance"]): GreeterPalette {
  const m = a.menu
  return {
    text: m.text,
    mutedText: m.mutedText,
    accent: m.accent,
    danger: m.danger,
    glass: m.bg,
    row: m.rowHighlight,
    rowActive: m.rowActive,
    shadow: { rgb: a.textShadow.rgb, alpha: a.textShadow.alpha },
    shadowOffset: a.textShadow.offset,
    glowAlpha: m.glowAlpha,
  }
}

/** The live palette: the suite's tokens when the dock config is readable, the
 *  mirrored defaults otherwise. Cached — the source cannot change under a
 *  running process (dockConfigView() is cached for the same reason). */
let cached: GreeterPalette | undefined

export function greeterPalette(): GreeterPalette {
  if (cached) return cached
  const view = dockConfigView()
  cached = view ? fromAppearance(view.config.appearance) : MIRRORED_DEFAULTS
  return cached
}

/**
 * The INPUT FIELDS' accent — a deliberate, NAMED divergence from the suite tokens.
 *
 * The fields' focus edge, caret and in-field glyph glow use the greeter's own
 * off-white (menu.text — the clock/entry text family) instead of the suite's blue
 * `menu.accent`. Only the field rules read this; every OTHER accent consumer keeps
 * the token (the session buttons' selected edge, the shared glow alpha, the
 * shared glyph modules). The user wants the input fields to read as one piece with
 * the clock and the entry text, not to carry a second hue — change it here, not by
 * editing `menu.accent` (which would leak into everything else reading the
 * palette) and not as a hex in style.css.
 */
export function fieldAccent(p: GreeterPalette = greeterPalette()): CfgColour {
  return { rgb: [...p.text.rgb], alpha: p.text.alpha }
}

function scaled(rgb: number[]): [number, number, number] {
  // The suite's tokens are 0..1 floats; tolerate 0..255 (the schema-build `rgb()`
  // idiom) so a config authored either way lands on the same colour.
  const s = (v: number, i: number): number => (rgb[i] > 1 ? v : v * 255)
  return [Math.round(s(rgb[0], 0)), Math.round(s(rgb[1], 1)), Math.round(s(rgb[2], 2))]
}

/** CSS `rgba(...)`, alpha overridable (composite states). */
function rgbaCss(c: CfgColour, alpha = c.alpha): string {
  const [r, g, b] = scaled(c.rgb)
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`
}

/** Cairo-style rgba 0..1 (the glyph painters take these). */
type Rgba = [number, number, number, number]

export function rgbaTuple(c: CfgColour, alpha = c.alpha): Rgba {
  return [c.rgb[0], c.rgb[1], c.rgb[2], alpha]
}

/** Exact source-over composite of two translucent layers — one fill for a state
 *  the menus build by stacking (their rowActive over their glass). Independent of
 *  the backdrop, so the emitted colour is the same on every wallpaper. */
export function blend(top: CfgColour, bottom: CfgColour): CfgColour {
  const a = top.alpha + bottom.alpha * (1 - top.alpha)
  if (a <= 0) return { rgb: [0, 0, 0], alpha: 0 }
  const rgb = [0, 1, 2].map(
    (i) => (top.rgb[i] * top.alpha + bottom.rgb[i] * bottom.alpha * (1 - top.alpha)) / a,
  )
  return { rgb, alpha: Number(a.toFixed(4)) }
}

/** The greeter's colour rules (the greeter appends this AFTER style.css). */
export function greeterThemeCss(p: GreeterPalette = greeterPalette()): string {
  const shadow = `text-shadow: 0 ${p.shadowOffset}px 2px ${rgbaCss(p.shadow)}`
  const glassFill = rgbaCss(p.glass)
  // OFF-TOKEN by design: the fields carry the off-white text tone, not menu.accent
  // (see fieldAccent()). Every other accent rule below keeps the token.
  const field = rgbaCss(fieldAccent(p))
  return `
/* ── generated from the suite palette (see theme.ts) — colours only ── */
/* Legibility: over the wallpaper only the suite's TEXT tone carries contrast
 * (menu.text at full-ish alpha + the suite's text shadow — the dock's own device
 * for text on an unknown backdrop). menu.mutedText is reserved for the field
 * glyphs, which sit on the glass and do have contrast there. The secondary
 * hierarchy is carried by SIZE (56px clock vs 16px date), not by a dimmer grey:
 * measured on a bright wallpaper a 0.65 grey reads 2.4:1 — not usable. */
.greeter-clock-time {
  color: ${rgbaCss(p.text)};
  ${shadow};
}
.greeter-clock-date {
  color: ${rgbaCss(p.text, 0.95)};
  ${shadow};
}
/* The kept field wells: the suite's dark glass, so the entry text keeps its
 * contrast on any wallpaper (the menus' own scrim, one tone darker than the
 * previous light well). */
.greeter-field {
  background: ${glassFill};
  border-color: ${rgbaCss(p.row)};
}
.greeter-field:focus-within {
  border-color: ${field};
}
.greeter-entry {
  color: ${rgbaCss(p.text)};
  caret-color: ${field};
}
.greeter-entry-error {
  color: ${rgbaCss(p.danger)};
  caret-color: ${rgbaCss(p.danger)};
}
.greeter-status {
  color: ${rgbaCss(p.text, 0.95)};
  ${shadow};
}
.greeter-status-error {
  color: ${rgbaCss(p.danger)};
}
.greeter-status-info {
  color: ${rgbaCss(p.text, 0.95)};
}
.greeter-session-btn {
  background: ${glassFill};
  border-color: ${rgbaCss(p.row)};
  color: ${rgbaCss(p.text)};
}
.greeter-session-btn:hover {
  background: ${rgbaCss(blend(p.rowActive, p.glass))};
}
.greeter-session-btn.selected {
  background: ${rgbaCss(blend(p.rowActive, p.glass))};
  border-color: ${rgbaCss(p.accent)};
  color: ${rgbaCss(p.text)};
}
.greeter-sessions-empty {
  color: ${rgbaCss(p.text, 0.95)};
}
/* The lock surface's own opaque backdrop: the glass tone at full alpha (login
 * and preview show the compositor's wallpaper instead). */
window.greeter-lock {
  background: ${rgbaCss({ rgb: p.glass.rgb, alpha: 1 })};
}
`
}
