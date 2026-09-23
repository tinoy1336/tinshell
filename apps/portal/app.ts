/**
 * portal entry point — boots the TINSHELL app via the shared start helper.
 *
 * instanceName "portal" → owns the io.Astal.portal bus (addressed via
 * `ags -i portal request|quit`). This is the DEV island; production runs
 * inside the shell instance — see ./mount.
 *
 * Lifecycle: RESIDENT in production (the shell owns the impl name before the
 * portal frontend probes it). The island unit is D-Bus-activated ON DEMAND
 * in dev mode; the backend never self-quits — the impl name must stay owned
 * for the whole process lifetime (dbus.ts).
 *
 * Launch path: run.sh (shared bundler, per-app hashed outfile) — never bare
 * `ags run`. See portal/AGENTS.md and the root AGENTS.md (multi-app rules).
 */
import { createApp } from "@common/app/start"
import { mountPortal, portalCss } from "./mount"

createApp({
  instanceName: "portal",
  css: portalCss,
  main() {
    mountPortal()
  },
})
