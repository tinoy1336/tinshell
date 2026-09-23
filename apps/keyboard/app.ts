/**
 * keyboard entry point — the on-screen keyboard surface standalone
 * (bus io.Astal.keyboard). Config-gated (keyboard.enabled, startup-read).
 *
 * Production runs inside the shell; this island is the DEV shape.
 * The router (tinshell-route.sh + route-map.conf: keyboard=shell,keyboard) picks
 * the live instance.
 */
import { createApp } from "@common/app/start"
import { keyboardCss, keyboardMount, keyboardShutdown } from "./mount"

createApp({
  instanceName: "keyboard",
  css: keyboardCss,
  main() {
    keyboardMount()
  },
  onQuit() {
    keyboardShutdown()
  },
})
