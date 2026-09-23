/**
 * dock/screengrab/naming.ts — capture file naming.
 *
 * The naming setting is a strftime template (e.g. "capture-%Y%m%d-%H%M%S").
 * Rendered via GLib.DateTime.format. The overwrite rule falls out naturally:
 * a template with NO strftime tokens produces a constant filename, so each
 * capture overwrites the previous (the user's spec). With tokens, an existing
 * file gets a "-1", "-2", … counter suffix (same-second captures never
 * clobber each other).
 */

import GLib from "gi://GLib"
import { expandPath } from "./capture"

const TOKEN_RE = /%[a-zA-Z]/

/** Full path for the next capture. `ext` is the format extension (png/jpg/mp4/
 *  webm) appended when the rendered name doesn't already carry it. */
export function renderCapturePath(dir: string, template: string, ext: string): string {
  const base = expandPath(dir)
  const dt = GLib.DateTime.new_now_local()
  const stem = (dt.format(template) ?? template).trim() || "capture"
  const hasTokens = TOKEN_RE.test(template)

  if (!hasTokens) {
    // Fixed filename → every capture overwrites the previous one.
    return `${base}/${stem}${stem.toLowerCase().endsWith(`.${ext}`) ? "" : `.${ext}`}`
  }

  const name = (n: number) => (n === 0 ? `${stem}.${ext}` : `${stem}-${n}.${ext}`)
  let file = `${base}/${name(0)}`
  let i = 1
  while (GLib.file_test(file, GLib.FileTest.EXISTS)) {
    file = `${base}/${name(i)}`
    i++
  }
  return file
}
