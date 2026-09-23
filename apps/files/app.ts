/**
 * files entry point — boots the TINSHELL app via the shared start helper.
 *
 * instanceName "files" → owns the io.Astal.files bus (addressed via
 * `ags -i files request|quit`). This is the DEV island: NO systemd unit, the
 * app is launched on demand (the `xdg-open` / desktop-entry path →
 * ensure-open.sh) and quits when the window closes. Production runs inside the
 * shell instance
 * — see ./mount (there the quit-on-close is disabled).
 *
 * Launch path: run.sh (shared bundler, per-app hashed outfile) — never bare
 * `ags run`. run.sh FORWARDS extra argv → main(...argv): the cold
 * `open <path>` path opens the requested directory directly, so the app
 * must NOT also issue a bus request on cold start (double-open).
 * See files/AGENTS.md and the root AGENTS.md (multi-app rules).
 */

import { isShell } from "@common/app/mode"
import { createApp } from "@common/app/start"
import app from "ags/gtk4/app"
import { filesCss, mountFiles } from "./mount"
import { destroyBrowser, openPath } from "./window"

createApp({
  instanceName: "files",
  css: filesCss,
  main(...argv: string[]) {
    // Cold start. Default = startup dir. With args (`run.sh open <path>` —
    // the direct debug/invocation path; the router delivers a REQUEST after it
    // boots an instance) the requested directory opens directly. run.sh
    // forwards extra argv.
    const [action, ...rest] = argv
    const path = action === "open" && rest.length ? rest.join(" ") : undefined
    mountFiles()
    openPath(path)
  },
  onQuit() {
    destroyBrowser() // every open browser window (multi-window app)
  },
})

// Quit when the window is gone — the app is on-demand by design (desktop
// app, no unit; the notes pattern). The LAST window is the trigger, so
// closing one of several browsers never quits. Disabled in shell: closing the
// browser must never kill the shared process.
if (!isShell) {
  app.connect("window-removed", () => {
    if (app.windows.length === 0) app.quit()
  })
}
