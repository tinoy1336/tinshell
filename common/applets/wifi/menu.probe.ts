/**
 * menu.probe — the wifi menu's connect flow with NO network behind it.
 *
 * openWifiMenu() drives a STUB wifi domain: no nmcli, no NetworkManager, no
 * radio state, no profile writes. The stub reproduces what nmcli answers at
 * each stage — a secured network refuses the password-less attempt
 * ("secrets were required"), and the password attempt fails with a readable
 * message — so the whole menu flow runs end to end: row click → connecting
 * spinner → inline password entry → submit → the failure's visible row.
 *
 * The menu itself is the REAL one: the real config store (the dock's live
 * config), the real centred-menu shell, the real rows, the real password entry.
 *
 * Diagnostics it prints every tick (the reasons it exists):
 *   - focus=<widget> — the widget the menu window has focused: typed keys land
 *     in the password entry only while the entry holds this focus;
 *   - connect(ssid, password) — the exact arguments each attempt receives, so a
 *     submit that never reaches the backend shows up as a MISSING line;
 *   - key(ENTRY CAPTURE/BUBBLE) — the probe's own controllers on the entry, so
 *     a key that the entry's own handler never sees names the layer that
 *     claimed it;
 *   - errorRow=index=… y=… viewport=… visible=… — the failure row's MEASURED
 *     place in the scroll viewport (rows past appearance.menu.maxRows are
 *     painted nowhere), with the same measurement for the list's LAST row.
 *
 * Run: ags run --gtk 4 common/applets/wifi/menu.probe.ts
 * (a dev harness — the production path is the applet's own Open menu step)
 */
import GLib from "gi://GLib"
import type { AppletBackend, WifiNetwork } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import { appConfigPath, appSchemaDir, createConfigStore } from "@common/config/loader"
import { logTo } from "@common/log/logger"
import { menuDebugInfo, menuInit } from "@common/menus/menu-framework"
import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { openWifiMenu } from "./menu"

const LOG = "/tmp/wifi-menu-probe.log"

function say(line: string): void {
  logTo(LOG, line)
}

/** The error text the stub answers with — the probe looks for this string in
 *  the row tree to prove the failure reached a ROW at all. */
const STUB_ERROR = "probe: activation failed (stub)"

/** More networks than appearance.menu.maxRows, so a failure row appended after
 *  the list has to land past the viewport (the swallow this probe measures). */
function networks(config: AppletConfig): WifiNetwork[] {
  const count = config.appearance.menu.maxRows + 5
  const list: WifiNetwork[] = [{ ssid: "probe-home", signal: 82, security: "WPA2", inUse: true }]
  for (let i = 1; i <= count; i++)
    list.push({ ssid: `probe-net-${i}`, signal: 60 - i, security: "WPA2", inUse: false })
  return list
}

function stubWifi(config: AppletConfig): AppletBackend["wifi"] {
  const nets = networks(config)
  return {
    wifiStatus: async () => ({ enabled: true, connected: true, signal: 82, connectivity: "full" }),
    activeWifiSsid: async () => "probe-home",
    scanWifiNetworks: async () => nets,
    savedSsidList: async () => [],
    // The nmcli shape the real domain sees: a password-less attempt against a
    // secured network is refused; a password attempt activates and fails.
    connectWifi: async (ssid: string, password?: string) => {
      say(
        `connect(${JSON.stringify(ssid)}, ${password === undefined ? "no password" : JSON.stringify(password)})`,
      )
      return password === undefined
        ? { ok: false, error: "probe: secrets were required, but not provided" }
        : { ok: false, error: STUB_ERROR }
    },
    rescanWifi: async () => {},
    setWifiEnabled: async () => {},
    disconnectWifi: async () => ({ ok: true }),
    forgetWifiNetwork: async () => ({ ok: true }),
    subscribeWifiStatus: () => () => {},
  } as AppletBackend["wifi"]
}

/** A window's content root: Gtk.Window exposes its child through get_child(),
 *  which the widget-level child enumeration does not reach. */
function windowRoot(win: any): any {
  return win?.get_child?.() ?? win
}

/** The widget the menu window has focused (`Gtk.Window.get_focus`, then the
 *  focus-child chain — the entry is a leaf of that chain). */
function focusedWidget(win: any): any {
  let w: any = win?.get_focus?.() ?? win?.get_focus_child?.() ?? null
  let depth = 0
  while (w?.get_focus_child?.() && depth++ < 12) w = w.get_focus_child()
  return w
}

function describe(w: any): string {
  if (!w) return "none"
  const name = w.constructor?.name ?? "?"
  const text = typeof w.get_text === "function" ? ` text=${JSON.stringify(w.get_text())}` : ""
  return `${name}${text}`
}

/** Every widget in `root`'s subtree whose own text CONTAINS `needle` (a row
 *  label may carry markup around the text). */
function findText(root: any, needle: string, out: any[] = [], depth = 0): any[] {
  if (!root || depth > 10) return out
  if (typeof root.get_text === "function" && root.get_text().includes(needle)) out.push(root)
  let child = root.get_first_child?.()
  while (child) {
    findText(child, needle, out, depth + 1)
    child = child.get_next_sibling?.()
  }
  return out
}

