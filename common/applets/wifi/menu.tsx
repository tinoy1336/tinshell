/**
 * common/applets/wifi/menu.tsx — the wifi GUI.
 *
 * Spawned by the wifi applet (step "Open menu") via
 * openWifiMenu(monitor, config, backend).
 * Wifi-only by design: the header holds the enable/disable toggle, then the
 * current connection + network list (signal tiers + security lock), inline
 * password entry for secured networks, rescan. No hotspot/VPN/settings
 * deep-links.
 *
 * Connect flow (canonical try-first): clicking a network runs
 * `nmcli dev wifi connect` with NO password — that succeeds for open networks
 * and for saved secured networks (NM reuses the stored profile). Only when it
 * fails AND the network is secured do we show the inline password entry;
 * failures surface as a red error row instead of being swallowed.
 *
 * State lives in a closure inside the menu's gnim scope; the poll timer is
 * registered with onCleanup so it dies with the menu. setRows() re-renders the
 * whole list from the state — rows are fixed-height so this is cheap and the
 * panel height tracks the row count.
 *
 * Open flow (the no-shrink primed open): openWifiMenu() first fetches the
 * wifi status + the active AP's SSID (fast, bounded D-Bus reads) BEFORE the
 * window opens, then openMenu() maps with the CURRENT network as the only
 * row — the panel height is stable from the first frame and only ever GROWS
 * (scan results append per poll; the menu never collapses). The old
 * spinner-then-shrink-then-fill flow is gone: the in-menu scan spinner was
 * REMOVED — the scan spin lives on the wifi applet's scan glyph instead
 * (menu/wifi-scan-bridge.ts drives it; the menu still keeps a spinner for
 * the in-flight CONNECT state only).
 */

import GLib from "gi://GLib"
import type { AppletBackend, WifiNetwork } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import {
  createBusyWatchdog,
  later,
  type MenuController,
  menuEntryRow,
  menuInfoRow,
  menuRow,
  openMenu,
} from "@common/menus/menu-framework"
import { createSpinnerGlyph } from "@common/menus/spinner"
import type { Gdk, Gtk } from "ags/gtk4"
import { onCleanup } from "gnim"
import { wifiMenuScanNotify } from "./scan-bridge"

interface WifiMenuState {
  enabled: boolean
  connected: boolean
  networks: WifiNetwork[]
  /** SSID of the network a connect is in flight for (row shows "Connecting…"). */
  connecting: string | null
  /** SSID awaiting the inline password entry. */
  passwordFor: string | null
  /** The in-progress password text — survives poll re-renders (the entry was
   *  rebuilt empty every poll before, wiping what the user was typing). */
  passwordText: string
  /** SSIDs with a saved profile (the "known network" marker). */
  saved: string[]
  /** Last action failure (shown as a red row under the list). */
  error: string | null
}

type IconSet = AppletConfig["appearance"]["icons"]

/** Signal-tier glyph (plain strength, no lock — matches the dock's scanning set). */
function signalGlyph(signal: number, I: IconSet): string {
  if (signal >= 75) return I.menuWifiStrong
  if (signal >= 50) return I.menuWifiGood
  if (signal >= 25) return I.menuWifiFair
  return I.menuWifiWeak
}

/** Connected-tier glyph — the config's "connected" emoji set (wifiConnected*),
 *  tiered by signal the same way the dock icon does (Wifi.tsx). The current
 *  connection row's leading emoji: connected reads as a FILLED signal, distinct
 *  from the scanning-style menuWifi* glyphs on the rest of the list. */
function connectedGlyph(signal: number, I: IconSet): string {
  if (signal >= 75) return I.wifiConnectedStrong
  if (signal >= 50) return I.wifiConnectedGood
  if (signal >= 25) return I.wifiConnectedFair
  return I.wifiConnectedWeak
}

