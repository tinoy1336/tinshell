/**
 * dock/commands/tablet.ts — tablet-mode control commands.
 *
 *   ags -i shell request "dock tablet set on|off|auto"   manual override (session-scoped)
 *   ags -i shell request "dock tablet get"               state introspection
 *
 * The dock cannot detect this machine's hinge on its own: the kernel exposes
 * no SW_TABLET_MODE switch, and the asus_nb_wmi tablet_mode_sw sysfs param is
 * a detection-METHOD config knob, not a live state — see
 * common/applets/domains/tablet.ts. The override gives tablet mode on demand (its
 * ingest lives in the applets backend); the panel auto-close policy it drives
 * runs in this host process (common/applets/tablet-panel-close.ts). Auto mode
 * follows a SW_TABLET_MODE input switch when the kernel exposes one.
 */

import { tabletPanelCloseInfo } from "@common/applets/tablet-panel-close"
import { register } from "@common/commands/registry"
import { dockBackend } from "../applets"

register(["dock", "tablet", "set"], (args, res) => {
  const v = args[0]
  if (v !== "on" && v !== "off" && v !== "auto") {
    res("usage: tablet set <on|off|auto>")
    return
  }
  dockBackend.tablet.setTabletOverride(v)
  res(`tablet mode: ${v}`)
})

register(["dock", "tablet", "get"], (_args, res) => {
  // Backend half (switch/accel latch + override) + host half (the panel
  // auto-close policy's live state: panelOpen/tablet/timer/fired).
  res(`${dockBackend.tablet.tabletInfo()} ${tabletPanelCloseInfo()}`)
})
