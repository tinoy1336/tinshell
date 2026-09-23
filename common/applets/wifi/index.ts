import GLib from "gi://GLib"
import type { WifiStatus } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import { createStepApplet } from "@common/applets/shared/create-step-applet"
import type { OverlapRing } from "@common/applets/shared/draw-utils"
import { clamp01, drawDisc, drawGlyph, drawOverlapRings } from "@common/applets/shared/draw-utils"
import { createElementFade } from "@common/applets/shared/element-fade"
import type { AppletContext, DrawIcon } from "@common/applets/types"
import { createSmoother } from "@common/applets/utils/smoother"
import { closeMenu, menuKind, onMenuClose } from "@common/menus/menu-framework"
import app from "ags/gtk4/app"
import { onCleanup } from "gnim"
import { openWifiMenu } from "./menu"
import { setWifiMenuScanHook } from "./scan-bridge"

// Rate ring colours — read from the host's live config.
function ringColour(key: string, config: AppletConfig): [number, number, number, number] {
  const rc = config.appearance.ringColours.wifiRate
  const c = rc[key] ?? { rgb: [0.5, 0.5, 0.5], alpha: 1 }
  return [c.rgb[0], c.rgb[1], c.rgb[2], c.alpha]
}

const STEPS = (config: AppletConfig): { label: string; emoji: string }[] => [
  { label: "Disable WiFi", emoji: config.appearance.icons.wifiOff },
  { label: "Enable WiFi", emoji: config.appearance.icons.wifiOn },
  { label: "Scan WiFi", emoji: config.appearance.icons.wifiReconnect },
  { label: "Open menu", emoji: config.appearance.icons.wifiOpen },
]

function pickIcon(s: WifiStatus, config: AppletConfig): string {
  const I = config.appearance.icons
  if (!s.enabled) return I.wifiDisabled
  if (!s.connected) {
    if (s.signal <= 25) return I.wifiScanningWeak
    if (s.signal <= 50) return I.wifiScanningFair
    if (s.signal <= 75) return I.wifiScanningGood
    return I.wifiScanningStrong
  }
  const noInet = s.connectivity !== "full" && s.connectivity !== "unknown"
  if (noInet) {
    if (s.signal <= 25) return I.wifiNoInternetWeak
    if (s.signal <= 50) return I.wifiNoInternetFair
    if (s.signal <= 75) return I.wifiNoInternetGood
    return I.wifiNoInternetStrong
  }
  if (s.signal <= 25) return I.wifiConnectedWeak
  if (s.signal <= 50) return I.wifiConnectedFair
  if (s.signal <= 75) return I.wifiConnectedGood
  return I.wifiConnectedStrong
}

