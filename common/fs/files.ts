/**
 * common/fs/files — shared file helpers for the gjs Gio/GLib idiom.
 *
 * One `ensureDir` (recursive creation) and the two write primitives every app
 * shares: `writeFileAsync` for the Gio callback idiom and `writeFileSync` for
 * the tiny close/shutdown-path files. Both replace a file's contents
 * atomically — GLib.file_set_contents writes a temp file and renames it — so
 * the contracts live in one place.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { log } from "@common/log/logger"

/** Expand a leading ~ to $HOME (the shared primitive — `expandPath`
 *  (@common/path/complete) is the absolute, canonicalized form). */
export { expandTilde as resolvePath } from "@common/path/complete"

/** Ensure a directory exists (recursive), created with `mode` (masked by the
 *  umask) when it is missing. Returns true when present/created. */
export function ensureDir(dir: string, mode = 0o755): boolean {
  try {
    const f = Gio.File.new_for_path(dir)
    if (f.query_exists(null)) return true
    GLib.mkdir_with_parents(dir, mode)
    return f.query_exists(null)
  } catch (e) {
    log(`ensureDir failed ${dir}: ${e}`)
    return false
  }
}

/** Replace a file's contents (async, Gio callback idiom). Resolves false on
 *  any write failure — callers decide how to surface it. Uses the GLib.Bytes
 *  variant: replace_contents_async does NOT copy the contents buffer and is
 *  unreliable for zero-length data; Bytes manages the lifetime and handles
 *  empty writes. */
export function writeFileAsync(path: string, data: string): Promise<boolean> {
  return new Promise((resolve) => {
    const file = Gio.File.new_for_path(path)
    const bytes = new GLib.Bytes(new TextEncoder().encode(data))
    file.replace_contents_bytes_async(
      bytes,
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null,
      (_f: any, res: any) => {
        try {
          file.replace_contents_finish(res)
          resolve(true)
        } catch (e) {
          // The boolean alone is easy to drop at a call site — a discarded
          // autosave promise would hide every failed note write; report it here.
          log(`write failed ${path}: ${e}`)
          resolve(false)
        }
      },
    )
  })
}

/** Replace a file's contents synchronously (tiny files: note close, clipboard
 *  history, shutdown paths), creating the parent directory with `dirMode`
 *  first. Returns false on any failure. Accepts text or raw bytes — the caller
 *  passes a Uint8Array for binary payloads. */
export function writeFileSync(
  path: string,
  contents: string | Uint8Array,
  dirMode = 0o755,
): boolean {
  try {
    if (!ensureDir(GLib.path_get_dirname(path), dirMode)) return false
    return GLib.file_set_contents(path, contents)
  } catch (e) {
    log(`write failed ${path}: ${e}`)
    return false
  }
}
