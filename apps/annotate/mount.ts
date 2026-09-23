/**
 * annotate mount — the screenshot-annotation editor builder.
 *
 * Shared by the island app.ts (instanceName "annotate", io.Astal.annotate —
 * the DEV island, no unit, on-demand) and the shell instance. The
 * editor window is created on demand via files/open-style requests.
 */
import "./commands" // side-effect: registers request handlers
import { isProductionShell } from "@common/app/mode"
import { cardAppCss } from "@common/card/app-css"
import { applyChromeOverride } from "@common/card/chrome-override"
import { hexToRgba } from "@common/colour"
import { fileSink, setSink } from "@common/log/logger"
import { get as getConfig } from "./config"
import style from "./style.css"

// Launched from a notification action (no systemd, no journald) — log to a
// file or the diagnostics vanish with the terminal (files pattern). Skipped
// only in the production shell (which owns the one global sink).
if (!isProductionShell) {
  setSink(fileSink("/tmp/tinshell-annotate-debug.log"), "[annotate]")
}

const appearance = getConfig("appearance")

export const annotateCss = cardAppCss({
  app: "annotate",
  style,
  appearance,
  /** annotate's own config-driven rules (tier: restart), after the shared card
   *  blocks. NO BACKTICKS INSIDE THIS TEMPLATE LITERAL — they terminate the
   *  string and break the bundle SILENTLY at cold start (notes GOTCHA 13). */
  extra: () => {
    // The pickers' floating surface, built from the card family's tokens: the
    // card colour at its configured alpha, card-chrome's hairline, and the
    // family control radius. The arrow gets the same fill so its notch does not
    // read as a second surface.
    const card = hexToRgba(appearance.cardColour, appearance.cardAlpha)
    return `
/* The popover NODE paints nothing of its own: the theme otherwise fills it
   with its background + padding, which is what made the two pickers a large
   empty slab around one control. */
window.annotate .annotate-popover { background: transparent; border: none; box-shadow: none; padding: 0; }
window.annotate .annotate-popover > contents {
  background: ${card};
  border: 1px solid var(--tinshell-hairline);
  border-radius: 10px;
  padding: 6px;
}
window.annotate .annotate-popover > arrow { background: ${card}; border: none; }
/* Selected chip ring. It must out-rank .annotate-chip:hover (0,3,1) — the same
   trap the header's .card-btn-active fixed: a bare class greys out the moment
   the pointer crosses the selected swatch. */
window.annotate .annotate-chip.annotate-swatch-selected,
window.annotate .annotate-chip.annotate-swatch-selected:hover {
  box-shadow: inset 0 0 0 2px ${appearance.textColour};
}
window.annotate .annotate-width highlight { background: ${appearance.accentColour}; }
window.annotate .annotate-width slider { background: ${appearance.textColour}; }
`
  },
})

/** The rules that must out-rank the SHARED card chrome, so they cannot live in
 *  this app's own `css`: in a resident instance the boot sheet holds an eager
 *  card app's chrome at `STYLE_PROVIDER_PRIORITY_USER` while a lazy app's sheet
 *  arrives at `APPLICATION`, and GTK compares provider PRIORITY before
 *  specificity (verified live: the left group kept the shared 54px box and the
 *  header kept its 10px padding). `applyChromeOverride`
 *  (common/card/chrome-override) adds the app's provider at the same USER
 *  priority after the boot sheet. */
const CHROME_OVERRIDES = `
/* Denser control box — the LEFT tool group only. 11 tool controls at the shared
   54px box (34px floor + 2×10 padding) are 594px of row, more than the 453px
   the header gives them at the configured 630, so three controls would sit off
   the viewport. 32px box = 20px floor + 2×6 padding: ~2× the 14px glyph's ink,
   32×28 hit area. Copy / save-as / save are deliberately NOT in this rule —
   they keep the shared box. */
window.annotate .annotate-tools .card-btn {
  min-width: 20px;
  padding: 3px 6px;
}
/* The header's own padding, trimmed from the shared 10px to 6px per side (the
   row is the window's width constraint, so its padding is width too). */
window.annotate .card-header {
  padding: 6px 6px 4px;
}
`

/** Register commands + sinks. Windows are created on demand by the request
 *  handlers (annotate/open) — nothing is built at startup. */
export function mountAnnotate(): void {
  applyChromeOverride("annotate", CHROME_OVERRIDES)
}

/** Shell lazy-unload hook (islands never call it). */
export { unmountAnnotate as unmount } from "./window"
