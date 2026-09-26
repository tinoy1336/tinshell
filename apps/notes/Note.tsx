/**
 * Note window — one floating note = one Gtk.Window (a normal XDG toplevel,
 * NOT layer-shell, so Hyprland's window rules / move / resize apply).
 *
 * Design (per notes/AGENTS.md):
 *  - Frameless frosted card (CSS on `window.note`; Hyprland rounds it via
 *    the `notes-float` window rule + global blur on the translucent surface).
 *  - The content is inset by a uniform padding ring (`.note-pad` box).
 *  - Auto-save: buffer changes → debounced async write to the note's file
 *    (serialized chain); window close / app shutdown flush synchronously.
 *  - Ctrl+S = save: silently rewrite the file named by Ctrl+Shift+S — inert
 *    until a save-as names one, and never the autosave file.
 *  - Ctrl+Shift+S = save as: promptd input dialog for the target path, then a
 *    desktop notification; the named path becomes this note's Ctrl+S target
 *    (persisted per note path in the state store). No in-window UI beyond
 *    the text itself.
 *  - Ctrl+Shift+T = reopen the most recently closed note (the persisted
 *    closed-note stack in session.ts), at its recorded position + size.
 *    Mod+SHIFT+N pops the same stack (notes.ts reopenOrBlankNote); Mod+N opens
 *    a fresh empty note instead (notes.ts openFreshNote).
 *  - Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) = this app's own edit history
 *    (history.ts over history-store.ts): GTK's per-buffer stack is disabled so
 *    there is exactly ONE stack, and the chain is read back from the state dir
 *    when the window is created, so undo and redo reach edits made before the
 *    note was closed.
 */

import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import { b64encode } from "@common/fs/bytes"
import { log } from "@common/log/logger"
import { run } from "@common/subprocess/run"
import { setAppId } from "@common/window/app-id"
import app from "ags/gtk4/app"
import { get as getConfig } from "./config"
import { type History, record, redo as redoStep, undo as undoStep } from "./history"
import { currentOwner, loadForNote, reconcile, saveForNote } from "./history-store"
import { NOTES_APP_ID } from "./identity"
import { namedTargetFor, reopenLastClosed, setNamedTarget } from "./session"
import {
  ensureDir,
  readNote,
  resolvePath,
  storageDir,
  writeNoteAsync,
  writeNoteSync,
} from "./store"

export interface Note {
  /** The Gtk window (present/destroy via this). */
  win: Gtk.Window
  /** File basename, e.g. note-20260807-133015.md. */
  name: string
  /** Absolute path of the auto-save file. */
  path: string
  /** Synchronous flush of pending edits + the edit history (close / shutdown).
   *  Inert once the window has been torn down. */
  flush: () => void
  /** Flush the last edits and mark the window torn — idempotent, and every
   *  close path runs it BEFORE the window is destroyed. After it nothing in this
   *  module writes the note's file again. */
  teardown: () => void
  /** True once teardown ran: this window must never be written to or
   *  re-presented again. */
  isTorn: () => boolean
  /** Persist the edit history alone (unmount, after a content flush). */
  persistHistory: () => void
  /** Debug summary of this note's edit chain (`notes history`). */
  historyInfo: () => HistoryInfo
  /** Focus the text view (new notes type immediately). */
  focusText: () => void
  /** Reveal a restoring window: remove the transparent gate (session restore
   *  maps windows content-invisible so the placement never flashes). */
  reveal: () => void
}

/** `notes history` row: what this window's chain currently holds. */
export interface HistoryInfo {
  path: string
  steps: number
  at: number
  folded: number
  readOnly: boolean
}

/** Monotonic milliseconds — the coalescing clock, immune to wall-clock jumps. */
function nowMs(): number {
  return Math.round(GLib.get_monotonic_time() / 1000)
}

