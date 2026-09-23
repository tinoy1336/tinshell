/**
 * Clipboard image thumbnails — the scaled copy the picker renders.
 *
 * The picker builds one row per entry, and decoding that entry's FULL PNG into
 * a Gdk.Texture costs ~47 ms for a 2880x1800 screenshot, paid again for every
 * image in the history on every open (~740 ms to show the picker with 35 image
 * entries, while hiding it costs ~20 ms). A cached scaled PNG moves that cost to
 * the capture that created the entry — one ~124 ms scale, once — and leaves each
 * open decoding ~6 KB per row instead of megabytes.
 *
 * A cached file is trusted by presence: the id it is named after is immutable
 * (ids are never reused, and store.ts drops the thumbnail with the entry).
 *
 * A row with no cached thumbnail — a legacy history entry, or an image whose
 * scale failed — renders an empty picture: the cache is filled on the capture
 * path for new entries and by `backfillThumbs()` at mount for the rest, and the
 * picker itself never falls back to the full PNG.
 */

import Gdk from "gi://Gdk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import { ensureDir } from "@common/fs/files"
import { ignore } from "@common/log/logger"
import { log } from "./log"
import { imagePath, thumbPath } from "./store"

/** Long-edge size of a cached thumbnail: ~2.5x the row's 36px display height,
 *  so it stays crisp on a hidpi output while its own decode stays ~1 ms. */
const THUMB_PX = 96

/** Ids whose build was already attempted in THIS process. A corrupt or
 *  truncated source image must not be retried on every row rebuild — each
 *  retry would schedule another fill and re-render, forever. */
const attempted = new Set<string>()

/** Whether a cached thumbnail exists for `id`. */
function hasThumb(id: string): boolean {
  return GLib.file_test(thumbPath(id), GLib.FileTest.IS_REGULAR)
}

/** Build the cached thumbnail for `id` if it is missing; true when a thumbnail
 *  exists afterwards. Sync by design — callers are the capture path (a one-off
 *  ~120 ms there is invisible) or the host's mount-time backfill. */
export function ensureThumb(id: string): boolean {
  const out = thumbPath(id)
  if (GLib.file_test(out, GLib.FileTest.IS_REGULAR)) return true
  if (attempted.has(id)) return false
  attempted.add(id)
  try {
    const src = imagePath(id)
    if (!GLib.file_test(src, GLib.FileTest.IS_REGULAR)) return false
    const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(src, THUMB_PX, THUMB_PX, true)
    const dir = GLib.path_get_dirname(out)
    if (!ensureDir(dir)) return false
    return pb.savev(out, "png", [], [])
  } catch (e) {
    log(`thumbnail build failed for ${id}: ${e}`)
    return false
  }
}

/** The cached thumbnail as a texture, or null when it has not been built yet
 *  (the caller renders a placeholder and schedules one fill). */
export function thumbTexture(id: string): Gdk.Texture | null {
  const path = thumbPath(id)
  if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR)) return null
  try {
    return Gdk.Texture.new_from_filename(path)
  } catch (e) {
    ignore("clipboard thumbnail texture load", e)
    return null
  }
}

/** Build the given ids' missing thumbnails in the background — one per idle
 *  tick, so a large legacy history never stalls the main loop for the whole
 *  batch — then report completion. Called once at mount by the host. */
export function backfillThumbs(ids: string[], onDone?: () => void): void {
  const missing = ids.filter((id) => !hasThumb(id))
  if (missing.length === 0) return
  let i = 0
  const step = (): boolean => {
    if (i >= missing.length) {
      onDone?.()
      return GLib.SOURCE_REMOVE
    }
    ensureThumb(missing[i++])
    return GLib.SOURCE_CONTINUE
  }
  GLib.idle_add(GLib.PRIORITY_LOW, step)
}
