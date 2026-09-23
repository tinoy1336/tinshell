/**
 * Bluetooth applet — adapter power, discovery scan, and the pairing GUI.
 *
 * The pairing GUI (./menu) is this applet's own menu: it adopts the shared
 * menu shell from common/menus and is torn down with the applet's panel.
 *
 * BlueZ does NOT remember the adapter's Powered state across reboots
 * (AutoEnable=true powers every controller on at boot). The value is
 * persisted by the Bluetooth domain (`common/applets/domains/bluetooth.ts`, key
 * `bluetoothEnabled`) and re-applied when the applet starts.
 */
import GLib from "gi://GLib"
import type { AppletBackend, BluetoothStatus } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import { createStepApplet } from "@common/applets/shared/create-step-applet"
import { clamp01, drawDisc, drawGlyph } from "@common/applets/shared/draw-utils"
import { createElementFade } from "@common/applets/shared/element-fade"
import type { AppletContext, DrawIcon } from "@common/applets/types"
import { closeMenu, menuKind, onMenuClose } from "@common/menus/menu-framework"
import app from "ags/gtk4/app"
import { onCleanup } from "gnim"
import { openBluetoothMenu } from "./menu"

// ── Step definitions ──

function stepDefs(config: AppletConfig): { label: string; emoji: string }[] {
  return [
    { label: "Disable Bluetooth", emoji: config.appearance.icons.bluetoothOff },
    { label: "Enable Bluetooth", emoji: config.appearance.icons.bluetoothOn },
    { label: "Scan Bluetooth", emoji: config.appearance.icons.bluetoothReconnect },
    { label: "Open menu", emoji: config.appearance.icons.bluetoothOpen },
  ]
}

let lastPersisted: boolean | null = null

function readPersistedState(bluetooth: AppletBackend["bluetooth"]): boolean | null {
  const v = bluetooth.bluetoothEnabledStore.get("bluetoothEnabled")
  if (typeof v === "boolean") return v
  return null
}

function persistState(bluetooth: AppletBackend["bluetooth"], on: boolean): void {
  lastPersisted = on
  bluetooth.bluetoothEnabledStore.set("bluetoothEnabled", on)
}

// ── Icon selection ──

function pickIcon(status: BluetoothStatus | null, config: AppletConfig): string {
  const icons = config.appearance.icons
  if (!status || !status.enabled) return icons.bluetoothDisabled
  if (status.connected) return icons.bluetoothConnected
  return icons.bluetoothIdle
}

