/**
 * Note file storage — the app-side persistence layer.
 *
 * Notes are plain markdown files, one per window, under the configurable
 * storage dir (default ~/.local/share/notes). Auto-saves use a SERIALIZED
 * async write chain (a slow write must never interleave with a later one);
 * close/shutdown flushes go through the synchronous path (files are small).
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { bytesToUtf8 } from "@common/fs/bytes"
import { resolvePath, writeFileAsync, writeFileSync } from "@common/fs/files"
import { log } from "@common/log/logger"
import { get as getConfig } from "./config"

// Re-exports: notes/Note.tsx (and other app files) import these via ./store.
export { ensureDir, resolvePath } from "@common/fs/files"

/** Absolute storage dir (config `storage.dir` expanded). */
export function storageDir(): string {
  return resolvePath(getConfig("storage.dir"))
}

// Serialized write chain — rapid debounced saves must never interleave.
let writeChain: Promise<boolean> = Promise.resolve(true)
export function writeNoteAsync(path: string, contents: string): Promise<boolean> {
  // Empty contents bypass the chain: a zero-length write once never settled,
  // and one never-settling write blocks EVERY note's autosave forever (the
  // chain is module-global). The sync path is safe for empty data.
  if (contents === "") {
    writeNoteSync(path, "")
    pruneStorageDir()
    return Promise.resolve(true)
  }
  const p = writeChain.then(() => writeFileAsync(path, contents))
  // The chain arm must stay non-rejecting (one failed write would otherwise
  // stall every later autosave); the failure is logged so a lost save is
  // observable. Callers still receive `p` and can surface it themselves.
  writeChain = p.then(
    () => {
      pruneStorageDir()
      return true
    },
    (e) => {
      log(`note write failed ${path}: ${e}`)
      return true
    },
  )
  return p
}

/** Synchronous write — window close / app shutdown (tiny files, few ms). */
export function writeNoteSync(path: string, contents: string): boolean {
  return writeFileSync(path, contents)
}

/** Read a note file; missing/unreadable → "". */
export function readNote(path: string): string {
  try {
    const [ok, contents] = GLib.file_get_contents(path)
    if (!ok || !contents) return ""
    return bytesToUtf8(contents)
  } catch {
    return ""
  }
}

/** Note file names (basenames, *.md) in `dir`, sorted. */
export function listNotes(dir: string): string[] {
  const out: string[] = []
  try {
    // Gio enumeration — GLib.dir_open is NOT exposed by this gjs (it's a C
    // macro); a dir_open call here threw and silently returned an empty list.
    const f = Gio.File.new_for_path(dir)
    const it = f.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    let info: Gio.FileInfo | null
    while ((info = it.next_file(null))) {
      const name = info.get_name()
      if (name.endsWith(".md")) out.push(name)
    }
  } catch (e) {
    log(`listNotes failed: ${e}`)
  }
  return out.sort()
}

/** Timestamped file name for a new note, e.g. note-20260807-133015.md. */
export function newNoteName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `note-${ts}.md`
}

/** Enforce `storage.maxFiles`: when the storage dir holds more *.md files
 *  than the cap, the OLDEST (by mtime) are deleted permanently. Runs after
 *  every successful write, so the just-written note (newest mtime) is never
 *  a prune victim. Only files inside the storage dir are touched — notes
 *  opened by explicit path elsewhere are never pruned. */
export function pruneStorageDir(): void {
  const max = Number(getConfig("storage.maxFiles"))
  if (!Number.isFinite(max) || max < 1) return
  const dir = storageDir()
  try {
    const f = Gio.File.new_for_path(dir)
    // `time::modified` MUST be named in the query: a Gio.FileInfo carries only
    // the attributes the enumeration asked for. `standard::time-modified` is
    // not an attribute, so it read 0 for EVERY file — the "oldest" sort was a
    // no-op and the cap deleted ARBITRARY notes (including the just-written
    // one).
    const it = f.enumerate_children(
      "standard::name,standard::type,time::modified",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    const files: { name: string; mtime: number }[] = []
    let info: Gio.FileInfo | null
    while ((info = it.next_file(null))) {
      if (info.get_file_type() !== Gio.FileType.REGULAR) continue
      const name = info.get_name()
      if (!name.endsWith(".md")) continue
      const mtime = info.get_attribute_uint64("time::modified")
      // Unreadable mtime = no ordering ⇒ never a prune CANDIDATE (an unordered
      // file sorting as "oldest" is what turned the cap into arbitrary data
      // loss). Files with a real mtime still enforce the cap.
      if (mtime <= 0) continue
      files.push({ name, mtime })
    }
    if (files.length <= max) return
    files.sort((a, b) => a.mtime - b.mtime)
    const victims = files.slice(0, files.length - max)
    for (const file of victims) {
      try {
        GLib.unlink(GLib.build_filenamev([dir, file.name]))
      } catch (e) {
        log(`prune failed ${file.name}: ${e}`)
      }
    }
    log(
      `storage cap ${max}: pruned ${victims.length} oldest note(s): ${victims.map((v) => v.name).join(", ")}`,
    )
  } catch (e) {
    log(`prune failed: ${e}`)
  }
}
