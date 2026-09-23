/**
 * dock/commands/menu.ts — `menu wifi` / `menu bluetooth` request commands.
 * Spawn the centred GUIs from outside the applets (keybinds, scripts).
 * The menu spawns on the first connected monitor.
 */

import { openBluetoothMenu } from "@common/applets/bluetooth/menu"
import {
  CAPTURE_KIND,
  openScreenGrabCaptureMenu,
  openScreenGrabSettingsMenu,
  SETTINGS_KIND,
} from "@common/applets/screengrab/menu"
import { openWifiMenu } from "@common/applets/wifi/menu"
import { register } from "@common/commands/registry"
import { closeMenu, menuKind } from "@common/menus/menu-framework"
import app from "ags/gtk4/app"
import { dockBackend } from "../applets"
import { config, dock } from "../config"

function primaryMonitor(): any {
  return app.get_monitors()[0] ?? null
}

register(["dock", "menu", "wifi"], (_args, res) => {
  // Toggle: a second invocation closes the wifi menu instead of reopening it.
  if (menuKind() === "wifi") {
    closeMenu()
    res("closed")
    return
  }
  const mon = primaryMonitor()
  if (!mon) {
    res("error: no monitor")
    return
  }
  openWifiMenu(mon, config, dockBackend)
  res("opened wifi menu")
})

register(["dock", "menu", "bluetooth"], (_args, res) => {
  if (menuKind() === "bluetooth") {
    closeMenu()
    res("closed")
    return
  }
  const mon = primaryMonitor()
  if (!mon) {
    res("error: no monitor")
    return
  }
  openBluetoothMenu(mon, config, dockBackend)
  res("opened bluetooth menu")
})

register(["dock", "menu", "close"], (_args, res) => {
  closeMenu()
  res("closed")
})

register(["dock", "menu", "screengrab-capture"], (_args, res) => {
  if (menuKind() === CAPTURE_KIND) {
    closeMenu()
    res("closed")
    return
  }
  // The overlay is part of the dock UI — it stays hidden while "Show dock" is off.
  if (!config.screengrab.showDock) {
    res("hidden: screengrab.showDock is off")
    return
  }
  const mon = primaryMonitor()
  if (!mon) {
    res("error: no monitor")
    return
  }
  openScreenGrabCaptureMenu({
    monitor: mon,
    mode: "still",
    config,
    store: dock,
    backend: dockBackend,
  })
  res("opened screengrab capture menu")
})

register(["dock", "menu", "screengrab-settings"], (_args, res) => {
  if (menuKind() === SETTINGS_KIND) {
    closeMenu()
    res("closed")
    return
  }
  const mon = primaryMonitor()
  if (!mon) {
    res("error: no monitor")
    return
  }
  openScreenGrabSettingsMenu({ monitor: mon, config, store: dock, backend: dockBackend })
  res("opened screengrab settings menu")
})
