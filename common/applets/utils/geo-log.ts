/**
 * Geometry logger for the multi-edge dock feature.
 *
 * The whole feature hinges on exact numeric correctness at the "Layer B" seams
 * (window anchor/margins/size, icon widget margin, input region, drag axis).
 * These are the spots that break invisibly. Rather than eyeball
 * rendering, this emits the raw computed values to /tmp/tinshell-geo.log so a wrong
 * offset / wrong axis / wrong sign is immediately legible as a number.
 *
 * All calls are gated on DOCK_DEBUG — zero cost when off. Writes are SYNCHRONOUS
 * (a blocking append) because gjs write_async on append streams silently
 * swallows small writes. This is acceptable since the logger only runs when
 * DOCK_DEBUG is set — never on the production path.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ignore } from "@common/log/logger"

const GEO_LOG = "/tmp/tinshell-geo.log"
const ON = !!GLib.getenv("DOCK_DEBUG")

let stream: Gio.FileOutputStream | null = null

function getStream(): Gio.FileOutputStream | null {
  if (stream) return stream
  try {
    const file = Gio.File.new_for_path(GEO_LOG)
    try {
      stream = file.append_to(Gio.FileCreateFlags.NONE, null)
    } catch (e) {
      ignore("geo log append open", e)
      try {
        stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null)
      } catch (err) {
        ignore("geo log replace open", err)
        stream = null
      }
    }
  } catch (_) {
    stream = null
  }
  return stream
}

let seq = 0

/** Tagged geometry line: `[geo #seq tag] key=val key=val ...`. */
export function geo(
  tag: string,
  fields: Record<string, number | string | boolean | null | undefined>,
): void {
  if (!ON) return
  const parts = Object.entries(fields)
    .map(([k, v]) => `${k}=${v === undefined ? "-" : v}`)
    .join(" ")
  const s = getStream()
  if (!s) return
  try {
    const bytes = new TextEncoder().encode(`[geo #${seq++} ${tag}] ${parts}\n`)
    ;(s as any).write_bytes(bytes, null)
    ;(s as any).flush(null)
  } catch (e) {
    ignore("geo log write", e)
  }
}

/** Emit a run-start banner so each launch's geometry is easy to find in the
 *  (append-only) log. */
export function geoBanner(label: string): void {
  if (!ON) return
  seq = 0
  const s = getStream()
  if (!s) return
  try {
    const bytes = new TextEncoder().encode(`\n===== ${label} @ ${new Date().toISOString()} =====\n`)
    ;(s as any).write_bytes(bytes, null)
    ;(s as any).flush(null)
  } catch (e) {
    ignore("geo log banner write", e)
  }
}
