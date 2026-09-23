/**
 * common/card/app-css.ts — the whole mount-time CSS of a card app in one
 * place: the shared theme primitives, the app's own static stylesheet, the
 * config-driven card theme + chrome blocks, and the app's own dynamic rules.
 *
 * The ink tokens every app's dynamic block needs (dim/muted/etc) are derived
 * here ONCE, so a card app cannot drift from its sisters on what "muted"
 * means for a given text colour.
 */
import { hexToRgba } from "@common/colour"
import { type CardChromeAppearance, cardChromeCss } from "@common/css/card-chrome"
import { type CardThemeAppearance, cardThemeCss } from "@common/css/card-theme"
import theme from "@common/shell/theme.css"

/** The config `appearance` block the card CSS blocks are built from. */
type CardAppearance = CardThemeAppearance & CardChromeAppearance

/** The appearance-derived ink tokens of a card app. */
interface CardPalette {
  /** Opaque text colour. */
  ink: string
  /** Secondary ink — the column beside a name. */
  text: string
  /** Icon ink — the glyph beside a name. */
  icon: string
  /** Status-line / hint ink. */
  muted: string
  /** Disabled ink. */
  dim: string
}

/** Derive the card palette from an app's `appearance.textColour`. */
export function cardPalette(appearance: { textColour: string }): CardPalette {
  return {
    ink: hexToRgba(appearance.textColour, 1),
    text: hexToRgba(appearance.textColour, 0.65),
    icon: hexToRgba(appearance.textColour, 0.85),
    muted: hexToRgba(appearance.textColour, 0.5),
    dim: hexToRgba(appearance.textColour, 0.4),
  }
}

interface CardAppCssOptions {
  /** App name: the card theme's + chrome's CSS scope (the window's class). */
  app: string
  /** The app's static stylesheet (`style.css`). */
  style: string
  /** The live `appearance` config block. */
  appearance: CardAppearance
  /** The app's own config-driven rules, appended after the shared blocks.
   *  NO BACKTICKS inside the returned string — a backtick terminates the
   *  emitted template literal and breaks the bundle SILENTLY at cold start
   *  (notes GOTCHA 13). */
  extra?: (palette: CardPalette) => string
}

/** Assemble a card app's stylesheet. */
export function cardAppCss(opts: CardAppCssOptions): string {
  return (
    theme +
    "\n" +
    opts.style +
    "\n" +
    cardThemeCss(opts.app, opts.appearance) +
    cardChromeCss(opts.appearance) +
    (opts.extra ? opts.extra(cardPalette(opts.appearance)) : "")
  )
}
