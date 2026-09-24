/**
 * notes registry — the set of open note windows + the app lifecycle wiring.
 *
 * The app is on-demand: it quits when the last note window closes (there is
 * no systemd unit — a desktop app that exits with its windows). Every note
 * flushes synchronously on close; `<instance> quit` flushes through the
 * teardown of that instance's quit path (unmountNotes).
 *
 * EVERY close path funnels through `closeWindow` — teardown (flush) → registry
 * drop → destroy — and `unmountNotes` leaves no window handle behind, so a note
 * that was unloaded can never be re-presented or written to again.
 */
import GLib from "gi://GLib"
import { scheduleUnload } from "@common/app/lazy"
import { isShell } from "@common/app/mode"
import { ignore, log } from "@common/log/logger"
import app from "ags/gtk4/app"
import { pruneHistoryFiles } from "./history-store"
import { createNote, type Note } from "./Note"
import {
  recordClosed,
  reopenLastClosed,
  resetSession,
  flush as sessionFlush,
  setOpener,
  setReopener,
  track,
  untrack,
} from "./session"
import { listNotes, newNoteName, readNote, resolvePath, storageDir } from "./store"

const open: Note[] = []

/** The Mod+SHIFT+N action (SUPER+SHIFT+N → ensure-new.sh new → `notes new`, and
 *  the action the `!n` launcher bang's cold argv reaches): pop the most recent
 *  entry off the persistent closed-note history — the SAME stack Ctrl+Shift+T
 *  uses, with the same geometry restore — and fall back to a fresh blank note
 *  when the history holds nothing restorable, so the action is never dead. */
export function reopenOrBlankNote(): void {
  cancelColdStartDefault()
  if (reopenLastClosed()) return
  openBlankNote()
}

/** The Mod+N action (SUPER+N → ensure-new.sh fresh → `notes fresh`): open a
 *  brand-new EMPTY note, focused. The closed-note history is never consulted,
 *  so Mod+N cannot resurrect a note the user closed. */
export function openFreshNote(): void {
  cancelColdStartDefault()
  openBlankNote()
}

/** Instance cold-start default (island app.ts main() with no argv, and the
 *  host registry's island-parity boot hook): one fresh empty note — DEFERRED,
 *  because a keybind press reaches a cold app in two steps. The router spawns
 *  the instance, waits until it answers requests, and only then forwards the
 *  press's own command, so a note opened here immediately would sit beside the
 *  forwarded one (one press, two windows). The first window-opening action
 *  cancels the pending default — that action IS the press (fresh for Mod+N,
 *  reopenOrBlankNote for Mod+SHIFT+N, openNoteByName for an explicit note) —
 *  and only a start nobody asks a window of (`tinshell-host start notes`,
 *  `tinshell-mode island notes`, `run.sh notes`) leaves it to fire. */
export function openNewNote(): void {
  if (coldStartResolved || coldStartTimer !== null) return
  coldStartTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COLD_START_GRACE_MS, () => {
    coldStartTimer = null
    log("notes: cold-start default → fresh blank note")
    openBlankNote()
    return GLib.SOURCE_REMOVE
  })
}

/** Grace on the cold-start default. A press that cold-started this process has
 *  its command forwarded within a few hundred ms of the instance answering
 *  requests (the router probes, then forwards); the default waits that window
 *  out, so it can never add a second note to the press's own window. */
const COLD_START_GRACE_MS = 1500

let coldStartTimer: number | null = null
/** True once a window-opening action (a request, or a bootstrap argv) has run
 *  in this process: the cold-start default is resolved and is not armed, which
 *  also covers a request landing BEFORE app.ts main()/the boot hook reached
 *  openNewNote(). */
let coldStartResolved = false

/** Resolve the cold-start default — every window-opening action does. */
function cancelColdStartDefault(): void {
  coldStartResolved = true
  if (coldStartTimer === null) return
  GLib.source_remove(coldStartTimer)
  coldStartTimer = null
  log("notes: cold-start default cancelled by a window-opening action")
}

