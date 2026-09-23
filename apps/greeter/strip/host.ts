/**
 * host — the greeter strip's SUBSTRATE for the shared applet renderer
 * (common/applets/surface).
 *
 * The dock's substrate is a layer-shell window (apps/dock/DockSurface.tsx);
 * this is the other one: an EMBEDDED widget row. The renderer's Gtk.Fixed (its
 * row: backdrop + icons + panel overlays) becomes this container's child, a
 * geometry change sizes that row, and GTK's own pick delivers the pointer
 * (there is no wl_surface of the strip's own, so there is no input region to
 * set). The frost behind the strip comes from the compositor blurring what is
 * behind the greeter window — the window stays transparent (see GreeterDock).
 *
 * Nothing else lives here: appearance, layout, panel wiring, backdrop paint
 * and pointer semantics are the renderer's.
 */

import type { AppletSurfaceHost, AppletSurfacePointer } from "@common/applets/surface/host"
import { Gtk } from "ags/gtk4"

interface StripHostOptions {
  /** The hosting window (login layer window, lock window, preview window).
   *  Null while the login window does not exist yet — the renderer's row then
   *  hosts the applets' panel-Escape controller, as before. */
  getWindow: () => Gtk.Window | null
  /** Bottom margin under the strip (the greeter config's `dock.marginBottom`). */
  marginBottom: number
}

interface GreeterStripHost extends AppletSurfaceHost {
  /** The widget the greeter composes (bottom-centre): the renderer's row. */
  container: Gtk.Box
}

export function createGreeterStripHost(opts: StripHostOptions): GreeterStripHost {
  const container = new Gtk.Box()
  container.halign = Gtk.Align.CENTER
  container.valign = Gtk.Align.END
  container.margin_bottom = opts.marginBottom

  let row: Gtk.Fixed | null = null

  const host: GreeterStripHost = {
    container,
    // The applet cores' window handle (panel Escape) and the window applets
    // read host props off. Pre-window (login builds the strip before its
    // window exists) the row itself hosts that controller.
    get window() {
      return (opts.getWindow() ?? row ?? container) as unknown as Gtk.Window
    },
    mountRow: (r: Gtk.Fixed) => {
      row = r
      container.append(r)
    },
    // The container hugs the row: the row's request IS the strip extent.
    setExtent: (r: number, g: number) => row?.set_size_request(r, g),
    // The container centres the row; there is no row-start offset to apply.
    setRowStart: () => {},
    // GTK pick delivers the pointer to the row and its children; a widget
    // substrate has no surface input region. Returning true means "handled —
    // deliberately not applicable" (the renderer then latches the geometry
    // spec instead of re-issuing it every frame).
    setInputRegion: () => true,
    // The strip is not a bar over anyone else's desktop: only the discs and the
    // open panels' pills capture. The row's pillHeight band above the icons and
    // the discs' square corners stay inert (the renderer enforces this capture
    // geometry in its router — see common/applets/utils/row-region.ts).
    captureBand: false,
    bounds: () => ({ w: container.get_width(), h: container.get_height() }),
    // The controllers live on the CONTAINER: the renderer wires the pointer
    // source before it mounts its row, and the container's allocation IS the
    // row's (one child, filling it), so events over the row or any of its
    // children — open panel pills included — arrive with the same
    // surface-local coordinates.
    connectPointer: (sink: AppletSurfacePointer) => {
      const motion = new Gtk.EventControllerMotion()
      motion.connect("enter", (_c: any, x: number, y: number) => sink.enter(x, y))
      motion.connect("motion", (_c: any, x: number, y: number) => sink.motion(x, y))
      motion.connect("leave", () => sink.leave())
      container.add_controller(motion)

      const click = new Gtk.GestureClick()
      click.connect("pressed", (_c: any, _n: number, x: number, y: number) => sink.press(x, y))
      container.add_controller(click)
    },
    // Nothing to commit: the renderer already repaints its own widgets.
    repaint: () => {},
  }
  return host
}
