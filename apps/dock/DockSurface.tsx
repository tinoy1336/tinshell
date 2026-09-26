/**
 * DockSurface.tsx — the dock's LAYER-SHELL SUBSTRATE for the shared applet
 * renderer (common/applets/surface).
 *
 * The renderer (entries, row band, backdrop paint, input region, geometric
 * pointer routing, panel placement) is common code and holds no dock
 * specifics. This file owns exactly what a layer-shell band does differently
 * from an embedded strip:
 *   - the ONE layer window per monitor (namespace/class `dock-pill`), anchored
 *     at the configured grow-edge + row-start edge;
 *   - the window's default size (band × pillHeight), its grow-axis minimum
 *     (GTK's natural-size shrink must never take the empty fixed below
 *     iconSize) and its row-start margin;
 *   - the wl_surface: input region application (the renderer's discs +
 *     panel-stadium union), opaque-region clear and the explicit commit
 *     repaint;
 *   - the whole-window fade-in on map;
 *   - the window-level pointer controllers feeding the shared router.
 *
 * `createDockSurface(gdkmonitor, g)` returns the shared `AppletSurface` — the
 * same type the greeter's embedded substrate returns.
 */

import type { DockGeometry } from "@common/applets/layout"
import type { AppletSurfaceHost, AppletSurfacePointer } from "@common/applets/surface/host"
import { type AppletSurface, createAppletSurface } from "@common/applets/surface/surface"
import { ignore } from "@common/log/logger"
import { Astal, type Gdk, Gtk } from "ags/gtk4"
import { config } from "./config"
import { fadeIn } from "./fade"
import { DOCK_PILL_NAMESPACE } from "./identity"

/** Apply the band start: the row-axis margin of the anchored edge (the window
 *  is anchored at the row-start edge, so the margin is what moves the band). */
function applySurfaceMargins(win: any, g: DockGeometry, start: number): void {
  const m = g.margin
  if (g.growAxis === "y") {
    win.set_margin_left?.(Math.round(start))
    if (g.growDir < 0) win.set_margin_bottom?.(m.bottom)
    else win.set_margin_top?.(m.top)
  } else {
    win.set_margin_top?.(Math.round(start))
    if (g.growDir < 0) win.set_margin_right?.(m.right)
    else win.set_margin_left?.(m.left)
  }
}

/** The window-level pointer source: one row-level EventControllerMotion +
 *  GestureClick forward enter/leave/motion/press into the shared router. */
function connectSurfacePointer(window: any, sink: AppletSurfacePointer): void {
  const motion = new Gtk.EventControllerMotion()
  motion.connect("enter", (_c: any, x: number, y: number) => sink.enter(x, y))
  motion.connect("motion", (_c: any, x: number, y: number) => sink.motion(x, y))
  motion.connect("leave", () => sink.leave())
  window.add_controller(motion)

  const click = new Gtk.GestureClick()
  click.connect("pressed", (_c: any, _n: number, x: number, y: number) => sink.press(x, y))
  window.add_controller(click)
}

export function createDockSurface(gdkmonitor: Gdk.Monitor, g: DockGeometry): AppletSurface {
  const window = (
    <window
      namespace={DOCK_PILL_NAMESPACE}
      class="dock-pill"
      gdkmonitor={gdkmonitor}
      exclusivity={Astal.Exclusivity.IGNORE}
      layer={Astal.Layer.OVERLAY}
      anchor={g.anchor}
      // NONE: the band is a POINTER-ONLY surface. A layer surface whose
      // keyboard interactivity is not NONE takes the seat's keyboard focus the
      // moment it maps (Hyprland CLayerSurface::onMap) and again on every
      // pointer motion over it (InputManager mouseMoveUnified) — with
      // ON_DEMAND here the band stole the user's keys on every dock
      // spawn/restart, and nothing in the band types. The row raises it to
      // ON_DEMAND only while a panel is open (see dock-row `setPanelOpen`),
      // the one state whose Escape drag-bail needs the compositor to deliver
      // keys here; the close hands them back.
      keymode={Astal.Keymode.NONE}
      // Start invisible: the map handler fades the surface in (fade.ts) —
      // set BEFORE `visible` so the first painted frame is already at 0.
      opacity={0}
      visible
      resizable
    />
  ) as any

  const host: AppletSurfaceHost = {
    window,
    // The renderer's row widget is the window's only child.
    mountRow: (row: Gtk.Fixed) => window.set_child(row),
    setExtent: (row: number, grow: number) => {
      window.set_default_size(g.growAxis === "y" ? row : grow, g.growAxis === "y" ? grow : row)
    },
    setRowStart: (start: number) => applySurfaceMargins(window, g, start),
    setInputRegion: (region): boolean => {
      const surf = window.get_surface?.()
      if (!surf || typeof surf.set_input_region !== "function") return false
      surf.set_input_region(region as any)
      return true
    },
    bounds: () => ({ w: window.get_width?.() ?? 0, h: window.get_height?.() ?? 0 }),
    connectPointer: (sink) => connectSurfacePointer(window, sink),
    repaint: () => window.queue_draw(),
  }

  const surface = createAppletSurface({ geometry: g, config, host })

  // Empty-band floor: GTK's natural-size shrink must never take the window
  // below iconSize on the grow axis (height for top/bottom, width for
  // left/right) — with every applet parked the fixed's natural size is 0 and
  // the surface would collapse entirely.
  window.set_size_request(
    g.growAxis === "y" ? -1 : Math.round(config.layout.iconSize),
    g.growAxis === "y" ? Math.round(config.layout.iconSize) : -1,
  )

  window.connect("realize", () => {
    const surf = window.get_surface?.()
    if (!surf) return
    try {
      surf.set_opaque_region?.(null)
    } catch (e) {
      ignore("surface opaque region clear", e)
    }
  })
  window.connect("map", () => {
    // Whole-window fade-in (startup show / rebuild's fresh surface).
    fadeIn(window)
    // Birth intros + the input-region issue happen on the surface's map leg.
    surface.notifyMapped()
  })
  if (window.get_mapped?.()) {
    // Layer-shell maps SYNCHRONOUSLY on realize (initial configure) — the
    // "map" connect above can land after the window already mapped.
    fadeIn(window)
    surface.notifyMapped()
  }

  return surface
}
