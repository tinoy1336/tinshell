/**
 * common/fs/bytes — byte→string helpers for the gjs file-read idiom.
 *
 * Gio/GLib file reads return a Uint8Array; decoding it to a string needs the
 * `new TextDecoder().decode(...)` call. ONE helper for every caller (dock fs,
 * clipboard store, tablet, keymap, notes store, greeter state, emoji recency,
 * the config loader).
 */

import GLib from "gi://GLib"

/**
 * Decode a byte buffer (Uint8Array / ArrayBuffer / a gjs byte-array view) to a
 * UTF-8 string. Null/undefined inputs decode to "" (the same as passing an
 * empty view) — the callers guard reads that can legitimately come back empty.
 */
export function bytesToUtf8(bytes: ArrayBuffer | Uint8Array | null | undefined): string {
  if (!bytes) return ""
  return new TextDecoder().decode(bytes as Uint8Array)
}

/** Encode a string as base64 for promptd argv payloads (files/window.tsx,
 *  notes/Note.tsx). */
export function b64encode(s: string): string {
  return GLib.base64_encode(new TextEncoder().encode(s))
}