/** The password entry — a Gtk.Entry anywhere in the window subtree. */
function findEntry(root: any, depth = 0): any {
  if (!root || depth > 10) return null
  if (root.constructor?.name === "Gtk_Entry") return root
  let child = root.get_first_child?.()
  while (child) {
    const hit = findEntry(child, depth + 1)
    if (hit) return hit
    child = child.get_next_sibling?.()
  }
  return null
}

/** Key-event tracing: the probe's own controllers on the entry, in BOTH phases,
 *  so a key the entry's own handler never sees names the phase that swallowed
 *  it, plus GTK's own `activate` (the entry's Return path). */
function traceKeys(entry: any): void {
  for (const phase of [Gtk.PropagationPhase.CAPTURE, Gtk.PropagationPhase.BUBBLE]) {
    const tag = phase === Gtk.PropagationPhase.CAPTURE ? "CAPTURE" : "BUBBLE"
    const c = new Gtk.EventControllerKey()
    c.set_propagation_phase(phase)
    c.connect("key-pressed", (_c: any, keyval: number) => {
      say(`key(ENTRY ${tag}) keyval=${keyval}`)
      return false
    })
    entry.add_controller(c)
  }
  entry.connect("activate", () => say("entry ::activate signal"))
}

/** Where a row sits in the menu's scroll viewport. The rows live in a plain
 *  Gtk.Box inside the scrolled window's viewport (the framework's `listBox` is
 *  a Box, not a Gtk.ListBox), so the row is found by geometry: it is the child
 *  of the container that sits directly in the viewport.
 *  `visible` is MEASURED — a row past the viewport's height is painted
 *  nowhere, and a failure the user cannot see is the silent no-op this probe
 *  exists to catch. */
function rowPlacement(row: any): string {
  let scrolled: any = row?.get_parent?.()
  while (scrolled && !(scrolled instanceof Gtk.ScrolledWindow)) scrolled = scrolled.get_parent?.()
  if (!scrolled) return "no viewport ancestor"
  const [ok, , y] = row.translate_coordinates(scrolled, 0, 0) as unknown as [number, number, number]
  const h = row.get_allocation().height
  const vh = scrolled.get_allocation().height
  const visible = !!ok && y >= 0 && y + h <= vh
  return `y=${Math.round(y)} h=${Math.round(h)} viewport=${Math.round(vh)} visible=${visible}`
}

/** The row container (the child of the scroll viewport) and the rows in it. */
function rowsContainer(win: any): { box: any; rows: any[] } | null {
  const viewport = (function find(w: any): any {
    if (!w) return null
    if (w instanceof Gtk.Viewport) return w
    let child = w.get_first_child?.()
    while (child) {
      const hit = find(child)
      if (hit) return hit
      child = child.get_next_sibling?.()
    }
    return null
  })(windowRoot(win))
  const box = viewport?.get_first_child?.()
  if (!box) return null
  const rows: any[] = []
  let child = box.get_first_child?.()
  while (child) {
    rows.push(child)
    child = child.get_next_sibling?.()
  }
  return { box, rows }
}

/** The failure row's index + measured placement, plus the same measurement for
 *  the list's last row. */
function errorRowReport(win: any, maxRows: number): string {
  const hit = findText(windowRoot(win), STUB_ERROR)[0]
  const container = rowsContainer(win)
  const last = container?.rows.length
    ? ` lastRow=${rowPlacement(container.rows[container.rows.length - 1])}`
    : ""
  if (!hit) return `absent${last}`
  const row = (function rowOf(w: any): any {
    let child = w
    let parent = w.get_parent?.()
    while (parent) {
      if (container && parent === container.box) return child
      child = parent
      parent = parent.get_parent?.()
    }
    return w
  })(hit)
  const idx = container ? container.rows.indexOf(row) : -1
  return `index=${idx} withinMaxRows=${idx >= 0 && idx < maxRows} ${rowPlacement(row)}${last}`
}

app.start({
  main() {
    const config = createConfigStore(appSchemaDir("dock"), appConfigPath("dock"))
      .config as unknown as AppletConfig
    const monitor = app.get_monitors()[0]
    if (!monitor) {
      say("no monitor — aborting")
      return
    }
    menuInit(monitor, config)
    const backend = { wifi: stubWifi(config) } as unknown as AppletBackend
    openWifiMenu(monitor, config, backend)
    say(
      `opened — maxRows=${config.appearance.menu.maxRows} rowHeight=${config.appearance.menu.rowHeight}`,
    )

    let last = ""
    let traced = false
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
      // This process's own toplevels (GTK4 keeps the list per display
      // connection): the menu shell + the scrim the framework created.
      const model = Gtk.Window.get_toplevels()
      const windows: any[] = []
      for (let i = 0; i < model.get_n_items(); i++) windows.push(model.get_item(i))
      const win = windows.find((w: any) => w.namespace === "dock-menu") ?? null
      if (!win) return GLib.SOURCE_CONTINUE
      if (!traced) {
        const entry = findEntry(windowRoot(win))
        if (entry) {
          traced = true
          traceKeys(entry)
          say("key tracing attached (entry capture + bubble, ::activate)")
        }
      }
      const line = `focus=${describe(focusedWidget(win))} errorRow=${errorRowReport(
        win,
        config.appearance.menu.maxRows,
      )}`
      if (line !== last) {
        last = line
        say(line)
        say(menuDebugInfo().replace(/\n/g, " | "))
      }
      return GLib.SOURCE_CONTINUE
    })
  },
})
