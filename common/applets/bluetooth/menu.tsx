/**
 * common/applets/bluetooth/menu.tsx — the bluetooth GUI.
 *
 * Spawned by the bluetooth applet (step "Open menu") via
 * openBluetoothMenu(monitor, config, backend).
 * Headerless by design (the dock applet's steps own enable/disable/scan):
 * a device list with connect/disconnect/pair and forget, plus a status row
 * when the adapter is off. The NoInputNoOutput BlueZ agent is registered
 * while the menu is open so
 * pairing to discovered devices works for the common JustWorks/numeric-
 * comparison flows (PIN-entry devices are not supported by that capability).
 *
 * Same lifecycle as wifi-menu: state in the menu's gnim scope, poll timer
 * cleaned up with the menu, setRows() re-renders from state. Action failures
 * surface as a red error row.
 */

import GLib from "gi://GLib"
import type { AppletBackend, BluetoothDevice } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import {
  createBusyWatchdog,
  later,
  type MenuController,
  menuInfoRow,
  menuRow,
  menuSpinnerRow,
  openMenu,
} from "@common/menus/menu-framework"
import { createSpinnerGlyph } from "@common/menus/spinner"
import type { Gdk, Gtk } from "ags/gtk4"
import { onCleanup } from "gnim"

interface BtMenuState {
  enabled: boolean
  discovering: boolean
  devices: BluetoothDevice[]
  /** Device path with an action in flight (row shows "Working…"). */
  busyPath: string | null
  /** Last action failure (shown as a red row under the list). */
  error: string | null
}

/** Map BlueZ's Icon property to a Nerd Font glyph; fallback = bluetooth. */
function typeGlyph(icon: string, I: AppletConfig["appearance"]["icons"]): string {
  const i = icon.toLowerCase()
  if (i.includes("keyboard")) return I.menuKeyboard
  if (i.includes("mouse")) return I.menuMouse
  if (i.includes("headset") || i.includes("headphone")) return I.menuHeadphones
  if (i.includes("audio") || i.includes("speaker")) return I.menuAudio
  if (i.includes("phone") || i.includes("cellular")) return I.menuPhone
  if (i.includes("watch")) return I.menuWatch
  return I.menuBluetooth
}

