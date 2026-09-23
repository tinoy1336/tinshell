/**
 * Clipboard history persistence — JSONL under ~/.local/share/clipboard.
 *
 *   history.jsonl  — one JSON entry per line, NEWEST FIRST (each write
 *                    rebuilds the file; entries are small, ≤ clipboard.
 *                    maxEntries ≤ a few KB — sync writes, notes store.ts
 *                    precedent).
 *   img/<id>.png   — saved PNG for image entries.
 *   thumbs/<id>.png — cached scaled PNG for image entries (see thumbs.ts).
 *   pinned.json    — JSON array of pinned entry ids.
 *
 * Entry shape: { id, ts, mime: "text"|"image", text?, imagePath?, hash? }.
 *   id = ts-based (Date.now().toString(36)) — also the image file name.
 *   hash = content hash of the payload (contentHash) — the identity key the
 *   duplicate rule matches on: accepting an entry whose content hash an
 *   existing row already carries MOVES that row to the front instead of
 *   adding a second copy (exact hash equality, no trimming, no whitespace
 *   normalisation).
 *
 * Failure policy: append() writes JSONL first and deletes a freshly-saved
 * orphan image when the JSONL write fails (JSONL is the source of truth; a
 * load-time GC pass also drops img files with no JSONL entry). A duplicate
 * that is dropped in favour of the existing row drops its own blob the same
 * way.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { bytesToUtf8 } from "@common/fs/bytes"
import { writeFileSync } from "@common/fs/files"
import { ignore } from "@common/log/logger"
import { get as getConfig } from "./config"
import { log } from "./log"

export interface ClipboardEntry {
  id: string
  ts: number
  mime: "text" | "image"
  text?: string
  imagePath?: string
  hash?: string
}

/**
 * Content hash of a capture's payload — text as captured, or an image's PNG
 * bytes. EXACT hashing only; every hash comparison in this app is exact
 * equality, never a normalised or fuzzy match.
 */
export function contentHash(data: string | Uint8Array): string {
  const c = GLib.Checksum.new(GLib.ChecksumType.MD5)
  c.update(data)
  return c.get_string()
}

/**
 * An entry's content hash, resolving a row that predates the field: a TEXT
 * entry's text is in the entry itself, so it hashes with no I/O. An IMAGE
 * entry carries the hash its capture computed — re-deriving one would re-read
 * its PNG on every lookup, so a hash-less image row resolves to null and takes
 * no part in the duplicate rule (it keeps its place in history).
 */
export function entryHash(e: ClipboardEntry): string | null {
  if (e.hash) return e.hash
  if (e.mime === "text" && typeof e.text === "string") return contentHash(e.text)
  return null
}

/**
 * Index in `entries` of the row carrying `hash`, or -1. The duplicate rule in
 * one place: EXACT hash equality over entryHash.
 */
export function findDuplicate(entries: ClipboardEntry[], hash: string): number {
  if (!hash) return -1
  return entries.findIndex((e) => entryHash(e) === hash)
}

/**
 * History order after accepting `entry`: an exact-hash duplicate of an
 * existing row moves THAT row to the front — same id, same imagePath, same
 * thumbnail, no second row — and anything else is prepended. Pure, so the
 * ordering contract the picker reads (the most recently accepted capture is
 * the first unpinned row) is exercisable without a store. `next[0]` is the
 * entry now at the front: `entry` itself when it was new.
 */
export function promotedOrder(entries: ClipboardEntry[], entry: ClipboardEntry): ClipboardEntry[] {
  const hash = entryHash(entry)
  const dup = hash ? findDuplicate(entries, hash) : -1
  if (dup < 0) return [entry, ...entries]
  return [entries[dup], ...entries.slice(0, dup), ...entries.slice(dup + 1)]
}

const DIR = GLib.build_filenamev([GLib.get_user_data_dir(), "clipboard"])
const HISTORY = GLib.build_filenamev([DIR, "history.jsonl"])
const IMG_DIR = GLib.build_filenamev([DIR, "img"])
const THUMB_DIR = GLib.build_filenamev([DIR, "thumbs"])
const PINNED_FILE = GLib.build_filenamev([DIR, "pinned.json"])

/** Absolute storage dir (~/.local/share/clipboard). */
export function storageDir(): string {
  return DIR
}

/**
 * Parse history.jsonl text → entries, newest first. A row is accepted on its
 * id + mime alone, so a line written before the `hash` field existed loads
 * unchanged (entryHash resolves that hash lazily); a truncated or hand-edited
 * line is skipped, never fatal.
 */
