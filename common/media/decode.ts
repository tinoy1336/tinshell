/**
 * common/media/decode.ts — decode an image file into a texture (for display)
 * and, on demand, into a Cairo surface (for pixel work: annotation, export).
 *
 * `Gdk.Texture.new_from_filename` is the decoder: it is synchronous, is a
 * `Gdk.Paintable` the picture renders directly, honours every loader GdkPixbuf
 * ships, and throws when the file cannot be decoded — the caller owns the
 * error surface.
 */

import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Cairo from "cairo"
import type { StillImage } from "./types"

/** Decode `path` into a texture. Throws when the file cannot be decoded. */
export function loadStill(path: string): StillImage {
  const texture = Gdk.Texture.new_from_filename(path)
  let surface: Cairo.ImageSurface | null = null
  return {
    path,
    texture,
    width: texture.get_width(),
    height: texture.get_height(),
    surface(): Cairo.ImageSurface {
      if (!surface) surface = surfaceFromTexture(texture)
      return surface
    },
  }
}

/** Texture pixels → Cairo surface. The gjs cairo bindings expose no
 *  `createForData`/`getData`, so the texture is written to a temp PNG and read
 *  back through `createFromPNG` — the one path that yields a surface with
 *  pixels in it. `Gdk.Texture.download()` looks like the direct route but the
 *  gjs binding returns without throwing and never fills the destination
 *  buffer, which yields an empty surface (an export with no image in it) while
 *  the on-screen `Gtk.Picture` still looks correct, because the picture binds
 *  the texture and not the surface. */
function surfaceFromTexture(texture: Gdk.Texture): Cairo.ImageSurface {
  const tmp = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `tinshell-still-${GLib.get_monotonic_time()}.png`,
  ])
  try {
    texture.save_to_png(tmp)
    return Cairo.ImageSurface.createFromPNG(tmp)
  } finally {
    GLib.unlink(tmp)
  }
}
