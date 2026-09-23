/**
 * annotate entry point — boots the TINSHELL app via the shared start helper.
 *
 * instanceName "annotate" → owns the io.Astal.annotate bus (addressed via
 * `ags -i annotate request|quit`). This is the DEV island: NO systemd unit,
 * launched on demand from the screenshot notification action
 * (ensure-open.sh). Production runs inside the shell instance
 * — see ./mount.
 *
 * Cold-start argv: ensure-open.sh forwards `open <file>` through run.sh →
 * main(...argv), so the app opens the requested image directly and must NOT
 * also issue a bus request (notes GOTCHA 5 — double-open).
 */
import { createApp } from "@common/app/start"
import { annotateCss, mountAnnotate } from "./mount"
import { openEditor } from "./window"

createApp({
  instanceName: "annotate",
  css: annotateCss,
  main(...argv: string[]) {
    // Cold start. ensure-open.sh forwards `open <file>`; a bare start (no
    // file) opens an empty window with an error state.
    const [action, file] = argv
    mountAnnotate()
    if (action === "open" && file) openEditor(file)
    else openEditor(null)
  },
})