export function parseHistory(text: string): ClipboardEntry[] {
  const out: ClipboardEntry[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as ClipboardEntry
      if (e && typeof e.id === "string" && (e.mime === "text" || e.mime === "image")) out.push(e)
    } catch (e) {
      // A truncated/hand-edited JSONL line is skipped, not fatal.
      ignore("clipboard history line parse", e)
    }
  }
  return out
}

/** Read history.jsonl → entries, newest first. */
function readHistory(): ClipboardEntry[] {
  if (!GLib.file_test(HISTORY, GLib.FileTest.IS_REGULAR)) return []
  try {
    const [ok, contents] = GLib.file_get_contents(HISTORY)
    if (!ok || !contents) return []
    // SAFETY: GLib.file_get_contents returns a Uint8Array (or null when the
    // file is missing) — decoding bytes as UTF-8 is exactly what a text
    // JSONL log is.
    return parseHistory(bytesToUtf8(contents))
  } catch (e) {
    log(`readHistory failed: ${e}`)
    return []
  }
}

/** Rebuild history.jsonl from the in-memory list (sync, small file). */
function writeHistory(entries: ClipboardEntry[]): boolean {
  const lines = entries.map((e) => JSON.stringify(e)).join("\n")
  return writeFileSync(HISTORY, `${lines}\n`)
}

function readPinned(): Set<string> {
  if (!GLib.file_test(PINNED_FILE, GLib.FileTest.IS_REGULAR)) return new Set()
  try {
    const [ok, contents] = GLib.file_get_contents(PINNED_FILE)
    if (!ok || !contents) return new Set()
    // SAFETY: pinned.json is written by writePinned as a JSON array of
    // strings — the only writer of this file in the process.
    const arr = JSON.parse(bytesToUtf8(contents)) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === "string"))
  } catch {
    return new Set()
  }
}

function writePinned(pinned: Set<string>): void {
  writeFileSync(PINNED_FILE, JSON.stringify([...pinned]))
}

/** ts-based entry id (also the image file name). Uniqueness-guarded. */
export function newId(): string {
  const base = Date.now().toString(36)
  return `${base}-${Math.floor(Math.random() * 0xffff).toString(36)}`
}

/** Absolute path of an image entry's PNG. */
export function imagePath(id: string): string {
  return GLib.build_filenamev([IMG_DIR, `${id}.png`])
}

/** Absolute path of an image entry's cached thumbnail (built by thumbs.ts). */
export function thumbPath(id: string): string {
  return GLib.build_filenamev([THUMB_DIR, `${id}.png`])
}

/**
 * Payload size in bytes of one entry: a text entry's text as UTF-8, or an
 * image entry's PNG file size (0 when the blob is missing). The request
 * surface reports this as entry metadata, so a caller learns how big a payload
 * is without reading it.
 */