/** Open a brand-new empty note window, focused. */
function openBlankNote(): void {
  const name = newNoteName()
  const note = createNote(name, "")
  register(note)
  note.win.present()
  note.focusText()
}

/**
 * Open a note by file name (within the storage dir) or by path. Missing
 * notes are CREATED (create-or-open — the `!n` launcher bang opens any
 * name). Already-open notes are focused instead of duplicated.
 */
export function openNoteByName(nameOrPath: string): { ok: boolean; error?: string } {
  const path = resolveNotePath(nameOrPath)
  if (!path) return { ok: false, error: "empty note name" }
  cancelColdStartDefault()

  const existing = open.find((n) => n.path === path && !n.isTorn())
  if (existing) {
    existing.win.present()
    return { ok: true }
  }

  const name = GLib.path_get_basename(path)
  // Pass the resolved path through — a path-based note saves THERE, not in
  // the storage dir (createNote's filePath override).
  const note = createNote(name, readNote(path), path) // readNote → "" when missing → creates
  register(note)
  note.win.present()
  note.focusText()
  return { ok: true }
}

/** Resolve a CLI name-or-path to an absolute note path (bare names live in
 *  the storage dir). Null when empty. Shared by open + close. */
function resolveNotePath(nameOrPath: string): string | null {
  let path = nameOrPath.trim()
  if (!path) return null
  if (!path.includes("/")) {
    if (!path.endsWith(".md")) path += ".md"
    path = GLib.build_filenamev([storageDir(), path])
  }
  return resolvePath(path)
}

/** Close an OPEN note by file name (within the storage dir) or by path —
 *  the app-internal close path (close-request → flush → registry drop).
 *  Missing/not-open notes error; the FILE is never deleted (auto-save keeps
 *  it on disk). */
export function closeNote(nameOrPath: string): { ok: boolean; error?: string } {
  const path = resolveNotePath(nameOrPath)
  if (!path) return { ok: false, error: "empty note name" }
  const existing = open.find((n) => n.path === path && !n.isTorn())
  if (!existing) return { ok: false, error: "not open: " + nameOrPath }
  closeWindow(existing, "user")
  return { ok: true }
}

/** All note file names in the storage dir (for `request list`). */
export function noteNames(): string[] {
  return listNotes(storageDir())
}

/** Edit-history state of every open note (for `request history`). */
export function historyDump(): string {
  if (open.length === 0) return "no open notes"
  return JSON.stringify(open.map((n) => n.historyInfo()))
}

/** Sync-flush every open note (close / `ags quit`). */
export function flushAll(): void {
  for (const n of open) n.flush()
}

// ── internals ──

/**
 * Drop one note from the registry, sampling its FINAL geometry for the session
 * entry. Idempotent: a note that is no longer registered is not sampled a second
 * time (the sample is a synchronous hyprctl call). USER-CLOSE semantics — it also
 * drops the session entry, so the note is not resurrected on the next start.
 */
function forget(note: Note) {
  const i = open.indexOf(note)
  if (i < 0) return undefined
  open.splice(i, 1)
  const geometry = sessionUntrack(note.path)
  // Last note closed → arm the shell's idle-grace unload (no-op in islands).
  if (open.length === 0) scheduleUnload("notes")
  return geometry
}

/**
 * Registry drop WITHOUT touching the session mirror: a graceful stop must leave
 * the open-window set stale, because that is exactly what the next shell start
 * restores (see the session-restore section of AGENTS.md).
 */
function unregister(note: Note): void {
  const i = open.indexOf(note)
  if (i >= 0) open.splice(i, 1)
}

/**
 * The ONE close path for a note window, and the only thing that destroys one:
 * teardown (flush, while the buffer still exists) → registry drop → destroy.
 * Idempotent through the note's own teardown latch, so the destroy backstop and
 * a racing request can neither flush nor untrack twice.
 *
 * `mode` is "user" for a real close (close-request, the `close` request): it also
 * drops the session entry and records the Ctrl+Shift+T / Mod+SHIFT+N history
 * entry. `mode` is "unmount" for the shell's lazy unload: the window handle goes,
 * the session entry STAYS (that is what brings the notes back on the next start),
 * and nothing is pushed onto the closed-note stack.
 */