export default function mount({ port, hooks, config, backend }: AppletContext): void {
  let status: WifiStatus = { enabled: false, connected: false, signal: 0, connectivity: "none" }
  const ns = backend.network.netState(
    {
      floor: config.appearance.wifi?.floor ?? 100_000,
      windowSeconds: config.appearance.wifi?.window ?? 30,
    },
    () => !port.isHiddenState(),
  )
  const downSm = createSmoother(() => ns.peek().downRing, port.icon, config, 500)
  const upSm = createSmoother(() => ns.peek().upRing, port.icon, config, 500)

  // The applet's ONE fade-eligible element: the signal-strength glyph. A new
  // glyph — radio toggled, signal bucket, connectivity — cross-fades; the rate
  // rings and the disc are painted once per paint.
  const glyphFade = createElementFade<string>(port, config, "glyph")
  onCleanup(() => glyphFade.dispose())

  const drawIcon: DrawIcon = (cr, w, h, _value, _state, ringFill = 1, _skipDisc, _textValue) => {
    const rf = clamp01(ringFill)
    const size = Math.min(w, h)
    const cx = w / 2
    const cy = h / 2
    const thickness = config.appearance.ringThickness
    const radius = (config.layout.iconSize - thickness) / 2

    drawDisc(config, cr, size / 2, size / 2, size / 2)

    // Overlapping download + upload rate rings (behind the glyph)
    if (rf > 0.001) {
      const rings: OverlapRing[] = [
        { value: downSm.peek(), colour: ringColour("down", config) },
        { value: upSm.peek(), colour: ringColour("up", config) },
      ]
      drawOverlapRings(cr, cx, cy, radius, thickness, rings, -Math.PI / 2, rf)
    }

    // Signal-strength glyph on top (the declared fade element).
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

  function refresh(): void {
    void backend.wifi.wifiStatus().then((s) => {
      status = s
      // While the wifi GUI is open, do NOT push the state back into the panel:
      // it would (a) snap the icon away from the step the user just selected,
      // and (b) keep the panel's per-frame renders alive — which hold the
      // pointer outside the window's input region after the GUI maps,
      // swallowing the next click (the "second Open menu click is ignored"
      // bug). The icon state is re-read on the next panel open anyway.
      if (menuKind() !== "wifi") handle.externalChange(status.enabled ? 1 : 0)
      hooks.setAppletHidden(port.name, !s.enabled)
      if (!port.isOpen() && !port.isHiddenState()) port.icon.queue_draw()
    })
  }

  const pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, config.timing.poll.wifi, () => {
    refresh()
    return GLib.SOURCE_CONTINUE
  })

  // ── Scan step (step 2): request an NM rescan and spin the step's glyph for
  //    a fixed window (NM exposes no rescan status, so a local flag drives it).
  //    The wifi MENU also drives this spin while it is open (the in-menu scan
  //    spinner is gone): menu open → spin on, menu close → spin off — while
  //    menuScan is set, the window timer RE-ARMS instead of stopping, so the
  //    glyph spins for as long as the menu scans (wifi-scan-bridge). A manual
  //    step-2 toggle still cancels it (stopScan clears menuScan too). ──
  let scanning = false
  let menuScan = false // the wifi MENU wants the scan spin (menu-open scanning)
  let scanTimer: number | null = null
  function armScanWindow(): void {
    scanTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2800, () => {
      scanTimer = null
      if (menuScan) {
        armScanWindow() // menu still open — keep spinning
        return GLib.SOURCE_REMOVE
      }
      stopScan()
      return GLib.SOURCE_REMOVE
    })
  }
  function stopScan(): void {
    menuScan = false
    if (scanTimer !== null) {
      GLib.source_remove(scanTimer)
      scanTimer = null
    }
    if (scanning) {
      scanning = false
      handle.setSpin(2, false) // eases back to upright before stopping
    }
  }
  function startScan(): void {
    if (scanning) return
    scanning = true
    handle.setSpin(2, true)
    void backend.wifi.rescanWifi()
    armScanWindow()
  }

  onCleanup(() => {
    GLib.source_remove(pollId)
    stopScan()
  })
  // Event-driven: NetworkManager property/state signals refresh immediately —
  // the poll above is now the 30s safety net.
  onCleanup(backend.wifi.subscribeWifiStatus(() => refresh()))

  // Subscribe to network throughput for the rate rings on the icon. Kicked
  // unconditionally (even while the panel is open) so the rings stay alive —
  // but not while the icon is parked hidden in overflow (no ring to draw).
  onCleanup(
    ns.subscribe(() => {
      if (!port.isHiddenState()) {
        downSm.kick()
        upSm.kick()
      }
    }),
  )

  const handle = createStepApplet(port, {
    config,
    steps: STEPS(config),
    getStepColour: (i: number) => config.appearance.stepColours.wifi[i],
    getInitialStep: () => (status.enabled ? 1 : 0),
    drawIcon,
    // Pin the panel open while the wifi GUI is open (keepOpen suppresses the
    // leave-grace close) so the enable/disable/reconnect steps stay reachable
    // alongside the GUI.
    keepOpen: () => menuKind() === "wifi",
    onSelect: (step, close) => {
      const pinned = menuKind() === "wifi"
      switch (step) {
        case 0:
          void backend.wifi.setWifiEnabled(false)
          break
        case 1:
          void backend.wifi.setWifiEnabled(true)
          break
        case 2:
          // Scan TOGGLE: a tap while the scan spin is active cancels it.
          // (NM's rescan is one-shot — there is no backend scan to stop, so
          // "off" = cancelling the applet's scan state: the 2800ms window
          // timer is removed and the spin eases back to upright.) Does
          // nothing while the radio is off. The disc snaps back to the
          // current on/off step so it isn't "remembered" on the scan step
          // (both while the panel is pinned open and on close).
          if (status.enabled) {
            if (scanning) stopScan()
            else startScan()
          }
          handle.externalChange(status.enabled ? 1 : 0)
          break
        case 3:
          if (pinned) {
            // GUI prompted to close → close it AND the panel.
            closeMenu()
            close()
          } else {
            // Spawn the centred wifi GUI on this applet's monitor; the panel
            // stays open (keepOpen) while the GUI is up.
            openWifiMenu((port.window as any).gdkmonitor ?? app.get_monitors()[0], config, backend)
          }
          break
      }
      // While pinned, enable/disable/reconnect keep the panel open for
      // repeated toggling; otherwise they dismiss it as usual.
      if (step !== 3 && !pinned) close()
    },
    logLabel: "wifi",
  })

  // The wifi MENU drives this applet's scan glyph while it is open (the
  // menu itself shows no scan spinner): open → spin on (a rescan fires with
  // it), close/radio-off → spin off. Registered AFTER `handle` exists (the
  // hook closures call startScan/stopScan, which use handle.setSpin).
  onCleanup(
    setWifiMenuScanHook((on) => {
      if (on) {
        menuScan = true
        startScan() // already spinning (manual toggle) → the timer just re-arms
      } else {
        stopScan()
      }
    }),
  )

  // When the wifi GUI closes through any path (Escape, `menu close`, or the
  // single-open swap to the bluetooth GUI), close the pinned panel too.
  const unsubMenu = onMenuClose((kind) => {
    // Close the pinned panel only when the wifi GUI is REALLY gone — a
    // same-kind supersede (e.g. `menu wifi` while this open is mid-flight)
    // keeps the new menu's kind, and the pin must survive it.
    if (kind === "wifi" && menuKind() !== "wifi") handle.close()
  })
  onCleanup(unsubMenu)

  // First status poll (TDZ-safe: handle is assigned above).
  refresh()
}
