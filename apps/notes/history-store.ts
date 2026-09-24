/**
 * history-store.ts — the file side of the per-note edit history.
 *
 * ONE history file per note, in the app's own state dir:
 *   ~/.local/state/tinshell/apps/notes/history-<pathKey>.json
 * The state dir is the app's durable home (state.json lives there too) and is
 * scanned by nothing else, unlike the note storage dir, where `pruneStorageDir`
 * deletes the oldest *.md by mtime beyond `storage.maxFiles` and `listNotes`
 * lists every match — a history file in there would be pruned and would show up
 * in `notes list`.
 *
 * This module never writes the note's own .md: it reads it only to confirm that
 * the chain still describes what is on disk (history.ts `hydrate` / `agrees`).
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { instanceName } from "@common/app/mode"
import { writeFileSync } from "@common/fs/files"
import { log } from "@common/log/logger"
import { appStateFilePath } from "@common/state"
import {
  agrees,
  emptyHistory,
  type History,
  hydrate,
  type Owner,
  ownerReadOnly,
  parseHistory,
  pathKey,
  reanchor,
  serialize,
} from "./history"

/** History files kept on disk; the oldest by mtime beyond this are deleted. */
export const HISTORY_FILE_MAX = 300

const FILE_PREFIX = "history-"

/** Absolute path of a note's history file. */
export function historyPathFor(notePath: string): string {
  return appStateFilePath("notes", `${FILE_PREFIX}${pathKey(notePath)}.json`)
}

/** This process's pid. gjs exposes no process.pid; /proc/self is the direct read. */
function selfPid(): number {
  try {
    return Number(GLib.file_read_link("/proc/self")) || -1
  } catch {
    return -1
  }
}

/** The instance+pid that own a history file written by this process. */
export function currentOwner(): Owner {
  return { instance: instanceName || "notes-island", pid: selfPid() }
}

function pidAlive(pid: number): boolean {
  return GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS)
}

export interface LoadedHistory {
  history: History
  status: "loaded" | "reanchored" | "none"
  /** Another LIVE process owns this note's chain: read it, never write it. */
  readOnly: boolean
}

function readFile(path: string): string | null {
  try {
    const [ok, contents] = GLib.file_get_contents(path)
    if (!ok || !contents) return null
    return new TextDecoder().decode(contents)
  } catch {
    // Missing or unreadable — "no history", never a thrown error into the mount.
    return null
  }
}

/**
 * Load the chain for `notePath` and reconcile it with `diskText`: an exact match
 * keeps the chain, any disagreement re-anchors it, so a chain can never replay
 * over an edit the app did not make. A missing, corrupt, truncated,
 * version-mismatched or foreign-path file reads as "no history".
 */
export function loadForNote(notePath: string, diskText: string, nowMs: number): LoadedHistory {
  pruneOncePerProcess()
  const owner = currentOwner()
  const none: LoadedHistory = {
    history: emptyHistory(notePath, diskText, 0, owner, nowMs),
    status: "none",
    readOnly: false,
  }
  const raw = readFile(historyPathFor(notePath))
  if (raw === null) return none
  const parsed = parseHistory(raw)
  if (!parsed) {
    log(`history: unusable history file for ${notePath}`)
    return none
  }
  const readOnly = ownerReadOnly(parsed.owner, owner, pidAlive)
  const { history, status } = hydrate(parsed, notePath, diskText, parsed.cursor, owner, nowMs)
  if (status === "reanchored") log(`history: external change for ${notePath} — history re-anchored`)
  return { history, status, readOnly }
}

/** Persist a chain. False when the write failed. */
export function saveForNote(h: History): boolean {
  if (!writeFileSync(historyPathFor(h.path), serialize(h))) {
    log(`history: write failed for ${h.path}`)
    return false
  }
  return true
}

/** Re-anchor `history` when the note file no longer matches the chain. */
export function reconcile(history: History, notePath: string, diskText: string): History {
  if (agrees(history, diskText)) return history
  log(`history: external change for ${notePath} — history re-anchored`)
  return reanchor(history, diskText)
}

// ── retention: one count cap, by file mtime ──
// The note file's own absence needs no rule here: a missing note reads as empty
// text, which disagrees with the chain and re-anchors it on open.

let pruned = false

function pruneOncePerProcess(): void {
  if (pruned) return
  pruned = true
  pruneHistoryFiles()
}

/** Delete the oldest history files beyond HISTORY_FILE_MAX. */
export function pruneHistoryFiles(): void {
  const dir = GLib.path_get_dirname(historyPathFor("/x"))
  try {
    const f = Gio.File.new_for_path(dir)
    // `time::modified` MUST be named in the query — a Gio.FileInfo carries only
    // the attributes the enumeration asked for, so an unrequested mtime reads 0
    // for every file and the oldest-first order would be arbitrary.
    const it = f.enumerate_children(
      "standard::name,standard::type,time::modified",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    const files: { path: string; mtime: number }[] = []
    let info: Gio.FileInfo | null
    while ((info = it.next_file(null))) {
      if (info.get_file_type() !== Gio.FileType.REGULAR) continue
      const name = info.get_name()
      if (!name.startsWith(FILE_PREFIX) || !name.endsWith(".json")) continue
      const mtime = info.get_attribute_uint64("time::modified")
      if (mtime <= 0) continue // unordered ⇒ never a prune victim
      files.push({ path: GLib.build_filenamev([dir, name]), mtime })
    }
    if (files.length <= HISTORY_FILE_MAX) return
    files.sort((a, b) => a.mtime - b.mtime)
    const victims = files.slice(0, files.length - HISTORY_FILE_MAX)
    for (const v of victims) {
      try {
        GLib.unlink(v.path)
      } catch (e) {
        log(`history: prune failed ${v.path}: ${e}`)
      }
    }
    log(`history: pruned ${victims.length} oldest history file(s)`)
  } catch (e) {
    log(`history: prune failed: ${e}`)
  }
}