export function openWifiMenu(
  monitor: Gdk.Monitor,
  config: AppletConfig,
  backend: AppletBackend,
): void {
  const I = (): IconSet => config.appearance.icons
  const state: WifiMenuState = {
    enabled: false,
    connected: false,
    networks: [],
    connecting: null,
    passwordFor: null,
    passwordText: "",
    saved: [],
    error: null,
  }
  let ctl: MenuController | null = null
  let scanned = false // first scan completed (distinguishes loading vs empty)
  /** The menu drove the applet's scan spin (wifiMenuScanNotify(true) sent) —
   *  cleared on close/radio-off so the applet glyph never spins orphaned. */
  let scanSpun = false

  // The spinning 🔄 while a CONNECT is in flight (one shared instance so it
  // survives row re-renders without resetting its angle). WHITE (the menu
  // text colour) — the connecting spinner sits in the LEADING emoji slot.
  // The SCAN spin does NOT live here: it is the wifi applet's scan glyph
  // (wifi-scan-bridge) — the menu never shows a scanning spinner.
  const spinner = createSpinnerGlyph({
    fontFamily: config.fonts.family,
    size: 20,
    emoji: I().menuSpinner,
    colour: config.appearance.menu.text,
  })

  // ── Hover-flicker guard: the 5s poll only re-renders when the RENDERED
  //  state actually changed (a fresh row would otherwise reset its hover
  //  every tick — the highlight vanishes under a still pointer). Signal is
  //  snapshotted as a tier so strength wobble doesn't re-render. ──
  let lastSnap = ""
  const snapshot = (): string => {
    const tier = (sig: number) => (sig >= 75 ? 3 : sig >= 50 ? 2 : sig >= 25 ? 1 : 0)
    return JSON.stringify({
      enabled: state.enabled,
      connected: state.connected,
      connecting: state.connecting,
      passwordFor: state.passwordFor,
      error: state.error,
      scanned,
      saved: [...state.saved].sort(),
      nets: state.networks.map((n) => [n.ssid, n.inUse, n.security, tier(n.signal)]),
    })
  }

  /** Resolve `p`, or resolve `fallback` after `ms` if it stalls. The stuck
   *  promise keeps running and its late result is ignored — a hung nmcli
   *  subprocess or D-Bus read can never freeze the menu at the loading
   *  spinner again (the 5s poll retries and corrects). */
  function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
      let done = false
      const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        if (!done) {
          done = true
          resolve(fallback)
        }
        return GLib.SOURCE_REMOVE
      })
      p.then((v) => {
        if (!done) {
          done = true
          GLib.source_remove(id)
          resolve(v)
        }
      })
    })
  }

  function refresh(): void {
    void (async () => {
      // Every stage is bounded: a stalled subprocess/D-Bus read (observed on
      // the nmcli scan) must not leave the menu stuck. Each stage renders as
      // it lands — the current network row is live after the status read,
      // then the scanned list appends, then the saved markers. That is the
      // "list grows as networks are scanned" flow (no single big fill).
      const status = await withTimeout(backend.wifi.wifiStatus(), 3000, {
        enabled: true,
        connected: false,
        signal: 0,
        connectivity: "unknown",
      })
      state.enabled = status.enabled
      state.connected = status.connected
      if (!status.enabled) {
        state.networks = []
        state.saved = []
        if (scanSpun) {
          scanSpun = false
          wifiMenuScanNotify(false) // radio off — release the applet's scan spin
        }
        if (snapshot() !== lastSnap) render()
        return
      }
      const nets = status.enabled
        ? await withTimeout(backend.wifi.scanWifiNetworks(), 4000, [] as WifiNetwork[])
        : []
      state.networks = nets
      scanned = true
      // A stale password prompt is meaningless after the list changed.
      if (state.passwordFor && !nets.some((n) => n.ssid === state.passwordFor))
        state.passwordFor = null
      // Skip the re-render when nothing that RENDERS changed (flicker fix).
      if (snapshot() !== lastSnap) render()
      const saved = status.enabled
        ? await withTimeout(backend.wifi.savedSsidList(), 4000, [] as string[])
        : []
      state.saved = saved
      if (snapshot() !== lastSnap) render()
    })()
  }

  /** Failsafe: a hung nmcli action must never freeze the flow (the
   *  `if (state.connecting) return` guard would swallow every later attempt).
   *  Shared by connect + disconnect. */
  const actionWatchdog = createBusyWatchdog(20000, () => {
    if (state.connecting) {
      state.connecting = null
      render()
    }
  })
  function doConnect(net: WifiNetwork, password?: string): void {
    if (state.connecting) return
    state.connecting = net.ssid
    state.passwordFor = null
    state.passwordText = ""
    state.error = null
    render()
    actionWatchdog.arm()
    void backend.wifi.connectWifi(net.ssid, password).then((r) => {
      state.connecting = null
      actionWatchdog.disarm()
      if (r.ok) {
        // Give NetworkManager a moment to associate before re-scanning.
        later(1200, refresh)
      } else if (!password && net.security) {
        state.passwordFor = net.ssid // needs a password — show the entry
        render()
      } else {
        state.error = r.error ?? "Connection failed"
        render()
      }
    })
  }

  /** The current-connection row — shared by buildRows() (render) and the
   *  primed open. Click = disconnect; the trash forgets the active profile. */
  function currentRow(net: WifiNetwork): Gtk.Widget {
    return menuRow({
      config,
      emoji: connectedGlyph(net.signal, I()),
      text: net.ssid,
      status: I().menuCheck,
      statusColour: "accent",
      active: true,
      onClick: () => {
        if (state.connecting) return
        state.connecting = net.ssid
        state.error = null
        render()
        // Watchdog: a hung `nmcli dev disconnect` must not leave the
        // connecting spinner spinning forever (same pattern as doConnect).
        actionWatchdog.arm()
        void backend.wifi.disconnectWifi().then((r) => {
          state.connecting = null
          actionWatchdog.disarm()
          if (!r.ok) state.error = r.error ?? "Disconnect failed"
          later(500, refresh)
        })
      },
      // Forget the active profile (nmcli connection delete) — the trash
      // "lights up" on hover instead of a filled circle.
      action: {
        emoji: I().menuForget,
        onClick: () => {
          if (state.connecting) return
          void backend.wifi.forgetWifiNetwork(net.ssid).then((r) => {
            if (!r.ok) state.error = r.error ?? "Forget failed"
            later(500, refresh)
          })
        },
      },
    })
  }

  /** All rows from state — pure (no ctl), so the primed open can build its
   *  INITIAL rows with exactly the same code render() uses. */
  function buildRows(): Gtk.Widget[] {
    const rows: Gtk.Widget[] = []

    // The failure row goes FIRST: the list is capped at
    // appearance.menu.maxRows rows, so a row appended after a full network
    // list is painted below the visible panel and the user never sees it — a
    // connect that failed must never end as a silent no-op.
    if (state.error) rows.push(menuInfoRow(state.error, config, "danger"))

    if (!state.enabled) {
      rows.push(menuInfoRow("WiFi is off", config))
      return rows
    }

    // ── Current connection ──
    const current = state.networks.find((n) => n.inUse)
    if (state.connected && current) rows.push(currentRow(current))

    // ── Network list (skip the connected one — it has its own row) ──
    const listed = state.networks.filter((n) => !n.inUse)
    if (listed.length === 0 && !state.connected) {
      // NO in-menu scan spinner: a stable-height text row until scan results
      // land (the scan spin lives on the applet's scan glyph).
      rows.push(
        scanned ? menuInfoRow("No networks found", config) : menuInfoRow("Scanning…", config),
      )
    }
    for (const net of listed) {
      const connecting = state.connecting === net.ssid
      rows.push(
        menuRow({
          config,
          // Connecting: the leading emoji becomes the white spinning glyph (the
          // signal strength is moot mid-connect); the security lock stays in
          // the status slot.
          emoji: connecting ? undefined : signalGlyph(net.signal, I()),
          emojiWidget: connecting ? spinner.widget : undefined,
          text: net.ssid,
          status: net.security ? I().menuLock : undefined,
          statusColour: "mutedText",
          // Saved networks get a trash on the right cap — it IS the known
          // marker and forgets the profile straight
          // from the list. The lock status sits left of it.
          action: state.saved.includes(net.ssid)
            ? {
                emoji: I().menuForget,
                onClick: () => {
                  if (state.connecting) return
                  void backend.wifi.forgetWifiNetwork(net.ssid).then((r) => {
                    if (!r.ok) state.error = r.error ?? "Forget failed"
                    later(500, refresh)
                  })
                },
              }
            : undefined,
          onClick: () => {
            if (state.connecting) return
            if (state.passwordFor === net.ssid) {
              // Entry already open for this network — first click closes it.
              state.passwordFor = null
              render()
              return
            }
            doConnect(net) // try without a password first
          },
        }),
      )
      // Inline password entry directly under the network it belongs to. The
      // typed text lives in state.passwordText (onChange) so a poll re-render
      // rebuilds this row WITH the text — it never clears mid-typing. Hidden
      // by default; the eyeball toggles visibility.
      if (state.passwordFor === net.ssid) {
        rows.push(
          menuEntryRow({
            config,
            placeholder: `Password for ${net.ssid}`,
            password: true,
            focusOnMount: true, // type immediately after clicking the network
            showToggle: true, // eyeball show/hide
            value: state.passwordText,
            onChange: (v) => {
              state.passwordText = v
            },
            onSubmit: (pw) => doConnect(net, pw),
            onCancel: () => {
              state.passwordFor = null
              state.passwordText = ""
              render()
            },
          }),
        )
      }
    }

    return rows
  }

  function render(): void {
    if (!ctl) return
    lastSnap = snapshot()
    // The spinner is CONNECT-state feedback only — the scan spin lives on
    // the wifi applet's scan glyph (wifi-scan-bridge).
    spinner.setSpinning(!!state.connecting)
    ctl.setRows(buildRows())
  }

  // ── Prime-then-open (the no-shrink open) ──
  // The OLD flow opened the menu with a spinner row and filled the list on
  // the first poll — the panel collapsed to a 1-row height at spin-stop and
  // re-expanded when the list landed. Now: the status + active SSID are read
  // (fast, bounded D-Bus) BEFORE openMenu() so the window maps with the
  // CURRENT network as its only row — the height is stable from the first
  // frame and only ever grows (scan results append per poll). The scan spin
  // is driven on the APPLET's scan glyph, not in the menu.
  void (async () => {
    const status = await withTimeout(backend.wifi.wifiStatus(), 1500, {
      enabled: true,
      connected: false,
      signal: 0,
      connectivity: "unknown",
    })
    const initialRows: Gtk.Widget[] = []
    if (!status.enabled) {
      state.enabled = false
      initialRows.push(menuInfoRow("WiFi is off", config))
    } else {
      state.enabled = true
      state.connected = status.connected
      const ssid = status.connected
        ? await withTimeout(backend.wifi.activeWifiSsid(), 1500, null)
        : null
      if (ssid) {
        // The current network IS the initial list — one row, exact height.
        state.networks = [{ ssid, signal: status.signal, security: "", inUse: true }]
        initialRows.push(...buildRows())
      } else {
        // Not connected (or SSID read lost the race): a stable-height text
        // row — refresh() replaces it the moment scan results land.
        initialRows.push(menuInfoRow("Scanning…", config))
      }
      scanSpun = true
      wifiMenuScanNotify(true) // spin the APPLET's scan glyph while the menu scans
    }
    ctl = openMenu({
      config,
      kind: "wifi",
      monitor,
      rows: initialRows,
      onMount: (c) => {
        ctl = c
        // Poll created INSIDE onMount so its cleanup is scoped to the menu's
        // gnim root — a poll created before openMenu leaks when the
        // deferred-open path skips onMount (menu closed mid-switch).
        const pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, config.timing.poll.wifiMenu, () => {
          refresh()
          return GLib.SOURCE_CONTINUE
        })
        // First paint immediately; then the poll keeps it fresh.
        refresh()
        onCleanup(() => {
          GLib.source_remove(pollId)
          // Release the applet's scan spin on ANY close path (Escape,
          // `menu close`, single-open swap).
          if (scanSpun) {
            scanSpun = false
            wifiMenuScanNotify(false)
          }
        })
      },
    })
  })()
}
