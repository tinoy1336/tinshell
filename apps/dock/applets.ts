/**
 * applets.ts — the dock's applet manifest.
 *
 * The ONE place the dock lists what it hosts, in config/row order. Each entry
 * mounts a shared applet from `@common/applets/<Name>` against one dock window
 * binding and optionally declares that applet's own request surface. Dock.tsx
 * builds the row from this list; the greeter keeps its own shorter list and
 * mounts the same applets through the same contract.
 *
 * `overflow` is dock-LOCAL: it is the row's overflow control (clock, hide/
 * show-all, move-mode entry), not a shared applet — the greeter strip has its
 * own layout and needs none of those policies. It stays in this list so the
 * file remains the single inventory of what the dock row hosts.
 */

import type { AppletWindow } from "@common/applets/applet-window"
import type { AppletBackend } from "@common/applets/backend"
import mountBattery from "@common/applets/battery"
import mountBluetooth from "@common/applets/bluetooth"
import mountBrightness from "@common/applets/brightness"
import type { AppletConfig } from "@common/applets/config"
import { createInProcessBackend } from "@common/applets/host/in-process"
import mountKeyboard from "@common/applets/keyboard"
import mountLockSession from "@common/applets/lockSession"
import mountMedia from "@common/applets/media"
import mountPerformance from "@common/applets/performance"
import mountPower from "@common/applets/power"
import mountScreenGrab from "@common/applets/screengrab"
import { screengrabDebugCommand } from "@common/applets/screengrab/commands"
import type { AppletMount } from "@common/applets/types"
import mountVolume from "@common/applets/volume"
import mountWifi from "@common/applets/wifi"
import { wifiDebugCommand } from "@common/applets/wifi/commands"
import mountWorkspaces from "@common/applets/workspaces"
import { type Handler, register } from "@common/commands/registry"
import { dockHooks } from "./applet-hooks"
import { dock } from "./config"
import type { DockRow } from "./dock-row"
import OverflowApplet from "./Overflow"
import * as ScreengrabDomain from "./screengrab/capture"
import * as ScreengrabNamingDomain from "./screengrab/naming"

interface DockAppletEntry {
  /** Key in the dock config's applet list (and the request path segment). */
  name: string
  /** Build and mount this applet on one dock window binding. */
  create: (aw: AppletWindow<DockRow>) => void
  /** Dock-local control rather than a shared applet mount. */
  dockLocal?: boolean
  /** The applet's `dock debug <name>` request handler. */
  debug?: Handler
}

/** The OS domains the dock's applets call. The dock HOSTS the applets backend
 *  (`apps/dock/mount.ts` → `mountAppletsBackend`), so the 17 user-session
 *  domains are bound in process; the two capture domains are dock-owned too
 *  (the capture driver owns this compositor session and is not part of the
 *  applets backend). Whichever host mounts an applet hands it this set in the
 *  AppletContext. */
export const dockBackend: AppletBackend = {
  ...createInProcessBackend(),
  screengrab: ScreengrabDomain,
  screengrabNaming: ScreengrabNamingDomain,
}

/** The dock's live config view — the facade's own mirror (the same object the
 *  store exposes, never a copy). */
const dockConfig = dock.config as AppletConfig

/** Mount a shared applet on a dock binding, with the dock's policies. */
function shared(mountApplet: AppletMount): (aw: AppletWindow<DockRow>) => void {
  return (aw) =>
    mountApplet({
      port: aw,
      hooks: dockHooks(aw),
      config: dockConfig,
      store: dock,
      backend: dockBackend,
    })
}

const DOCK_APPLETS: readonly DockAppletEntry[] = [
  { name: "performance", create: shared(mountPerformance) },
  { name: "battery", create: shared(mountBattery) },
  { name: "media", create: shared(mountMedia) },
  { name: "volume", create: shared(mountVolume) },
  { name: "brightness", create: shared(mountBrightness) },
  {
    name: "screengrab",
    create: shared(mountScreenGrab),
    debug: screengrabDebugCommand(dockBackend, dockConfig),
  },
  { name: "wifi", create: shared(mountWifi), debug: wifiDebugCommand(dockBackend) },
  { name: "bluetooth", create: shared(mountBluetooth) },
  { name: "lockSession", create: shared(mountLockSession) },
  { name: "power", create: shared(mountPower) },
  { name: "workspaces", create: shared(mountWorkspaces) },
  { name: "keyboard", create: shared(mountKeyboard) },
  { name: "overflow", create: (aw) => OverflowApplet(aw, dockBackend), dockLocal: true },
]

/** Applet key → builder, for the config-driven build loop. */
export const DOCK_APPLET_IMPLS: Record<string, (aw: AppletWindow<DockRow>) => void> =
  Object.fromEntries(DOCK_APPLETS.map((a) => [a.name, a.create]))

/** The dock-local overflow control: always built, appended after the applets
 *  so it stacks on top of the row. */
export const DOCK_OVERFLOW: DockAppletEntry = DOCK_APPLETS[DOCK_APPLETS.length - 1]

// Applet-declared commands keep their existing dock request paths.
for (const entry of DOCK_APPLETS) {
  if (entry.debug) register(["dock", "debug", entry.name], entry.debug)
}
