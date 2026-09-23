/**
 * files mount — the files browser builder.
 *
 * Shared by the island app.ts (instanceName "files", io.Astal.files — the
 * DEV island, no unit, on-demand) and the shell instance. In the shell the
 * app NEVER quits the process: the quit-on-close connection lives in the
 * island app.ts and is gated on common/app/mode isShell.
 */
import "./commands" // side-effect: registers request handlers
import { isProductionShell } from "@common/app/mode"
import { cardAppCss } from "@common/card/app-css"
import { applyChromeOverride } from "@common/card/chrome-override"
import { fileSink, setSink } from "@common/log/logger"
import { get as getConfig } from "./config"
import style from "./style.css"

// Launched on demand (no systemd, no journald) — log to a file like the
// dock/notes do, or the diagnostics vanish with the terminal. Skipped only
// in the production shell (which owns the one global sink).
if (!isProductionShell) {
  setSink(fileSink("/tmp/tinshell-files-debug.log"), "[files]")
}

const appearance = getConfig("appearance")

export const filesCss = cardAppCss({
  app: "files",
  style,
  appearance,
  /** files' own config-driven rules (tier: restart), after the shared card
   *  blocks. NO BACKTICKS INSIDE THIS TEMPLATE LITERAL — they terminate the
   *  string and break the bundle silently at cold start (notes GOTCHA 13). */
  extra: ({ text, muted, icon }) => {
    const metaSize = Math.max(appearance.fontSize - 3, 10)
    return `
.files-icon { color: ${icon}; font-size: ${appearance.iconSize}px; }
.files-name { color: ${appearance.textColour}; font-size: ${appearance.fontSize}px; }
.files-meta { color: ${text}; font-size: ${metaSize}px; }
.files-empty { color: ${muted}; font-size: 14px; }
window.files row { background: transparent; border-radius: 8px; margin: 0 2px; }
window.files row:hover { background: ${appearance.hoverColour}; }
window.files row:selected { background: ${appearance.selectionColour}; box-shadow: inset 3px 0 0 ${appearance.accentColour}; }
window.files row:selected:hover { background: ${appearance.selectionColour}; }
window.files row:focus { outline: none; }
`
  },
})

/** The header control density. In a resident instance the shared chrome arrives
 *  at `STYLE_PROVIDER_PRIORITY_USER` while this app's own sheet lands at
 *  `APPLICATION`, so the rule cannot live in the sheet — it goes in through
 *  `applyChromeOverride` (common/card/chrome-override), which owns the priority
 *  and one-provider-per-app rules. Eight glyph buttons at the shared 54px box
 *  (34px floor + 2x10 padding) are ~430px of the 620px window, which leaves the
 *  path bar a sliver of its own row. */
const CHROME_OVERRIDES = `
/* Denser header controls: the shared control box is a 34px floor plus 2x10
   padding, i.e. 54px per glyph button — 8 of them are 430px of the 620px
   window, which leaves the path bar a sliver of its own row. 32px box = 20px
   floor + 2x6 padding, about twice the 14px glyph's ink (annotate's density). */
window.files .card-header .card-btn {
  min-width: 20px;
  padding: 3px 6px;
}
/* The header's own padding is row width as well, trimmed from the shared 10px
   to 6px per side. */
window.files .card-header {
  padding: 6px 6px 4px;
}
/* The pane's open action — the one control the preview contributes. */
window.files .media-pane .card-primary {
  padding: 3px 10px;
}
`

/** Register commands + sinks. Windows are created on demand by the request
 *  handlers (files/open, files/navigate, ...) — nothing is built at startup. */
export function mountFiles(): void {
  applyChromeOverride("files", CHROME_OVERRIDES)
  // Everything else is done by the command modules' import side-effects + the
  // on-demand window factory in window.ts.
}

/** Shell lazy-unload hook (islands never call it). Closes EVERY open browser
 *  window; each close runs that window's own teardown and only then destroys
 *  it. */
export { destroyBrowser as unmount } from "./window"
