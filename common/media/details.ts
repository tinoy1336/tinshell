/**
 * common/media/details.ts — the fact set the preview pane shows beneath its
 * preview, one row set per media kind.
 *
 * PURE and GTK-free: a path and a kind in, label/value rows out. The pane stays
 * presentational and the row selection can be reasoned about — and probed — on
 * its own.
 *
 * Never throws. A failed or unreadable `query_info` yields the rows that ARE
 * known from the kind alone, because the chooser calls this from its own poll
 * and an exception there would take the dialog down with it.
 *
 * NO PIPELINE, so no duration and no codec for audio and video: reading either
 * costs a GStreamer probe per selection, which the pane's surface-only contract
 * forbids. The media app owns the pipeline and reports those facts on open.
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import type { MediaKind } from "./types"

export interface DetailRow {
  label: string
  value: string
}

const QUERY = "standard::size,time::modified,standard::content-type"

/** Binary units, one decimal below ten so a value never reads as a rounded lie.
 *  Separate from the browser's own byte formatter, which pads for a column. */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  if (n < 1024) return `${n} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function formatModified(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const dt = GLib.DateTime.new_from_unix_local(Math.floor(seconds))
  return dt ? dt.format("%e %b %Y %H:%M") : null
}

/** Rows for one item. `still` is supplied only when the pane decoded the file,
 *  which is the one case where the pixel size is known without a pipeline. */
export function fileDetails(
  path: string,
  kind: MediaKind,
  still?: { width: number; height: number } | null,
): DetailRow[] {
  const rows: DetailRow[] = []

  if (still && still.width > 0 && still.height > 0) {
    rows.push({ label: "dimensions", value: `${still.width} × ${still.height}` })
    const megapixels = (still.width * still.height) / 1_000_000
    if (megapixels >= 1) rows.push({ label: "megapixels", value: `${megapixels.toFixed(1)} MP` })
  }

  let info: Gio.FileInfo | null = null
  try {
    info = Gio.File.new_for_path(path).query_info(QUERY, Gio.FileQueryInfoFlags.NONE, null)
  } catch {
    // An unreadable item (permissions, a vanished path) still gets the rows the
    // kind alone can state, and the preview branch has already reported itself.
  }

  if (info) {
    const size = info.get_size()
    if (size > 0) rows.push({ label: "size", value: formatBytes(size) })
    const modified = formatModified(info.get_attribute_uint64("time::modified"))
    if (modified) rows.push({ label: "modified", value: modified })
    const type = info.get_content_type()
    if (type) rows.push({ label: "type", value: type })
  }

  if (kind === "animated-image") {
    rows.push({ label: "note", value: "animated — first frame shown" })
  } else if (kind === "video" || kind === "audio") {
    rows.push({ label: "note", value: "opens in the media app" })
  }

  return rows
}