export function payloadSize(e: ClipboardEntry): number {
  if (e.mime === "text") return new TextEncoder().encode(e.text ?? "").length
  try {
    const info = Gio.File.new_for_path(imagePath(e.id)).query_info(
      "standard::size",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    return info.get_size()
  } catch {
    return 0
  }
}

/** Save an image entry's PNG bytes to disk. */
export function saveImage(id: string, bytes: Uint8Array): boolean {
  return writeFileSync(imagePath(id), bytes)
}

export function deleteImage(id: string): void {
  try {
    GLib.remove(imagePath(id))
  } catch (e) {
    // Already gone (or never written) — the orphan-image GC is idempotent.
    ignore("clipboard image delete", e)
  }
  deleteThumb(id)
}

/** Drop an entry's cached thumbnail (no-op when it was never built). */
function deleteThumb(id: string): void {
  try {
    GLib.remove(thumbPath(id))
  } catch (e) {
    ignore("clipboard thumbnail delete", e)
  }
}

/** What append() did: `ok` false only on a JSONL write failure; `deduped`
 *  true when the payload already existed and its row was moved to the front;
 *  `id` the entry now at the front (the surviving row on a duplicate). */
interface AppendResult {
  ok: boolean
  deduped: boolean
  id: string
}

/**
 * Accept a capture entry, newest first. An entry whose content hash an
 * existing row already carries moves THAT row to the front instead of adding
 * a second copy: the surviving row keeps its id, imagePath and thumbnail, and
 * a duplicate image's own freshly-saved blob is dropped (one content, one
 * blob). Otherwise the entry is prepended.
 *
 * Enforces clipboard.maxEntries — trims the OLDEST UNPINNED entries beyond
 * the cap (pinned survive). On a JSONL write failure, `ok: false` so the
 * caller can delete an orphan image (JSONL is the source of truth).
 */
export function append(entry: ClipboardEntry): AppendResult {
  const next = promotedOrder(readHistory(), entry)
  const front = next[0]
  const deduped = front !== entry
  if (deduped && entry.mime === "image" && entry.id !== front.id) {
    // The duplicate's own PNG is redundant — the surviving row already owns the
    // content, its blob and its cached thumbnail. An id-equal pair is skipped:
    // the blob would be the rows' own.
    deleteImage(entry.id)
  }
  const entries = next
  const pinned = readPinned()
  const max = Math.max(1, getConfig<number>("maxEntries", 100))
  const kept: ClipboardEntry[] = []
  const unpinned: ClipboardEntry[] = []
  for (const e of entries) {
    if (pinned.has(e.id)) kept.push(e)
    else unpinned.push(e)
  }
  for (const e of unpinned) {
    if (kept.length < max) kept.push(e)
    else {
      // Trimmed — drop the image file too (JSONL is the source of truth;
      // a trimmed entry's PNG must not linger as an orphan).
      if (e.mime === "image" && e.id) deleteImage(e.id)
    }
  }
  const ok = writeHistory(kept)
  if (!ok) log(`append failed (entry ${entry.id} not persisted)`)
  return { ok, deduped, id: front.id }
}

/** All entries, newest first. */
export function all(): ClipboardEntry[] {
  return readHistory()
}

/** History without `id`, or null when the id was not in it — the caller can
 *  then leave the file alone instead of rewriting it. Pure. */
export function withoutEntry(entries: ClipboardEntry[], id: string): ClipboardEntry[] | null {
  const next = entries.filter((e) => e.id !== id)
  return next.length === entries.length ? null : next
}

/** Pinned ids without `id`, or null when it was not pinned (nothing to write). */
export function withoutPin(ids: Set<string>, id: string): Set<string> | null {
  if (!ids.has(id)) return null
  const next = new Set(ids)
  next.delete(id)
  return next
}

/**
 * Remove one entry: its history line goes, its blob and cached thumbnail are
 * unlinked (deleteImage — the same drop the maxEntries trim and clear() use),
 * and a pin on it is dropped with it, so no pinned id is left pointing at
 * nothing. An unknown id is a no-op: false, nothing written.
 */
export function remove(id: string): boolean {
  const next = withoutEntry(readHistory(), id)
  if (!next) return false
  writeHistory(next)
  deleteImage(id)
  const remaining = withoutPin(readPinned(), id)
  if (remaining) writePinned(remaining)
  return true
}

/** Delete every entry + image; pins are NOT reset. */
export function clear(): void {
  for (const e of readHistory()) deleteImage(e.id)
  writeHistory([])
}

/** Currently pinned entry ids. */
export function pinned(): Set<string> {
  return readPinned()
}

/** Toggle pin state; returns the NEW state (true = now pinned). */
export function togglePin(id: string): boolean {
  const set = readPinned()
  const now = !set.has(id)
  if (now) set.add(id)
  else set.delete(id)
  writePinned(set)
  return now
}

/** Load-time GC: drop img/ and thumbs/ files with no matching JSONL entry. */
export function gcImages(): number {
  const ids = new Set(readHistory().map((e) => e.id))
  return sweepOrphans(IMG_DIR, ids) + sweepOrphans(THUMB_DIR, ids)
}

/** Delete every `<id>.png` in `dir` whose id has no entry. A missing dir
 *  (no thumbnails built yet) is not an error. */
function sweepOrphans(dir: string, ids: Set<string>): number {
  try {
    const it = Gio.File.new_for_path(dir).enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    let removed = 0
    let info: Gio.FileInfo | null = it.next_file(null)
    while (info) {
      const name = info.get_name()
      if (name.endsWith(".png") && !ids.has(name.slice(0, -4))) {
        try {
          Gio.File.new_for_path(GLib.build_filenamev([dir, name])).delete(null)
          removed++
        } catch (e) {
          // Another writer removed it first; the count simply skips it.
          ignore("clipboard orphan file delete", e)
        }
      }
      info = it.next_file(null)
    }
    return removed
  } catch {
    return 0
  }
}
