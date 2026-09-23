/**
 * dock entry point — the dock surface standalone (bus io.Astal.dock).
 *
 * Production runs inside the shell; this island is the DEV shape —
 * isolated restart. The router (tinshell-route.sh + route-map.conf: dock=shell,dock)
 * picks the live instance.
 */
import { createApp } from "@common/app/start"
import { dockCss, dockMount } from "./mount"

createApp({
  instanceName: "dock",
  css: dockCss,
  main() {
    dockMount()
  },
})
