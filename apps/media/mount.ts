/**
 * media mount — the media app builder: an audio/video transport surface and
 * an inline still viewer in ONE window type (see ./window).
 *
 * Shared by the island app.ts (instanceName "media", io.Astal.media — the DEV
 * island, no unit, on-demand) and the shell instance. The media window OWNS
 * every output: video renders in the Gtk.Picture inside the window (GStreamer
 * playbin3 + gtk4paintablesink — common/media/pipeline), stills are decoded
 * straight into a Gtk.Picture (common/media/decode). In the shell the app
 * NEVER quits the process: the quit-on-close connection lives in the island
 * app.ts and is gated on common/app/mode isShell.
 */
import "./commands" // side-effect: registers request handlers
import { isProductionShell } from "@common/app/mode"
import { cardAppCss } from "@common/card/app-css"
import { hexToRgba } from "@common/colour"
import { fileSink, setSink } from "@common/log/logger"
import { get as getConfig } from "./config"
import { startMpris, stopMpris } from "./mpris"
import style from "./style.css"
import { clearStillCache, destroyWindow, setSurfaceHooks } from "./window"

// Launched from a keybind (no systemd, no journald) — log to a file like the
// dock/notes do, or the diagnostics vanish with the terminal. Skipped only in
// the production shell (which owns the one global sink) — resident dev
// islands MUST log here, they are not the shell.
if (!isProductionShell) {
  setSink(fileSink("/tmp/tinshell-media-debug.log"), "[media]")
}

/** Config-driven CSS appended after the static stylesheet (tier: restart).
 *  NO BACKTICKS INSIDE THE TEMPLATE — they terminate the string and break the
 *  bundle silently at cold start (notes GOTCHA 13). */
function dynamicCss(palette: { ink: string; muted: string }): string {
  const a = getConfig("appearance")
  const card = hexToRgba(a.cardColour, a.cardAlpha)
  return `
.media-controls { background: ${card}; }
.media-placeholder { color: ${a.textColour}; }
.media-time { color: ${palette.muted}; font-size: var(--tinshell-font-size-body); }
.media-name label, .media-zoom label, .media-dims { color: ${palette.muted}; }
.media-name-entry { color: ${palette.ink}; caret-color: ${palette.ink}; }
`
}

export const mediaCss = cardAppCss({
  app: "media",
  style,
  appearance: getConfig("appearance"),
  extra: dynamicCss,
})

/** Register commands + wire the MPRIS lifecycle to the surface registry.
 *  MPRIS is owned ONLY while at least one TRANSPORT surface is open (the dock
 *  media-applet auto-hide fix): startMpris on the first such surface,
 *  stopMpris when the last one closes or switches to the still viewer.
 *  Windows are created on demand by the request handlers (media/open,
 *  media/new, ...). */
export function mountMedia(): void {
  setSurfaceHooks({ onFirstSurface: startMpris, onLastClosed: stopMpris })
}

/** Quit / shell-unload → release MPRIS, destroy every window (each window's
 *  close handler shuts down its own media instance), drop the decoded-still
 *  cache. Idempotent. */
export function unmountMedia(): void {
  stopMpris()
  destroyWindow()
  clearStillCache()
}

/** Quit-path teardown (media app.ts `onQuit` and the entry's quit path):
 *  same teardown as unmountMedia. */
export const mediaShutdown = unmountMedia

/** Shell lazy-unload hook (islands never call it). */
export { unmountMedia as unmount }
