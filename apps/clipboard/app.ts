/**
 * clipboard entry point — the clipboard surface standalone
 * (bus io.Astal.clipboard). Capture loop is config-gated (clipboard.capture,
 * startup-read).
 *
 * Production runs inside the shell; this island is the DEV shape.
 * The router (tinshell-route.sh + route-map.conf: clipboard=shell,clipboard) picks
 * the live instance.
 */
import { createApp } from "@common/app/start"
import { clipboardCss, clipboardMount } from "./mount"

createApp({
  instanceName: "clipboard",
  css: clipboardCss,
  main() {
    clipboardMount()
  },
})
