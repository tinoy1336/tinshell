/**
 * host.ts — the substrate PORT the shared applet renderer
 * (common/applets/surface/surface.ts) runs on.
 *
 * ONE renderer, two substrates:
 *   - the dock (apps/dock) — a layer-shell window: the renderer's Gtk.Fixed is
 *     the window's child, a geometry change resizes the window and moves its
 *     row-start margin, and pointer delivery is bounded by a wl_surface input
 *     region (the discs + panel stadiums union, plus the bar band the dock
 *     absorbs);
 *   - the greeter strip (apps/greeter) — an embedded widget: the fixed is a
 *     child of the strip container, a geometry change sizes that container,
 *     and GTK's own pick bounds delivery across the whole row rect (the strip
 *     has no surface of its own), so the renderer's router enforces the
 *     capture geometry itself.
 *
 * Every member here is something those two genuinely do differently. Nothing
 * in this port carries appearance values, layout math, panel wiring or
 * backdrop paint — all of that is the renderer's. The renderer takes the host
 * as a plain parameter (`createAppletSurface({ geometry, config, host })`), so
 * no host is reached through a module global.
 */

import type { CairoRegion } from "@common/applets/utils/row-region"
import type { Gtk } from "ags/gtk4"

/** Raw pointer events, already mapped into the renderer's coordinate space
 *  (surface-local: row-axis band offsets + grow axis from the grow edge). The
 *  renderer's router applies every semantic (hit-test, open suppression,
 *  pending-enter promotion, indicator latching). */
export interface AppletSurfacePointer {
  enter: (x: number, y: number) => void
  motion: (x: number, y: number) => void
  leave: () => void
  /** A press inside the host's bounds — the touch tap-to-open path. */
  press: (x: number, y: number) => void
}

export interface AppletSurfaceHost {
  /** The hosting window: the dock's layer window, the greeter's window. The
   *  applet bindings hand it to the applet cores (panel Escape target) and
   *  applets read host-specific props off it (the dock's window carries
   *  `gdkmonitor`). */
  window: Gtk.Window
  /** Attach the renderer's row widget (its Gtk.Fixed: backdrop + icons +
   *  panel overlays) to the substrate. */
  mountRow: (row: Gtk.Fixed) => void
  /** Apply the surface extent: the row-axis band length × the grow-axis band
   *  height (layout.pillHeight — the band hosts open panels). */
  setExtent: (row: number, grow: number) => void
  /** Apply the row-axis band start within the host. The dock moves its
   *  window's row-start margin; an embedded strip container centres itself
   *  and no-ops. */
  setRowStart: (start: number) => void
  /** Apply the pointer input region (null = clear). Returns true when the
   *  region is handled — set on the surface, or deliberately not applicable
   *  for this substrate (a widget host uses GTK pick) — and false when it
   *  could not be applied YET (the dock's window has no wl_surface before
   *  realize), in which case the renderer re-issues it on the next geometry
   *  change (its map leg included). */
  setInputRegion: (region: CairoRegion | null) => boolean
  /** Does this substrate's bar BAND absorb pointer input across the whole row
   *  — is it a hit target in its own right? The dock's layer-shell band sits
   *  over the desktop, so a press on the bar must land on the surface instead
   *  of falling through to the layer below: true. An embedded strip inside the
   *  host's own window (the greeter) has nothing behind it to shield: false,
   *  and only the discs and the open panels' pills capture — the band above
   *  the icons and the discs' square corners stay inert.
   *
   *  This is also the capture model of a substrate with NO input region of its
   *  own: the renderer's router enforces the region geometry either way (see
   *  common/applets/utils/row-region.ts), so an embedded host that cannot clip
   *  delivery captures exactly the same pixels a layer surface does.
   *
   *  Default: true (the layer-surface model the dock is built on). */
  captureBand?: boolean
  /** Current bounds in the same coordinate space pointer events arrive in —
   *  the renderer drops out-of-bounds (synthetic) events against them. */
  bounds: () => { w: number; h: number }
  /** Wire the substrate's pointer source. The dock attaches the controllers
   *  to its layer window; the greeter attaches them to the strip container. */
  connectPointer: (sink: AppletSurfacePointer) => void
  /** Commit pending host state (the dock repaints its layer window so a
   *  changed input region reaches the compositor). */
  repaint: () => void
}