export function createNote(
  name: string,
  contents: string,
  filePath?: string,
  opts?: { grabFocus?: boolean; restoring?: boolean },
): Note {
  const dir = storageDir()
  // filePath override: a note opened via a PATH (`open /path/to/x`) lives
  // THERE (auto-save + flush write to it), not in the storage dir. Without
  // it the note lives in the storage dir under `name`.
  const path = filePath ?? GLib.build_filenamev([dir, name])
  ensureDir(dir)
  const baseName = name.replace(/\.md$/, "")

  // ── Text buffer + view ──
  const buffer = new Gtk.TextBuffer()
  // EXACTLY ONE undo stack: this app's, in history.ts. GTK's own is per-widget,
  // cannot be serialised and dies with the window, so leaving it live would put
  // two disagreeing stacks behind the same Ctrl+Z — and with this off, a chord
  // that ever escaped the handler below is a no-op instead of a second, silent
  // undo.
  buffer.set_enable_undo(false)
  buffer.text = contents

  const textview = new Gtk.TextView({ hexpand: true, vexpand: true })
  textview.buffer = buffer
  textview.add_css_class("note-view")
  textview.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
  textview.set_editable(true)
  textview.set_cursor_visible(true)

  // ── Scrolled wrapper (thin scrollbar, dock-menu family) — MUST expand too
  // (hexpand/vexpand) or the text view collapses to its natural size and the
  // typed text is invisible (the buffer still receives it — autosave works —
  // but nothing draws). ──
  const scroll = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true })
  scroll.add_css_class("note-scroll")
  scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
  scroll.child = textview

  // ── Pad box: the padding ring that doubles as the drag grip. MUST expand
  // (hexpand/vexpand) or the text area hugs its natural size in a corner of
  // the window instead of filling it minus the padding. ──
  const pad = new Gtk.Box({ hexpand: true, vexpand: true })
  pad.add_css_class("note-pad")
  pad.append(scroll)

  // ── Window ──
  const win = new Gtk.Window({ title: baseName })
  win.add_css_class("note")
  win.child = pad
  win.set_titlebar(null) // frameless — no UI elements by design
  win.set_default_size(getConfig("window.width"), getConfig("window.height"))
  win.set_size_request(220, 160) // sane minimum against aggressive resizes
  setAppId(win, NOTES_APP_ID) // app id matched by the notes-float generated compositor rule
  app.add_window(win)

  // Focus the text view once the window maps — grab_focus before map is a
  // no-op, and without it the note opens with keyboard focus on the window
  // itself, so typing goes nowhere. This is what makes SUPER+N / SUPER+SHIFT+N
  // type-ready.
  // NOTE: map size is pinned by the hyprland notes-float rule
  // (`size`) — Hyprland 0.52+ sends its own half-monitor configure to fresh
  // floats whose first commit loses the race, and GTK4 obeys the nonzero
  // configure while having NO post-map resize API for XDG windows, so the
  // app cannot correct the size itself. See the generated notes-float rule's
  // `configMapSize` (apps/notes/hypr-rules.ts).
  // Session-restore passes grabFocus: false — N restored windows must not
  // fight over the keyboard focus.
  // Session-restore gate: map content-invisible so the window can be placed
  // at its saved geometry without the placement flashing on screen. Reveal is
  // driven by session.ts (reveal()) after the geometry is confirmed.
  if (opts?.restoring) win.add_css_class("restoring")

  if (opts?.grabFocus !== false) {
    win.connect("map", () => {
      textview.grab_focus()
    })
  }

  // No in-window drag grip by design: the padding is pure visual
  // breathing room and the text reuses the space. Moving notes uses the
  // generic Hyprland move (SUPER+LMB drag — hyprland.lua, works on every
  // window).

  // ── Note key chords ──
  // Ctrl+S = save the file named by Ctrl+Shift+S, Ctrl+Shift+S = save as file,
  // Ctrl+Shift+T = reopen the most recently closed note. Both controllers
  // share this one handler; `saveNamed` and `saveAs` are function declarations
  // further down, hoisted into this scope. A shifted chord arrives as its
  // SHIFTED keyval (Ctrl+Shift+S = KEY_S, Ctrl+Shift+T = KEY_T), so the mask
  // decides the branch and both keyval spellings are accepted.
  function onNoteKey(_c: unknown, keyval: number, _keycode: number, state: number): boolean {
    if (!(state & Gdk.ModifierType.CONTROL_MASK)) return false
    const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0
    if (keyval === Gdk.KEY_s || keyval === Gdk.KEY_S) {
      if (shift) void saveAs()
      else saveNamed()
      return true
    }
    if (shift && (keyval === Gdk.KEY_t || keyval === Gdk.KEY_T)) {
      reopenLastClosed()
      return true
    }
    // Undo / redo on GTK's own chords — Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z — driving
    // this app's chain (history.ts) instead of GTK's disabled stack. Consumed
    // here so the widget never sees them.
    if (keyval === Gdk.KEY_z || keyval === Gdk.KEY_Z) {
      if (shift) redoHistory()
      else undoHistory()
      return true
    }
    if (keyval === Gdk.KEY_y || keyval === Gdk.KEY_Y) {
      redoHistory()
      return true
    }
    return false
  }
  const keys = Gtk.EventControllerKey.new()
  keys.connect("key-pressed", onNoteKey)
  textview.add_controller(keys)
  // Backstop for when focus drifts off the text view (mirrors the launcher's window-level key handling).
  const winKeys = Gtk.EventControllerKey.new()
  winKeys.connect("key-pressed", onNoteKey)
  win.add_controller(winKeys)

  // ── Auto-save (debounced) + title from the first line ──
  const debounceMs = getConfig("timing.saveDebounceMs")
  let saveTimer: number | null = null

  // ── Edit history (Ctrl+Z / Ctrl+Y) ──
  // Loaded HERE, where the note's text becomes known, and reconciled with what
  // is on disk: a chain that disagrees with the file is re-anchored, never
  // replayed over it. `readOnly` means another LIVE instance owns this note's
  // chain — undo still works from it, but it is not written by this process.
  const loaded = loadForNote(path, contents, nowMs())
  let history: History = loaded.history
  const historyWritable = !loaded.readOnly
  let lastText = contents
  let lastCaret = 0
  // Set while this module applies its own undo/redo: a replay fires the same
  // "changed" signal the recorder listens to and must not be recorded as an
  // edit.
  let applying = false
  // Latched by teardown(): a torn window writes nothing and is never re-presented.
  let torn = false

  /** Insert-mark offset. Read through the mark: `get_property` needs a second
   *  argument in the typings, and the mark is the authoritative caret position. */
  function caretOffset(): number {
    return buffer.get_iter_at_mark(buffer.get_insert()).get_offset()
  }

  function firstLine(): string {
    const t = buffer.text
    const nl = t.indexOf("\n")
    return (nl === -1 ? t : t.slice(0, nl)).trim()
  }

  function updateTitle(): void {
    const t = firstLine()
    win.title = (t || baseName).slice(0, 48)
  }

  // Non-restarting throttle: the timer is set
  // ONCE and never restarted — a per-keystroke debounce never fires
  // during continuous typing (unbounded loss window). buffer.text is read at
  // fire time, so interim keystrokes are included; the next keystroke after a
  // fire re-arms the timer, guaranteeing a trailing write. Worst-case lag =
  // debounceMs (400ms). Focus-out below flushes pending edits earlier.
  buffer.connect("changed", () => {
    if (torn) return
    updateTitle()
    if (!applying) {
      const next = buffer.text
      const caret = caretOffset()
      history = record(history, lastText, next, lastCaret, caret, nowMs())
      lastText = next
      lastCaret = caret
    }
    if (saveTimer === null) {
      saveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, debounceMs, () => {
        saveTimer = null
        // Content first, then the chain that describes it.
        void writeNoteAsync(path, buffer.text).then(() => persistHistory())
        return GLib.SOURCE_REMOVE
      })
    }
  })

  /**
   * Write the chain, stamped with this process as its owner. Skipped when
   * another live instance owns the note's history (read-only).
   */
  function persistHistoryNow(): void {
    if (!historyWritable) return
    history = {
      ...history,
      cursor: caretOffset(),
      owner: currentOwner(),
      updated: Math.floor(Date.now() / 1000),
    }
    saveForNote(history)
  }

  /** Persist the chain unless this window has already been torn down. */
  function persistHistory(): void {
    if (torn) return
    persistHistoryNow()
  }

  /**
   * Focus-out: persist the chain and confirm it still describes the file. The
   * re-check is what stops this window from carrying on with a chain an outside
   * edit invalidated — a mismatch re-anchors, so undo can never revert that
   * edit.
   */
  function settleHistory(): void {
    if (torn) return
    persistHistory()
    history = reconcile(history, path, readNote(path))
  }

  /**
   * Apply a replay to the buffer. `applying` keeps the recorder out of it, while
   * the auto-save still runs: an undo is an edit like any other and must reach
   * the note file. The caret lands where the edit was made and is scrolled back
   * into view.
   */
  function applyReplay(text: string, cursor: number): void {
    applying = true
    try {
      buffer.text = text
      const offset = Math.max(0, Math.min(cursor, text.length))
      buffer.place_cursor(buffer.get_iter_at_offset(offset))
      textview.scroll_to_mark(buffer.get_insert(), 0, false, 0, 0)
      lastText = text
      lastCaret = offset
    } finally {
      applying = false
    }
  }

  function undoHistory(): void {
    if (torn) return
    const replay = undoStep(history, buffer.text)
    if (!replay) return
    history = replay.history
    applyReplay(replay.text, replay.cursor)
  }

  function redoHistory(): void {
    if (torn) return
    const replay = redoStep(history, buffer.text)
    if (!replay) return
    history = replay.history
    applyReplay(replay.text, replay.cursor)
  }

  /** The one flush: pending timer off, then content and chain to disk. */
  function flushNow(): void {
    if (saveTimer !== null) {
      GLib.source_remove(saveTimer)
      saveTimer = null
    }
    writeNoteSync(path, buffer.text)
    persistHistoryNow()
  }

  /** Flush unless this window has already been torn down. */
  function flush(): void {
    if (torn) return
    flushNow()
  }

  /**
   * Per-window teardown: flush the last edits, then latch `torn` so this window
   * can never write its file again. Idempotent, and every close path runs it
   * BEFORE the window is destroyed.
   *
   * WHY the close paths own this instead of the `destroy` signal: the JS ref
   * keeps the Gtk.Window alive past gtk_window_destroy (dispose never runs), so
   * the signal cannot be relied on — and a window destroyed by a path that left
   * its handle in the registry is a ZOMBIE: the next present() re-shows it, GTK
   * warns "shown after destroyed", and no close can remove it again.
   */
  function teardown(): void {
    if (torn) return
    torn = true
    flushNow()
  }

  // ── Ctrl+S = save the NAMED file ──
  // The save-as target, not the autosave file: read from the state store so a
  // note restored or reopened (Ctrl+Shift+T / Mod+SHIFT+N) still knows the file it
  // was last saved to. Null until Ctrl+Shift+S names one — before that the
  // chord is inert (it never writes the note's own autosave file).
  let namedPath = namedTargetFor(path)

  /** Ctrl+S: silently rewrite the named file — no dialog, no notification. */
  function saveNamed(): void {
    if (torn || !namedPath) return
    writeNoteSync(namedPath, buffer.text)
  }

  // Focus-out: flush pending (throttled) edits when the note loses active
  // focus — never lose more than the throttle interval on a crash — and settle
  // the edit history against the file (settleHistory).
  win.connect("notify::is-active", () => {
    if (torn || win.is_active) return
    if (saveTimer !== null) {
      GLib.source_remove(saveTimer)
      saveTimer = null
      void writeNoteAsync(path, buffer.text).then(() => settleHistory())
    } else {
      settleHistory()
    }
  })

  // ── Ctrl+Shift+S = save as file (promptd input → write → notify-send) ──
  // Also this note's Ctrl+S target from then on (saveNamed above).
  let saving = false // guards the textview + window key controllers (double-fire)
  async function saveAs(): Promise<void> {
    if (saving) return
    saving = true
    try {
      const base = firstLine() || baseName
      const slug =
        base
          .replace(/[^a-zA-Z0-9 _-]/g, "")
          .trim()
          .replace(/\s+/g, "-")
          .slice(0, 60) || "note"
      const defaultPath = `${resolveExportDir()}/${slug}.md`

      // The router (shell-first), NOT `ags -i promptd`: in production promptd
      // is hosted by the shell instance and no `promptd` bus name exists, so a
      // direct instance call answers `instance "promptd" is not runnning` and
      // save-as silently no-ops. `tinshell-route` probes the live instances
      // (route-map promptd=shell,promptd), reaches the same `input` dialog and
      // forwards its reply on stdout.
      const res = await run([
        GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin", "tinshell-route"]),
        "promptd",
        "input " +
          b64encode(
            JSON.stringify({
              mode: "text",
              title: "save note as file",
              body: "Write this note to a markdown file.",
              placeholder: defaultPath,
            }),
          ),
        // No timeoutMs ON PURPOSE: a modal prompt waits for the user — the answer
        // may take minutes, so the call has no deadline.
      ])
      const out = res.stdout.trim()
      if (!out || out.startsWith("error:")) return // cancelled or failed → silent
      // The prompt can outlive its window (an unload while the dialog is open):
      // a torn window must not export anything.
      if (torn) return

      const target = resolvePath(out)
      ensureDir(dirnameOf(target))
      await writeNoteAsync(target, buffer.text)
      // The exported file becomes this note's Ctrl+S target (the autosave file
      // stays the working file), persisted per note path so it survives a
      // reopen, a lazy unload and a restart.
      namedPath = target
      setNamedTarget(path, target)
      // Fire-and-forget: the note IS written, so a failed notification must not
      // become an unhandled rejection — name it in the app log and move on.
      run(["notify-send", "-a", "notes", "-i", "text-x-generic", "note saved", target]).catch(
        (e: Error) => log(`[notes] save notification failed: ${e.message}`),
      )
    } finally {
      saving = false
    }
  }

  // Initial persist: the note exists even before the first keystroke.
  writeNoteSync(path, contents)

  return {
    win,
    name,
    path,
    flush,
    teardown,
    isTorn: () => torn,
    persistHistory,
    historyInfo: () => ({
      path,
      steps: history.steps.length,
      at: history.at,
      folded: history.folded,
      readOnly: !historyWritable,
    }),
    focusText: () => textview.grab_focus(),
    reveal: () => win.remove_css_class("restoring"),
  }
}

// ── small helpers ──

function resolveExportDir(): string {
  return resolvePath(getConfig("export.defaultDir"))
}

function dirnameOf(p: string): string {
  return GLib.path_get_dirname(p)
}