function closeWindow(note: Note, mode: "user" | "unmount"): void {
  if (note.isTorn()) return
  note.teardown()
  // The session entry is dropped — and the geometry sampled — BEFORE the window
  // is destroyed; that one sample serves both the session drop and the history
  // entry. An unmount keeps the entry: it is what the next start restores.
  let geometry: ReturnType<typeof forget>
  if (mode === "user") {
    geometry = forget(note)
    recordClosed(note.path, geometry)
    // One prune per close keeps the history-file count bounded without a
    // directory sweep on any save path.
    pruneHistoryFiles()
  } else {
    unregister(note)
  }
  try {
    note.win.destroy()
  } catch (e) {
    ignore("notes window destroy", e)
  }
}

function register(note: Note): void {
  open.push(note)
  sessionTrack(note)

  // Every close path converges on closeWindow above: the `close` request, the
  // focused-note chord, Hyprland's close, and the shell unmount. The window's
  // `destroy` signal is a BACKSTOP ONLY and may never fire — the JS ref in `open`
  // keeps the Gtk.Window alive through gtk_window_destroy (dispose never runs),
  // so a window whose handle outlives its own destroy is a zombie that the next
  // present() re-shows. It must therefore never be the thing that cleans up.
  note.win.connect("close-request", () => {
    log(`notes: close-request ${note.path}`)
    closeWindow(note, "user")
    return true // the close is done here; never defer to the default handler
  })
  note.win.connect("destroy", () => {
    log(`notes: destroy fired ${note.path}`)
    forget(note)
  })
}

// Break the session ↔ notes import cycle: session.ts calls back into this
// module for silent re-opens during restore.
setOpener((path) => {
  openNoteSilent(path)
})

// Ctrl+Shift+T / Mod+SHIFT+N: the closed-note stack lives in session.ts (persisted
// in the state file); the window comes back through the canonical
// create-or-open path here, focused — a reopen is a user action, unlike a
// restore.
setReopener((path) => {
  openNoteByName(path)
  const note = open.find((n) => n.path === resolveNotePath(path) && !n.isTorn())
  note?.win.present()
  note?.focusText()
})

const sessionTrack = track
const sessionUntrack = untrack

/** Re-open a note WITHOUT focusing it (session restore). The window maps
 *  (present) but never grabs keyboard focus — N restored notes must not
 *  fight over the caret. */
function openNoteSilent(nameOrPath: string): void {
  const path = resolveNotePath(nameOrPath)
  if (!path) return
  const existing = open.find((n) => n.path === path && !n.isTorn())
  if (existing) return
  const name = GLib.path_get_basename(path)
  const note = createNote(name, readNote(path), path, { grabFocus: false, restoring: true })
  register(note)
  note.win.present()
}

/**
 * Shell unmount: tear down EVERY open note, then reset every piece of module
 * state that outlives a window. Each note flushes and drops its own registry
 * entry BEFORE its window is destroyed, so the last edits reach disk while the
 * buffer still exists — and no handle survives the unload, which is what keeps a
 * dead window from being re-presented (or writing its file) after a remount.
 * Idempotent.
 */
export function unmountNotes(): void {
  for (const note of [...open]) closeWindow(note, "unmount")
  open.length = 0 // belt: the unload leaves no window handle behind
  // Module scope survives a lazy unload (esbuild caches the module): stop a
  // pending cold-start default so it cannot open a window in an unloaded app,
  // and re-arm it for the next mount.
  if (coldStartTimer !== null) {
    GLib.source_remove(coldStartTimer)
    coldStartTimer = null
  }
  coldStartResolved = false
  sessionFlush()
  resetSession()
}

// Quit when the last window is gone — the app is on-demand by design. No
// idle linger (closed is closed; cold starts are fast — see AGENTS.md).
// In the shell (TINSHELL_SHELL=1) this is DISABLED:
// closing the last note must never kill the shared process.
if (!isShell) {
  app.connect("window-removed", () => {
    if (app.windows.length === 0) app.quit()
  })
}
