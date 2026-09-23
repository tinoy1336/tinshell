/**
 * common/media/paintable.ts — `NullIntrinsicPaintable`, the wrapper every
 * bound media paintable needs.
 *
 * Gtk.Picture measures its NATURAL size from the paintable's intrinsic size
 * even with can-shrink=true (can-shrink only zeroes the minimum — see
 * gtk_picture_measure in GTK4), so a video or album-art paintable bound
 * straight onto a picture makes the toplevel resize itself after map. This
 * wrapper forwards snapshots and both invalidations but reports no intrinsic
 * size, so the picture never drives the window's natural size. STATIC_SIZE is
 * cleared so the picture stays connected to invalidate-size.
 */
import Gdk from "gi://Gdk?version=4.0"
import GObject from "gi://GObject"

export const NullIntrinsicPaintable = GObject.registerClass(
  { GTypeName: "NullIntrinsicPaintable", Implements: [Gdk.Paintable] },
  class NullIntrinsicPaintable extends GObject.Object {
    source: Gdk.Paintable

    constructor(source: Gdk.Paintable) {
      super()
      this.source = source
      source.connect("invalidate-contents", () => this.emit("invalidate-contents"))
      source.connect("invalidate-size", () => this.emit("invalidate-size"))
    }

    vfunc_get_flags(): Gdk.PaintableFlags {
      return this.source.get_flags() & ~Gdk.PaintableFlags.STATIC_SIZE
    }
    vfunc_snapshot(snapshot: Gdk.Snapshot, width: number, height: number): void {
      this.source.snapshot(snapshot, width, height)
    }
    vfunc_get_intrinsic_width(): number {
      return 0
    }
    vfunc_get_intrinsic_height(): number {
      return 0
    }
    vfunc_get_intrinsic_aspect_ratio(): number {
      return 0
    }
  },
)