export default function mount({ port, hooks, config, backend }: AppletContext): void {
  let status: BluetoothStatus = { enabled: false, connected: false }

  // The applet's ONE fade-eligible element: the adapter/pairing glyph. A new
  // glyph — adapter powered, a device connected — cross-fades; the disc is
  // painted once per paint.
  const glyphFade = createElementFade<string>(port, config, "glyph")
  onCleanup(() => glyphFade.dispose())

  // Startup restore: once the adapter appears, apply the persisted state.
  // restoreSettled gates the observe-persist below so the PRE-restore actual
  // state (AutoEnable's boot-on) never clobbers the saved "off" before the
  // restore has applied it.
  let restoreSettled = false
  async function restoreState(): Promise<void> {
    try {
      // Wait for bluetoothd + hci0 — the user session can start before
      // bluetooth.service at boot.
      let adapterUp = false
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await backend.bluetooth.adapterExists()) {
          adapterUp = true
          break
        }
        await new Promise((r) =>
          GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            r(null)
            return GLib.SOURCE_REMOVE
          }),
        )
      }
      // Re-read the file at apply time so a toggle made during the wait wins.
      if (adapterUp) {
        const saved = readPersistedState(backend.bluetooth)
        if (saved !== null) {
          const actual = await backend.bluetooth.isBluetoothEnabled()
          if (actual !== saved) {
            await backend.bluetooth.setBluetoothEnabled(saved)
            persistState(backend.bluetooth, saved)
          }
        }
      }
    } catch (e) {
      print(`[bluetooth] restoreState failed: ${e}`)
    }
    restoreSettled = true
  }

  const drawIcon: DrawIcon = (cr, w, h, _value, _state, ringFill = 1, _skipDisc, _textValue) => {
    const rf = clamp01(ringFill)
    const size = Math.min(w, h)
    drawDisc(config, cr, size / 2, size / 2, size / 2)
    const gc = config.appearance.glyphColour
    glyphFade.paint(pickIcon(status, config), (glyph, alpha) =>
      drawGlyph(
        config,
        cr,
        size / 2,
        size / 2,
        glyph,
        config.fonts.iconSize,
        [gc.rgb[0], gc.rgb[1], gc.rgb[2], gc.alpha * rf * alpha],
        undefined,
        config.appearance.textShadow.alpha * rf * alpha,
      ),
    )
  }

  // Poll for status changes
  function refresh(): void {
    void backend.bluetooth.bluetoothStatus().then((s) => {
      status = s
      // Same as wifi: while the bluetooth GUI is open, don't push the state
      // back into the panel (it would snap the icon away from the user's step
      // selection AND keep the panel's per-frame renders alive, holding the
      // pointer outside the input region and swallowing the next click).
      if (menuKind() !== "bluetooth") handle.externalChange(status.enabled ? 1 : 0)
      hooks.setAppletHidden(port.name, !s.enabled)
      if (!port.isOpen() && !port.isHiddenState()) port.icon.queue_draw()
      // After the startup restore settles, remember externally-driven
      // changes (bluetoothctl etc.) so the file tracks the true last
      // setting across reboots.
      if (restoreSettled && lastPersisted !== s.enabled) persistState(backend.bluetooth, s.enabled)
    })
    // The adapter's Discovering property drives the scan-step spin: on when a
    // scan runs, off (easing back to upright) when it ends.
    void backend.bluetooth.adapterDiscovering().then((d) => {
      handle.setSpin(2, d)
    })
  }

  const pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, config.timing.poll.bluetooth, () => {
    refresh()
    return GLib.SOURCE_CONTINUE
  })
  onCleanup(() => GLib.source_remove(pollId))
  // Event-driven: BlueZ adapter/device property changes (Powered, Discovering,
  // Connected) refresh immediately — the poll above is now a 30s safety net.
  onCleanup(backend.bluetooth.subscribeBluetoothStatus(() => refresh()))

  const handle = createStepApplet(port, {
    config,
    steps: stepDefs(config),
    getStepColour: (i: number) => config.appearance.stepColours.bluetooth[i],
    getInitialStep: () => (status.enabled ? 1 : 0),
    drawIcon,
    // Pin the panel open while the bluetooth GUI is open (keepOpen suppresses
    // the leave-grace close) so the enable/disable/reconnect steps stay
    // reachable alongside the GUI.
    keepOpen: () => menuKind() === "bluetooth",
    onSelect: (step, close) => {
      const pinned = menuKind() === "bluetooth"
      switch (step) {
        case 0:
          void backend.bluetooth.setBluetoothEnabled(false)
          persistState(backend.bluetooth, false)
          break
        case 1:
          void backend.bluetooth.setBluetoothEnabled(true)
          persistState(backend.bluetooth, true)
          break
        case 2:
          // Scan TOGGLE: start discovery when off, StopDiscovery when the
          // adapter is already scanning (the same call the bluetooth GUI's
          // onClose uses — BlueZ scans indefinitely until stopped). Does
          // nothing while the adapter is off. The disc snaps back to the
          // current on/off step so it isn't "remembered" on the scan step;
          // the spin still follows the adapter's Discovering state (event +
          // poll in refresh()) — the optimistic setSpin below only covers
          // the D-Bus roundtrip until refresh() re-syncs, and a failed call
          // is corrected by the next refresh.
          if (status.enabled) {
            void backend.bluetooth.adapterDiscovering().then((d) => {
              handle.setSpin(2, !d)
              void (d ? backend.bluetooth.stopDiscovery() : backend.bluetooth.startDiscovery())
            })
          }
          handle.externalChange(status.enabled ? 1 : 0)
          break
        case 3:
          if (pinned) {
            // GUI prompted to close → close it AND the panel.
            closeMenu()
            close()
          } else {
            // Spawn the centred bluetooth GUI on this applet's monitor; the
            // panel stays open (keepOpen) while the GUI is up.
            openBluetoothMenu(
              (port.window as any).gdkmonitor ?? app.get_monitors()[0],
              config,
              backend,
            )
          }
          break
      }
      // While pinned, enable/disable/reconnect keep the panel open for
      // repeated toggling; otherwise they dismiss it as usual.
      if (step !== 3 && !pinned) close()
    },
    logLabel: "bluetooth",
  })

  // When the bluetooth GUI closes through any path (Escape, `menu close`, or
  // the single-open swap to the wifi GUI), close the pinned panel too.
  const unsubMenu = onMenuClose((kind) => {
    // Close the pinned panel only when the bluetooth GUI is REALLY gone — a
    // same-kind supersede keeps the new menu's kind, and the pin survives it.
    if (kind === "bluetooth" && menuKind() !== "bluetooth") handle.close()
  })
  onCleanup(unsubMenu)

  // First status poll (TDZ-safe: handle is assigned above).
  refresh()
  // Restore the persisted power state (BlueZ's AutoEnable wins until here).
  void restoreState()
}
