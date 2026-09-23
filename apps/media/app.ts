/**
 * media entry point — boots the TINSHELL app via the shared start helper.
 *
 * instanceName "media" → owns the io.Astal.media bus (addressed via
 * `ags -i media request|quit`). This is the DEV island: NO systemd unit,
 * launched on demand (the media-float desktop entry / the launcher `!p` bang /
 * `tinshell-route.sh media …`).
 * Production runs inside the shell instance — see ./mount (there the
 * quit-on-close is disabled; quitting the instance stops the pipelines and
 * releases MPRIS through its quit teardown).
 *
 * Launch path: run.sh (shared bundler, per-app hashed outfile) — never bare
 * `ags run`. run.sh FORWARDS extra argv → main(...argv): the cold
 * `open <path>` path loads the media directly, so the app must NOT also
 * issue a bus request on cold start (double-open).
 * See media/AGENTS.md and the root AGENTS.md (multi-app rules).
 */

import { isShell } from "@common/app/mode"
import { createApp } from "@common/app/start"
import app from "ags/gtk4/app"
import { mediaCss, mediaShutdown, mountMedia } from "./mount"
import { newSurface, openPath } from "./window"

createApp({
  instanceName: "media",
  css: mediaCss,
  main(...argv: string[]) {
    // Cold start. No args → the empty window, which asks the portal for a
    // file. With args (`run.sh open <path>` — the launcher-bang path — or
    // `run.sh new <path>` — the xdg-open path) the requested media loads
    // directly: `open` into the most-recent window (creating one), `new`
    // always into a fresh one. run.sh forwards extra argv.
    const [action, ...rest] = argv
    const path = (action === "open" || action === "new") && rest.length ? rest.join(" ") : undefined
    // Media keys / playerctl need the MPRIS bus name up before any media loads.
    mountMedia()
    if (action === "new") newSurface(path)
    else openPath(path)
  },
  onQuit() {
    mediaShutdown()
  },
})

// Quit when the window is gone — the app is on-demand by design (desktop
// app, no unit; the notes pattern). The pipeline stops with the app.
// Disabled in shell: closing the window must never kill the shared process.
// (app as any): "window-removed" is inherited from Gtk.Application — the
// shim's AppSignals types only list the custom signals (files/app.ts note).
if (!isShell) {
  ;(app as any).connect("window-removed", () => {
    if (app.windows.length === 0) app.quit()
  })
}
