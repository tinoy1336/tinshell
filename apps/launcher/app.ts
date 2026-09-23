/**
 * launcher entry point — the launcher surface standalone (bus io.Astal.launcher).
 *
 * Production runs inside the shell; this island is the DEV shape.
 * The router (tinshell-route.sh + route-map.conf: launcher=shell,launcher) picks
 * the live instance.
 */
import { createApp } from "@common/app/start"
import { launcherCss, launcherMount } from "./mount"

createApp({
  instanceName: "launcher",
  css: launcherCss,
  main() {
    launcherMount()
  },
})
