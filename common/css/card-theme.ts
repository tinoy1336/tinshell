/**
 * Shared dynamic-CSS card theme — the config-driven rules every card window
 * emits identically (window card background + row selection/hover), built
 * from the appearance config via hexToRgba. App-specific rules stay in each
 * app's own mount CSS block (files assembles its block through
 * common/card/app-css).
 */
import { hexToRgba } from "@common/colour"

export interface CardThemeAppearance {
  cardColour: string
  cardAlpha: number
  selectionColour: string
  hoverColour: string
}

/** `window.<cssClass>` card rules shared by every card window app. */
export function cardThemeCss(cssClass: string, a: CardThemeAppearance): string {
  const card = hexToRgba(a.cardColour, a.cardAlpha)
  return `window.${cssClass} { background: ${card}; }
window.${cssClass} row:selected { background: ${a.selectionColour}; }
window.${cssClass} row:hover { background: ${a.hoverColour}; }
`
}
