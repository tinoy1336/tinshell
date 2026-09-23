import GLib from "gi://GLib"
import type { AppletWindow } from "@common/applets/applet-window"
import { dockGeometry } from "@common/applets/layout"
import { createSurfaceApplet } from "@common/applets/surface/applet"
import type { AppletSurface } from "@common/applets/surface/surface"
import { geoBanner } from "@common/applets/utils/geo-log"
import { type Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { createRoot } from "gnim"
import { DOCK_APPLET_IMPLS, DOCK_OVERFLOW } from "./applets"
import { config } from "./config"
import { createDockSurface } from "./DockSurface"
import { createDockRow, type DockRow, setRebuildDocks } from "./dock-row"

// All live dock applet bindings across every monitor. Stored so the request
// handler can redraw them (live config keys) or tear them down + rebuild them
// (baked keys). Holds the AppletWindow handles so teardown can play the
// reverse appear animation before destroying the (one shared) surface.
let dockWindows: AppletWindow<DockRow>[] = []

// Per-monitor dock rows for the CURRENT generation. Disposed in rebuild
// teardown (timers/anims cleared) so no overflow session state leaks into a
// dead generation.
let dockRows: DockRow[] = []

// The per-monitor shared surfaces for the CURRENT generation. One layer
// window per monitor — rebuild destroys exactly one surface per monitor
// instead of one window per applet.
let dockSurfaces: AppletSurface[] = []

/** Per-surface chrome that reads live config: the opt-in debug-fill class
 *  (translucent bounds fill) and a surface repaint (the backdrop's draw_func
 *  reads appearance.backdrop per frame — queueing the window alone does not
 *  re-run child DrawingArea draw funcs in this GTK4 setup). Called at build
 *  time and from redrawAllDocks (the live-tier response). */
function applySurfaceChrome(s: AppletSurface): void {
  const ctx = s.window.get_style_context?.()
  if (ctx) {
    if (config.appearance.debugFill) ctx.add_class("debug-fill")
    else ctx.remove_class("debug-fill")
  }
  s.repaint()
}

// True while a rebuild teardown is retracting the old dock. Guards against
// reentrant rebuilds: a second rebuild during teardown is subsumed — the
// pending build reads live config at build time, and live config is always
// mutated BEFORE rebuildDocks() is called, so the single deferred build always
// reflects the latest state. (gjs is single-threaded, so no request can
// interleave mid-build.)
let teardownPending = false

// gnim root scopes for the CURRENT dock generation (one per monitor build).
// Disposed on the next rebuild AFTER the old surface is destroyed so the old
// applets' onCleanup registrations actually run. Without this, rebuilds build
// outside a gnim tracking context (the request handler has no Scope.current),
// so every onCleanup silently no-ops — leaking poll timers and reactive
// subscriptions from destroyed widgets that keep firing into dead widgets.
let dockScopes: (() => void)[] = []

/** Build the dock surface + applets for a single monitor. Called once per
 *  monitor at startup, and again per monitor inside rebuildDocks(). */
export default function Dock(gdkmonitor: Gdk.Monitor) {
  const geom = (gdkmonitor as any).get_geometry?.() ?? { width: 1440, height: 900 }
  const screenW: number = geom.width
  const screenH: number = geom.height
  const dg = dockGeometry(config.layout.position, config)
  const appletNames = config.applets.filter((name) => DOCK_APPLET_IMPLS[name])

  geoBanner(`Dock build pos=${config.layout.position}`)
  // Build inside a gnim root scope so the applets' onCleanup registrations
  // attach (Scope.current is set during construction) and are disposed with
  // this dock generation. app.start's own createRoot covers the FIRST build;
  // rebuilds from the request handler have no scope — this guarantees one
  // (without it, every onCleanup no-ops: polls/subscriptions leak on rebuild).
  createRoot((dispose) => {
    dockScopes.push(dispose)
    const surface = createDockSurface(gdkmonitor, dg)
    dockSurfaces.push(surface)
    const row = createDockRow(gdkmonitor, dg, screenW, screenH, surface)
    dockRows.push(row)

    // Applet bindings in config order (the row's slot order). The row owns
    // slots/visibility; slots start at 0 and initialLayout positions them.
    for (const name of appletNames) {
      const aw = createSurfaceApplet<DockRow>(surface, name)
      aw.row = row
      row.addWindow(name, aw)
      DOCK_APPLET_IMPLS[name](aw)
      dockWindows.push(aw)
    }

    // Overflow binding: always built (shown iff the hidden set is non-empty),
    // appended after all config applets so it stacks on top.
    const ow = createSurfaceApplet<DockRow>(surface, "overflow")
    ow.row = row
    row.setOverflowWindow(ow)
    DOCK_OVERFLOW.create(ow)
    dockWindows.push(ow)

    row.initialLayout()
    applySurfaceChrome(surface)
  })
}

/** Redraw every dock applet. Use when only live config keys changed (colours,
 *  fonts — read per-frame). No-op for baked keys (layout.*, position, applets):
 *  those need rebuildDocks().
 *
 * The icons are invalidated explicitly (queue_draw on the surface alone does
 * not re-run the icon DrawingAreas' draw funcs in this GTK4 setup). */
export function redrawAllDocks(): void {
  const seen = new Set<Gtk.Window>()
  for (const aw of dockWindows) {
    if (!seen.has(aw.window)) {
      seen.add(aw.window)
      aw.window.queue_draw()
    }
    aw.icon.queue_draw()
  }
  for (const s of dockSurfaces) applySurfaceChrome(s)
}

/** The current generation's per-monitor dock rows (for debug commands). */
export function getDockRows(): DockRow[] {
  return dockRows
}

/** The current generation's applet bindings (for debug commands). */
export function getDockWindows(): AppletWindow<DockRow>[] {
  return dockWindows
}

/** The current generation's per-monitor shared surfaces (debug region dump). */
export function getDockSurfaces(): AppletSurface[] {
  return dockSurfaces
}

/**
 * Destroy all dock surfaces and recreate them for every currently-connected
 *  monitor. Required after baked config keys change (layout.*, position).
 *
 * The swap is animated: every old applet plays the REVERSE appear animation
 * (glyph fades out, wedge retracts) in parallel over timing.appearAnim, then
 * ONE surface per monitor is destroyed and the fresh one maps and plays the
 * FORWARD appear animation — one window fading per monitor. A hard failsafe
 * (appearAnim + 250ms) guarantees teardown completes
 * even if a tick callback misbehaves. With appearAnim = 0 the whole swap is
 * instant. Callers treat this as fire-and-forget; the
 * response (e.g. "reloaded") fires before the new dock lands.
 */
export function rebuildDocks(): void {
  if (teardownPending) return
  teardownPending = true
  const olds = dockWindows
  const oldSurfaces = dockSurfaces
  dockWindows = [] // redrawAllDocks during teardown is a no-op; the olds are dying
  dockSurfaces = []

  for (const aw of olds) aw.setTearingDown(true)
  const reverses = olds.map((aw) => aw.playAppear(true))
  // Swing the overflow carets back to resting alongside the retract sweeps.
  for (const row of dockRows) reverses.push(row.teardownAnim())

  const failsafeMs = Math.max(500, config.timing.appearOutAnim) + 250
  const failsafe = new Promise<void>((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, failsafeMs, () => {
      resolve()
      return GLib.SOURCE_REMOVE
    })
  })

  Promise.race([Promise.all(reverses), failsafe]).then(() => {
    // ONE surface destroy per monitor (the bindings share it).
    for (const s of oldSurfaces) s.window.destroy()
    // Dispose the outgoing generation's dock rows (clears overflow timers and
    // slot animations) before their gnim cleanups run.
    for (const row of dockRows) row.dispose()
    dockRows = []
    // Run the outgoing generation's gnim cleanups now that its surface is
    // gone — removes the old applets' poll timers / subscriptions instead of
    // leaking them to fire into destroyed widgets.
    const scopes = dockScopes
    dockScopes = []
    for (const dispose of scopes) dispose()
    teardownPending = false
    for (const m of app.get_monitors()) Dock(m)
  })
}

// CYCLE-BREAK handoff, armed at MODULE SCOPE: dock-row calls back into here
// (via setRebuildDocks) for overflow move-mode rebuilds instead of importing
// ./Dock (which would re-form the Dock ↔ dock-row module cycle that deadlocks
// the universal host entry's runtime import). The move-mode commit path
// (detachForRebuild) fires rebuildDocksRef BEFORE any rebuildDocks() call has
// ever run — an in-function arm left the ref null at first mount, so the
// first move-mode drag committed without rebuilding (overflow alone landed at
// the dragged spot, the rest stayed). Function declarations hoist, so this
// top-level call is safe at import time.
setRebuildDocks(rebuildDocks)