export function openBluetoothMenu(
  monitor: Gdk.Monitor,
  config: AppletConfig,
  backend: AppletBackend,
): void {
  const I = (): AppletConfig["appearance"]["icons"] => config.appearance.icons
  const state: BtMenuState = {
    enabled: false,
    discovering: false,
    devices: [],
    busyPath: null,
    error: null,
  }
  let ctl: MenuController | null = null

  // The spinning 🔄 while a device action is in flight (one shared instance
  // so it survives row re-renders without resetting its angle).
  const spinner = createSpinnerGlyph({
    fontFamily: config.fonts.family,
    size: 20,
    emoji: I().menuSpinner,
    colour: config.appearance.menu.accent,
  })
  spinner.setSpinning(true) // the initial "Scanning…" row

  // ── Hover-flicker guard: the 2s poll only re-renders when the RENDERED
  //  state actually changed (a fresh row would otherwise reset its hover
  //  every tick — the highlight vanishes under a still pointer). ──
  let lastSnap = ""
  const snapshot = (): string =>
    JSON.stringify({
      enabled: state.enabled,
      discovering: state.discovering,
      busy: state.busyPath,
      error: state.error,
      devs: state.devices.map((d) => [d.path, d.name, d.icon, d.connected, d.paired, d.trusted]),
    })

  function refresh(): void {
    void (async () => {
      const enabled = await backend.bluetooth.isBluetoothEnabled()
      const discovering = enabled ? await backend.bluetooth.adapterDiscovering() : false
      const devices = enabled ? await backend.bluetooth.listBluetoothDevices() : []
      state.enabled = enabled
      state.discovering = discovering
      state.devices = devices
      // Skip the re-render when nothing that RENDERS changed (flicker fix).
      if (snapshot() === lastSnap) return
      render()
    })()
  }

  /** Pair-then-connect for an unpaired device; connect directly when paired.
   *  Watchdog: a hung BlueZ call must not leave busyPath/spinner set forever. */
  const btWatchdog = createBusyWatchdog(20000, () => {
    if (state.busyPath) {
      state.busyPath = null
      render()
    }
  })
  function doConnectDevice(dev: BluetoothDevice): void {
    if (state.busyPath) return
    state.busyPath = dev.path
    state.error = null
    render()
    btWatchdog.arm()
    const run = dev.paired
      ? backend.bluetooth.connectDevice(dev.path)
      : backend.bluetooth
          .pairDevice(dev.path)
          .then((p) => (p.ok ? backend.bluetooth.connectDevice(dev.path) : p))
    void run.then((r) => {
      state.busyPath = null
      btWatchdog.disarm()
      if (!r.ok) state.error = r.error ?? "Connection failed"
      later(800, refresh) // let BlueZ settle Connected state
    })
  }

  function render(): void {
    if (!ctl) return
    lastSnap = snapshot()
    spinner.setSpinning(!!state.busyPath || (state.discovering && state.devices.length === 0))
    const rows: Gtk.Widget[] = []

    if (!state.enabled) {
      rows.push(menuInfoRow("Bluetooth is off", config))
      ctl.setRows(rows)
      return
    }

    // ── Device list ──
    if (state.devices.length === 0) {
      rows.push(
        state.discovering
          ? menuSpinnerRow(spinner.widget, config)
          : menuInfoRow("No devices found", config),
      )
    }
    for (const dev of state.devices) {
      const busy = state.busyPath === dev.path
      // Status emojis (no text): working → spinning 🔄; connected/paired →
      // check; unpaired-but-idle → no status glyph.
      rows.push(
        menuRow({
          config,
          emoji: typeGlyph(dev.icon, config.appearance.icons),
          text: dev.name,
          status: busy ? undefined : dev.connected || dev.paired ? I().menuCheck : undefined,
          statusWidget: busy ? spinner.widget : undefined,
          statusColour: dev.connected ? "accent" : "mutedText",
          muted: !dev.paired && !dev.connected && !dev.trusted,
          onClick: () => {
            if (state.busyPath) return
            if (dev.connected) {
              state.busyPath = dev.path
              state.error = null
              render()
              btWatchdog.arm()
              void backend.bluetooth.disconnectDevice(dev.path).then((r) => {
                state.busyPath = null
                btWatchdog.disarm()
                if (!r.ok) state.error = r.error ?? "Disconnect failed"
                later(400, refresh)
              })
            } else {
              doConnectDevice(dev)
            }
          },
          // Forget/trash only for devices the user has actually interacted
          // with (paired, trusted, or connected) — never-connected "New"
          // devices get no trash. The user's TV case stays covered: any
          // paired/trusted/remembered device keeps its button (the old
          // paired||trusted gate failed there because the TV was
          // unpaired-but-remembered). Failures surface as a red error row.
          action:
            dev.paired || dev.trusted || dev.connected
              ? {
                  emoji: I().menuForget,
                  onClick: () => {
                    if (state.busyPath) return
                    void backend.bluetooth.removeDevice(dev.path).then((r) => {
                      if (!r.ok) state.error = r.error ?? "Forget failed"
                      later(300, refresh)
                    })
                  },
                }
              : undefined,
        }),
      )
    }

    if (state.error) rows.push(menuInfoRow(state.error, config, "danger"))
    ctl.setRows(rows)
  }

  // Whether THIS menu started discovery (hoisted so onClose can see it) — the
  // close must only stop discovery we own, never the adapter's pre-existing
  // scan, and it must work even when the menu closes before the first poll.
  let weStartedDiscovery = false

  ctl = openMenu({
    config,
    kind: "bluetooth",
    monitor,
    rows: [menuSpinnerRow(spinner.widget, config)],
    onMount: (c) => {
      ctl = c
      // Poll created INSIDE onMount so its cleanup is scoped to the menu's
      // gnim root (a poll created before openMenu leaks when the
      // deferred-open path skips onMount).
      const pollId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        config.timing.poll.bluetoothMenu,
        () => {
          refresh()
          return GLib.SOURCE_CONTINUE
        },
      )
      onCleanup(() => GLib.source_remove(pollId))
      // Agent needed for pairing while the menu is open.
      backend.bluetooth.registerAgent()
      refresh()
      // Auto-discovery on open. (The applet's own polling keeps the dock icon fresh; the menu
      // only kicks discovery so new devices appear while it is open.) Track
      // that WE started it — the close must only stop discovery we own (the
      // state.discovering flag lags the poll and would skip the stop on a
      // fast close, or stop an adapter discovery the menu never started).
      void (async () => {
        if (
          (await backend.bluetooth.isBluetoothEnabled()) &&
          !(await backend.bluetooth.adapterDiscovering())
        ) {
          await backend.bluetooth.startDiscovery()
          weStartedDiscovery = true
          later(1200, refresh)
        }
      })()
    },
    onClose: () => {
      backend.bluetooth.unregisterAgent()
      if (weStartedDiscovery) void backend.bluetooth.stopDiscovery()
    },
  })
}
