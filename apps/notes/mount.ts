/**
 * notes mount — the floating desktop-notes builder.
 *
 * Shared by the island app.ts (instanceName "notes", io.Astal.notes — the
 * DEV island, no unit, on-demand) and the shell instance. In the shell the
 * app NEVER quits the process: the quit-on-close connection lives in the
 * island app.ts / notes.ts and is gated on common/app/mode isShell.
 */
import "./commands" // side-effect: registers request handlers
import { isProductionShell } from "@common/app/mode"
import { hexToRgba } from "@common/colour"
import { fileSink, setSink } from "@common/log/logger"
import theme from "@common/shell/theme.css"
import { get as getConfig } from "./config"
import { restoreOnce as sessionRestoreOnce } from "./session"
import style from "./style.css"

// Launched from a keybind (no systemd, no journald) — log to a file like the
// dock does, or the diagnostics vanish with the terminal. Skipped only in
// the production shell (which owns the one global sink) — resident dev
// islands MUST log here, they are not the shell.
if (!isProductionShell) {
  setSink(fileSink("/tmp/tinshell-notes-debug.log"), "[notes]")
}

/** Config-driven CSS appended after the static stylesheet (tier: restart). */
function dynamicCss(): string {
  const a = getConfig("appearance")
  const pad = getConfig("window.padding")
  const card = hexToRgba(a.cardColour, a.cardAlpha)
  return `
window.note { background: ${card}; }
.note-pad { padding: ${pad}px; }
textview.note-view text { color: ${a.textColour}; caret-color: ${a.caretColour}; font-size: ${a.fontSize}px; }
textview.note-view text selection { background-color: ${a.selectionColour}; }
/* Right-click edit menu on the text view (GTK default) — themed to match
   the card. GTK4 popover structure: the outer popover node is
   transparent; the visible panel lives on the contents child node
   (where the Breeze-Dark theme paints its dark translucent bg/border/
   padding — that's why the old menu showed through), the arrow is a
   sibling, and items are modelbutton nodes (NOT button.model).
   NO BACKTICKS INSIDE THIS TEMPLATE LITERAL — they terminate the string.
   Appearance-only — the default menu is kept, not replaced. */
window.note popover.menu {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
}
window.note popover.menu contents {
  background: ${card};
  border: none;
  border-radius: var(--tinshell-panel-radius);
  padding: 6px;
}
window.note popover.menu > arrow {
  background: ${card};
  border: none;
}
window.note popover.menu modelbutton {
  color: ${a.textColour};
  font-size: var(--tinshell-font-size-body);
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  margin: 2px 4px;
  min-width: 0;
  min-height: 0;
}
window.note popover.menu modelbutton:hover {
  background: rgba(0, 0, 0, 0.15);
  border: none;
}
window.note popover.menu modelbutton:disabled {
  color: ${hexToRgba(a.textColour, 0.55)};
}
window.note popover.menu separator {
  background: rgba(0, 0, 0, 0.12);
  color: rgba(0, 0, 0, 0.12);
  margin: 4px 12px;
}
`
}

export const notesCss = theme + "\n" + style + "\n" + dynamicCss()

/** Register commands + sinks. Windows are created on demand by the request
 *  handlers (notes/new, notes/open) — nothing is built at startup — EXCEPT
 *  the session restore: notes recorded open in the shared state store
 *  (state.json — crash or shell restart with notes up) re-open here at their
 *  saved geometry + workspace, focus-free. */
export function mountNotes(): void {
  sessionRestoreOnce()
}

/** Shell lazy-unload hook (islands never call it). */
export { unmountNotes as unmount } from "./notes"
