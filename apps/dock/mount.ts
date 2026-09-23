/**
 * dock app — the dock surface as a REAL standalone app (bus io.Astal.dock).
 *
 * Sources live here: the layer-shell substrate (DockSurface.tsx), the row coordinator
 * (Dock.tsx, dock-row.ts — overflow, slots, move mode), the applet manifest
 * (applets.ts — the dock's config, store and OS-domain set it mounts them
 * with), applet-hooks.ts, commands, config, screengrab, utils. The renderer
 * itself and the per-applet binding factory are shared code
 * (common/applets/surface).
 * The shell's universal entry and this app's own app.ts mount the same code
 * — one source, two hosts.
 *
 * Config: the dock's OWN store (apps/dock/config.ts owns the createConfigStore
 * instance and the app wrapper from common/config/facade.ts).
 */
import "./applets"
import "./commands/config"
import "./commands/debug"
import "./commands/menu"
import "./commands/quit"
import "./commands/screengrab"
import "./commands/tablet"
import "@common/log/debug-log" // sets the ONE sink (file /tmp/tinshell-debug.log)
import { mountAppletsBackend } from "@common/applets/host/mount"
import { cornerCancelInit, restoreFollowMouseAtStartup } from "@common/applets/panel-framework"
import { startTabletPanelClose } from "@common/applets/tablet-panel-close"
import { menuInit } from "@common/menus/menu-framework"
import theme from "@common/shell/theme.css"
import app from "ags/gtk4/app"
import { dockBackend } from "./applets"
import { config } from "./config"
import Dock from "./Dock"
import style from "./style.css"

/** Config-driven CSS appended AFTER the static stylesheet (equal specificity,
 *  later provider wins) — the pill/overlay CSS minimums must track
 *  config.layout.iconSize: a hardcoded minimum over-allocates the pill
 *  DrawingArea past a smaller applet window (iconSize 34) and shifts the
 *  painted stadium ~1px right of the idle disc. */
function dynamicCss(): string {
  const isz = config.layout.iconSize
  return `
window.dock-pill .dock-overlay-pill-overlay { min-width: ${isz}px; min-height: ${isz}px; }
window.dock-pill .dock-overlay-pill { min-width: ${isz}px; min-height: ${isz}px; }
`
}

export const dockCss = `${theme}\n${style}\n${dynamicCss()}`

/** Dock: menu pre-create + per-monitor dock + corner-cancel + the applets
 *  backend. */
export function dockMount(): void {
  // Pre-create the (hidden, click-through) menu window so the wifi/bt GUI's
  // first open never maps a fresh surface at click time; build the dock per
  // monitor; pre-create the corner-cancel surface; restore follow_mouse;
  // bring the applet backend up (namespace + socket + the machine-wide tablet
  // ingest + the persisted sleep inhibit) and start the panel auto-close
  // policy.
  const mons = app.get_monitors()
  if (mons[0]) menuInit(mons[0], config)
  mons.map(Dock)
  if (mons[0]) cornerCancelInit(mons[0])
  restoreFollowMouseAtStartup()
  // The dock HOSTS the applet backend (common/applets/host), so its domains
  // are bound in process and the backend comes up with the dock: the request
  // namespace, the shared-group socket and the tablet WATCHDOG ingest (one
  // helper child per dock-hosting process, armed by the backend's own mount).
  mountAppletsBackend()
  // The panel auto-close POLICY stays in this process: its inputs (panel open)
  // and its effect (the per-core leave evaluation) are host state, so the
  // timer arms here against the tablet state the backend publishes.
  startTabletPanelClose({
    tablet: dockBackend.tablet,
    closeMs: config.timing.tabletCloseMs,
  })
}
