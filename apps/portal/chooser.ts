/**
 * portal chooser — maps xdg-desktop-portal FileChooser options (a{sv}) to
 * the custom TINSHELL chooser window (window.tsx).
 *
 * This module owns option parsing; the widget construction, URI collection,
 * and the response emission live in the window (window.tsx). dbus.ts sets
 * the returned handle's onResponse callback — the D-Bus method reply is
 * DEFERRED until that callback fires, exactly once, when the user finishes.
 *
 * Options handled (v1): accept_label, modal, multiple, directory, filters
 * a(sa(us)), current_filter (sa(us)), current_folder ay, current_name
 * (save), current_file ay (save), files aay (save-many). choices a(ssa(ss)s)
 * is NOT rendered in v1.
 */

import GLib from "gi://GLib"
import type { ChooserHandle, ChooserKind, ChooserOptions } from "./window"
import { createChooserWindow } from "./window"

export type { ChooserHandle, ChooserKind, ChooserOptions } from "./window"

/** Decode a variant byte-array (ay/aay element) to a NUL-stripped string. */
function bytesToUtf8(v: unknown): string {
  if (!v) return ""
  const u8 = v instanceof Uint8Array ? v : Uint8Array.from(v as number[])
  return new TextDecoder("utf-8").decode(u8).replace(/\0+$/, "")
}

/** Parse the options a{sv} from a FileChooser method call. The values arrive
 *  still wrapped in their `v` variant and are unwrapped below. */
export function parseOptions(kind: ChooserKind, options: Record<string, unknown>): ChooserOptions {
  // The D-Bus layer's deep_unpack() unwraps the a{sv} container but leaves
  // each `v` value wrapped, so without this every option arrives as a
  // GLib.Variant and the typeof checks below silently reject it — the dialog
  // then loses the suggested name, the starting folder, the active filter and
  // the directory/multiple/modal flags, all without an error. Unwrap that
  // layer with deep_unpack again (not unpack) so `ay` byte arrays arrive as a
  // Uint8Array.
  const o: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(options)) {
    o[k] = v instanceof GLib.Variant ? v.deep_unpack() : v
  }
  const asString = (k: string): string | undefined => {
    const v = o[k]
    return typeof v === "string" ? v : undefined
  }
  const asBool = (k: string): boolean | undefined => {
    const v = o[k]
    return typeof v === "boolean" ? v : undefined
  }
  const opts: ChooserOptions = {
    title: asString("title") ?? "",
    acceptLabel: asString("accept_label"),
    modal: asBool("modal"),
    multiple: asBool("multiple"),
    directory: asBool("directory"),
    filters: Array.isArray(o.filters) ? (o.filters as [string, [number, string][]][]) : [],
    activeFilter: Array.isArray(o.current_filter)
      ? (o.current_filter as [string, [number, string][]])
      : null,
    currentFolder: bytesToUtf8(o.current_folder),
    currentName: asString("current_name"),
    currentFile: bytesToUtf8(o.current_file),
  }
  if (kind === "save-many" && Array.isArray(o.files)) {
    opts.inputFiles = (o.files as unknown[]).map(bytesToUtf8).filter((n) => n.length > 0)
  }
  return opts
}

/** Build the custom chooser window for one request. dbus.ts owns the
 *  response callback (handle.onResponse) + the deferred D-Bus reply. */
export function openChooser(kind: ChooserKind, opts: ChooserOptions): ChooserHandle {
  return createChooserWindow(kind, opts)
}
