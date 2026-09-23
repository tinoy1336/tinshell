/**
 * picture-zoom — the GTK half of the zoom model: how a zoom reaches the
 * viewer's Gtk.Picture and the transport's ratio frame, and how many screen px
 * per widget px a surface draws. The arithmetic itself is ./zoom.
 *
 * A readout that claims "100% = one image pixel per screen pixel" needs TWO
 * things from the widget side, and the second one is not obvious:
 *
 *  - the box must be in SCREEN px. A size request is in GTK's LOGICAL px and
 *    is drawn at ×scale screen px, so the request is the zoom DIVIDED by the
 *    surface's scale (`deviceScale`) — on a 2880×1800@2 output one logical px
 *    is two screen px, and a request left in logical px draws a `100%`
 *    screenshot at 200%.
 *  - the box must be the box that is actually drawn. GtkScrolledWindow hands
 *    its child the whole VIEWPORT box (gtk_scrolled_window_allocate_child
 *    passes its own width/height), so a request smaller than the viewport is
 *    padded up to the viewport — and Gtk.ContentFit.FILL then stretches the
 *    picture onto that padded box, at the viewport's shape. Two things stop
 *    that: a non-FILL alignment, which clamps the allocation to the widget's
 *    own measured size, and binding the paintable through
 *    NullIntrinsicPaintable (common/media/paintable), so that measured size is
 *    the request and not the texture's own pixel size. The box keeps the
 *    image's ratio, so nothing is stretched.
 *
 * The fit state keeps CONTAIN on the picture's OWN texture: the texture's
 * intrinsic ratio is what makes CONTAIN letterbox, and there the viewport IS
 * the intended box.
 */
import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import { NullIntrinsicPaintable } from "@common/media/paintable"
import { zoomedExtent } from "./zoom"

/** How a viewer picture is pinned: the fit state (the viewport sizes it), or a
 *  numeric zoom's box, in the widget's own LOGICAL px. */
type PictureZoom = { kind: "fit" } | { kind: "scaled"; width: number; height: number }

/** Screen px per widget px on `w`'s surface: a size request is in LOGICAL px
 *  and is DRAWN at ×scale screen px, so every pixel-true size comes back
 *  through here. The surface's scale is the fractional one (1.5 on a
 *  fractional-scaled output); the widget's own factor is the next integer
 *  above it, hence the surface first. 1 while the window has no surface. */
export function deviceScale(w: Gtk.Widget): number {
  const scale = w.get_native()?.get_surface()?.get_scale() ?? 0
  return scale > 0 ? scale : Math.max(1, w.get_scale_factor())
}

/** The box a numeric zoom pins: image px × zoom, converted to the surface's
 *  logical px. */
export function boxedZoom(imgW: number, imgH: number, zoom: number, scale: number): PictureZoom {
  return {
    kind: "scaled",
    width: zoomedExtent(imgW, zoom, scale),
    height: zoomedExtent(imgH, zoom, scale),
  }
}

/** One wrapper per source paintable: re-wrapping would re-connect the source's
 *  invalidations (common/media/paintable). */
const wrapped = new WeakMap<Gdk.Paintable, InstanceType<typeof NullIntrinsicPaintable>>()

function nullIntrinsic(source: Gdk.Paintable): Gdk.Paintable {
  let wrapper = wrapped.get(source)
  if (!wrapper) {
    wrapper = new NullIntrinsicPaintable(source)
    wrapped.set(source, wrapper)
  }
  return wrapper
}

/** Pin `picture` (bound to `source`, null when there is nothing to show) to
 *  `zoom`: CONTAIN on the texture for fit, and an exactly-sized, centred box
 *  for a numeric zoom. */
export function applyPictureZoom(
  picture: Gtk.Picture,
  source: Gdk.Paintable | null,
  zoom: PictureZoom,
): void {
  if (zoom.kind === "fit") {
    picture.paintable = source
    picture.set_hexpand(true)
    picture.set_vexpand(true)
    picture.halign = Gtk.Align.FILL
    picture.valign = Gtk.Align.FILL
    picture.set_size_request(-1, -1)
    picture.set_content_fit(Gtk.ContentFit.CONTAIN)
    return
  }
  // The box carries the image's ratio, so the bound paintable must not bring
  // an intrinsic size of its own: that size measures larger than the request,
  // and the alignment clamp below would fall back to the viewport box.
  picture.paintable = source ? nullIntrinsic(source) : null
  picture.set_hexpand(false)
  picture.set_vexpand(false)
  picture.halign = Gtk.Align.CENTER
  picture.valign = Gtk.Align.CENTER
  picture.set_size_request(zoom.width, zoom.height)
  picture.set_content_fit(Gtk.ContentFit.FILL)
}

/** The transport's side of the same model: the ratio frame owns the box and
 *  lets its child fill it (the frame's ratio keeps the video proportional), so
 *  it needs the same exact box and the same centred alignment — the child
 *  picture inside reports no intrinsic size, which is what lets the clamp land
 *  on the request. */
export function applyFrameZoom(frame: Gtk.AspectFrame, zoom: PictureZoom): void {
  if (zoom.kind === "fit") {
    frame.set_hexpand(true)
    frame.set_vexpand(true)
    frame.halign = Gtk.Align.FILL
    frame.valign = Gtk.Align.FILL
    frame.set_size_request(-1, -1)
    return
  }
  frame.set_hexpand(false)
  frame.set_vexpand(false)
  frame.halign = Gtk.Align.CENTER
  frame.valign = Gtk.Align.CENTER
  frame.set_size_request(zoom.width, zoom.height)
}
