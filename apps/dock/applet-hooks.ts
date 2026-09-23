/**
 * applet-hooks — the dock's AppletHooks implementation.
 *
 * The dock's policy lives on its DockRow (overflow parking, deactivation,
 * attention, dock visibility); this adapts that row to the shared hook
 * interface so applet mounts never import DockRow.
 */

import type { AppletWindow } from "@common/applets/applet-window"
import type { AppletHooks } from "@common/applets/hooks"
import type { DockRow } from "./dock-row"

export function dockHooks(aw: AppletWindow<DockRow>): AppletHooks {
  const row = aw.row
  return {
    setAppletHidden: (name, hidden) => row?.setAppletHidden(name, hidden),
    setAppletDeactivated: (name, v) => row?.setAppletDeactivated(name, v),
    setAppletAttention: (name, on) => row?.setAppletAttention?.(name, on),
    setDockVisible: (v) => row?.setDockVisible?.(v),
  }
}
