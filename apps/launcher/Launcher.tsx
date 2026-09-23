/**
 * Launcher window — the Spotlight-style popup.
 *
 * Widget tree:
 *   window (layer-shell, namespace "launcher", keymode EXCLUSIVE, anchor NONE)
 *     └─ .main (vertical Box, frosted card, valign CENTER)
 *         ├─ .entry-row (icon + Gtk.Entry + the busy spinner on its right edge)
 *         └─ .matches (For-rendered rows)
 *              └─ the emoji section (category "emoji") is a vertical box:
 *                 ONE label (`Emoji: <term> - <n> matches`) + the glyph grid,
 *                 always visible — the matches ARE the content.
 *
 * Behaviour:
 *   - the Gtk.Entry owns keyboard focus; an EventControllerKey on the ENTRY
 *     (not the window) handles Return/Escape/arrows/Tab. Attaching to the
 *     focused widget is what makes the keys reliably arrive and lets the
 *     handler consume them (return true = stop propagation). A second key
 *     controller on the window is a persistent Escape backstop for when the
 *     entry loses focus mid-session.
 *   - card height animates toward its natural content size each frame
 *     (runFrames + easeCubicInOut), so results grow/clear smoothly rather than
 *     snapping. Hyprland does not animate layer-surface resizes itself.
 *   - the card is CENTRED, not top-aligned, inside the surface box: the
 *     surface is anchored NONE (Hyprland centres that box on the monitor) and
 *     a mapped layer surface does not reliably shrink (the compositor keeps
 *     the grown box while the content re-measures), so a top-aligned card
 *     would paint above the surface's centre as soon as the results shrink.
 *     valign CENTER keeps the painted card on the monitor centre through
 *     growth, shrink and the emoji row's in-place expansion.
 *   - click outside the card dismisses; click on a row activates it.
 *   - focus loss dismisses.
 *   - emoji results (emoji mode or a matching search query) render as the
 *     labelled glyph section: in emoji mode the section is the whole list
 *     (every other source is suppressed), in an ordinary search it sits last
 *     among the app rows. Arrows drive its grid once the section holds the
 *     list selection; Enter or a glyph click inserts the picked glyph into
 *     the window this launcher session captured. Shift+Enter / Shift+click
 *     APPEND the picked glyph to a commit buffer instead (previewed under the
 *     label, the card stays open, nothing is inserted yet); plain Enter / plain
 *     click then commits the whole buffer as ONE insertion after the card
 *     hides, so the paste can never land in the launcher's own entry. Escape
 *     closes and discards the buffer.
 */

import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { easeCubicInOut, easeOutCubic } from "@common/anim/easings"
import { type FrameRunner, runFrames } from "@common/anim/run-frames"
import type { EmojiEntry } from "@common/emoji/data"
import type { TargetInfo } from "@common/emoji/insert-plan"
import { createSpinnerGlyph } from "@common/glyph/spinner"
import { ignore } from "@common/log/logger"
import { createPathAutofill } from "@common/path/autofill"
import { isPathShaped } from "@common/path/complete"
import { bindFocusLoss, bindOutsideClick } from "@common/window/popup-dismiss"
import { type Accessor, createEffect, createState, For } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { Combiner } from "./combiner"
import type { LauncherControl } from "./commands"
import { get } from "./config"
import {
  EMOJI_ROW_PITCH,
  emojiBeginPick,
  emojiCancelPick,
  emojiColumns,
  emojiGridHeight,
  emojiInsert,
  emojiRecord,
  emojiScrollTop,
  emojiVisibleRows,
} from "./emoji"
import { log } from "./log"
import {
  CAP_PX_DESC,
  CAP_PX_TITLE,
  capChars,
  DESC_LINES_ROW,
  descriptionLines,
  ROW_CHROME,
  textBudget,
} from "./row-caps"
import {
  clampOffset,
  glideStarts,
  glideStep,
  glideVelocity,
  linearOffset,
  offsetForSelection,
  offsetPixels,
  ROW_PITCH_FALLBACK_PX,
  SCROLL_CONTROLLER_FLAGS,
  type ScrollUnit,
  scrollDecision,
  selectionInView,
  stepSelection,
  viewportPixels,
  viewportRows,
} from "./scroll"
import { pathBangArgument, spliceBangToken } from "./sources/bang-token"
import { setEntryApply } from "./sources/bangs"
import type { Result } from "./types"

// NVIDIA logos for the prime-run button (48×48 png, ~1KB — shrunk from the
// icons8 512² source via ImageMagick resize + palette reduction). Grey at
// rest; the original green version swaps in on hover.
/** The tree root: the launcher exports TINSHELL_HOME; the dev default matches the
 *  checkout. These assets belong to the app and travel with the tree, so they are
 *  no longer read from ~/.config. */
const TREE_ROOT =
  GLib.getenv("TINSHELL_HOME") ?? GLib.build_filenamev([GLib.get_home_dir(), "dev", "tinshell"])
const PRIME_ICON = GLib.build_filenamev([TREE_ROOT, "apps", "launcher", "prime-run.png"])
const PRIME_ICON_GREEN = GLib.build_filenamev([
  TREE_ROOT,
  "apps",
  "launcher",
  "prime-run-green.png",
])

// Nerd Font glyphs.
const ICON_SEARCH = "\uf002" // magnifier
const ICON_PY = "\ue73c" // python logo (dev-python; U+F3E2 is unassigned in Nerd Fonts)

const { NONE } = Astal.WindowAnchor
const ANIM_MS = 180
/** One wheel notch's scroll animation — short, so a notch reads as a step that
 *  glides rather than a jump. */
const SCROLL_ANIM_MS = 120

// ── Card width + text caps ────────────────────────────────────────────────
// The arithmetic and the per-kind policy live in ./row-caps.ts (one pure
// module, measured by row-caps.probe.ts): the card's width budget, the
// per-character caps, and how many description lines a row of each kind may
// use. This file applies them to the labels.

// Emoji grid geometry. The grid's row spacing (style.css keeps the cell at 34px
// min-height + 4px padding), and the rows rendered BEYOND the visible ones: the
// cells outside the rendered window are spacers, so a broad query builds a
// viewport of cells per keystroke instead of one per match.
const EMOJI_GRID_ROW_GAP = 4
const EMOJI_MARGIN_ROWS = 1

/** The control surface, set while Launcher() builds its window; mount.ts hands
 *  it to the request dispatcher (null before Launcher() ran). */
let controlHandle: LauncherControl | null = null

export function launcherControl(): LauncherControl | null {
  return controlHandle
}

export default function Launcher() {
  let win: Astal.Window
  let entry: Gtk.Entry
  let main: Gtk.Box

  // Reactive state.
  const [results, setResults] = createState<Result[]>([])
  const [selected, setSelected] = createState(0)

  // Blind Tab-cycling path autofill for the path-taking bangs (!p, !code, !a —
  // an abbreviated token such as !co included, so the completion follows the
  // bang the entry will dispatch) and for a path-shaped query: type
  // "!a <path>", "!code <path>" or a path, press Tab to fill the next match
  // (dirs get a trailing "/"), Shift+Tab cycles back. Which bangs take a path
  // and how a token resolves to one live in sources/bang-token.ts; the cycling
  // itself is shared logic in common/path/autofill.
  const pathAutofill = createPathAutofill({
    extract: (t) => {
      const arg = pathBangArgument(t)
      if (arg !== null) return arg
      // A path query completes its own text — the path source opens the
      // directory the completion names.
      if (isPathShaped(t)) return t.trim()
      return null
    },
  })
  /** An async source (calc, !py, an async bang) is still in flight. */
  const [busy, setBusy] = createState(false)

  // The loading indicator: the SHARED spinner glyph (common/glyph/spinner —
  // the same primitive the dock menus and promptd spin) on the input field's
  // own right edge, alive while an async source resolves. The widget is
  // non-interactive by construction (the primitive sets can_target false), so
  // it never competes with the entry for pointer or key input.
  const busySpinner = createSpinnerGlyph({
    size: 16,
    emoji: "\udb81\udc50", // U+F0450 — the suite's menuSpinner glyph
    colour: [0.54, 0.71, 0.97, 1], // #8ab5f7 — the suite accent (entry icon/caret tone)
    fontFamily: "JetBrainsMono Nerd Font",
    easeBack: false, // transient: stop dead, no upright ease-back
  })

  const [entryIcon, setEntryIcon] = createState(ICON_SEARCH)

  // Height animation state.
  let currentH = 0
  let animRef: FrameRunner | null = null

  // Emoji mode: the grid the selected emoji row expands into (rebuilt with
  // each result batch, so it always describes the current entries) and the
  // target THIS launcher session captured for insertion — owned by the
  // session, never a module-level slot.
  let emojiGrid: {
    entries: EmojiEntry[]
    grid: Gtk.Grid | null
    /** Cells of the RENDERED window and the entry index each one shows. */
    buttons: Gtk.Button[]
    indices: number[]
    /** First rendered row; the rows above it are one spacer. */
    firstRow: number
    /** Rows currently rendered. */
    rows: number
    selected: number
  } | null = null
  /** The grid's scroll container and the row at the top of its viewport. */
  let emojiScroller: Gtk.ScrolledWindow | null = null
  let emojiScrollRow = 0
  /** True while the grid rebuilds its row window and re-sets the scroll value;
   *  the adjustment's value-changed signal is ignored then (the transient
   *  shrink during the rebuild would otherwise reset the tracked top row). */
  let emojiRendering = false
  let pickTarget: TargetInfo | null = null
  /** Commit buffer: the glyphs Shift+Enter / Shift+click accumulated, inserted
   *  as ONE paste by plain Enter / plain click. Nothing is injected while it
   *  fills; hide() clears it (Escape / click-outside / focus-loss discard). */
  let pendingGlyphs: string[] = []
  /** The buffer's preview line (syncPending) — null until the emoji section
   *  renders, re-created with every result batch, so never cached across. */
  let pendingRowRef: Gtk.Box | null = null
  let pendingLabelRef: Gtk.Label | null = null
  /** Previous selection observed by the height effect (avoids idle churn). */
  let lastSelected = -1
  /** The result list's SCROLL VIEWPORT and the row units it works in. The laws
   *  are `./scroll.ts`; this holds the widget state they act on: the scroller
   *  itself, the `.matches` box the rows are appended to (the pitch is measured
   *  off ITS first child — the scroller's own `get_child()` answers the
   *  `GtkViewport` GTK wraps a non-scrollable child in, whose first child is the
   *  whole row box), the measured pitch of one row, the row the viewport starts
   *  at, and whether the last selection move came from the wheel (which drives
   *  its own animation, so the rigid follow must not fight it). */
  let matchesScroll: Gtk.ScrolledWindow | null = null
  let matchesBox: Gtk.Box | null = null
  let rowPitchPx = ROW_PITCH_FALLBACK_PX
  let scrollOffset = 0
  let scrollAnim: FrameRunner | null = null
  let wheelDriven = false
  /** The glide's frame source, the row velocity it is still carrying after the
   *  trackpad gesture ended, and the frames it has run (the debug path's answer
   *  to "did the tail actually move?" — `./scroll.ts` glide laws). */
  let glide: FrameRunner | null = null
  let glideVelocityRows = 0
  let glideFrames = 0

  // Shift/Ctrl-held tracking. The Gtk.Entry 'activate' signal carries no
  // modifier state, so Shift+Enter / Ctrl+Enter arriving via onActivate (the
  // entry's default handler can beat the EventControllerKey path) needs
  // window-wide flags fed by the winKey controller's press/release events.
  let shiftHeld = false
  let ctrlHeld = false

  const combiner = new Combiner({
    onResults: (batch) => {
      const list = batch.results
      const prevSel = selected.peek()
      setResults(list)
      // Selection policy:
      //  - fresh query (incremental=false): auto-select the first row.
      //  - async merge (incremental=true): KEEP the current selection so a
      //    late calc row (higher priority, lands at index 0) doesn't steal
      //    focus from the app the user already had selected. Clamp to the
      //    new list length in case the list shrank.
      let nextSel = batch.incremental ? prevSel : 0
      if (nextSel >= list.length) nextSel = Math.max(0, list.length - 1)
      // Emoji mode: the emoji row (sorted last) is the mode's target, so it
      // opens already selected — i.e. expanded into the glyph grid.
      if (batch.emojiMode && list.length > 0 && list[list.length - 1].emojiEntries)
        nextSel = list.length - 1
      // Force recompute via a sentinel toggle (gnim skips no-op sets).
      setSelected(-1)
      setSelected(nextSel)
      applyViewport()
      animateToContent()
    },
    onBusy: (b) => setBusy(b),
  })

  // The in-field spinner follows the busy flag. Living inside .entry-row, it
  // changes no content height when it appears or disappears.
  createEffect(() => {
    const b = busy()
    busySpinner.widget.visible = b
    busySpinner.setSpinning(b)
  })

  // The emoji section's selection treatment and its grid's cell highlight
  // follow the LIST selection, and the card height changes with the result
  // count — re-measure on every selection change so nothing creeps.
  createEffect(() => {
    const s = selected()
    if (s === lastSelected) return
    lastSelected = s
    renderEmojiSelection()
    syncEmojiScroll()
    // The selection-follow: the viewport keeps the selected row visible. The
    // wheel's own branch already animated that move, so it is not re-run here.
    if (wheelDriven) wheelDriven = false
    else followSelection(false)
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      animateToContent()
      return GLib.SOURCE_REMOVE
    })
  })

  function hide() {
    win.visible = false
    win.remove_css_class("ctrl-held") // Ctrl-held prime-run affordance
    shiftHeld = false
    ctrlHeld = false
    combiner.cancel()
    stopGlide()
    // Any insertion this session still had scheduled is stale.
    emojiCancelPick()
    // The commit buffer dies with the card: Escape / click-outside /
    // focus-loss discard it (a commit clears it before calling hide()).
    pendingGlyphs = []
    syncPending()
    if (animRef) {
      animRef.cancel()
      animRef = null
    }
  }

  function show() {
    entry.set_text("")
    setSelected(0)
    setResults([])
    setBusy(false)
    setEntryIcon(ICON_SEARCH)
    shiftHeld = false
    ctrlHeld = false
    pendingGlyphs = []
    syncPending()
    combiner.setEmojiMode(false)
    // Capture the focused window for THIS session before the surface takes
    // focus (the pick owns the snapshot and hands it to the insertion on
    // activation). Fired un-awaited: the launcher is the hot-key surface and
    // the probe is one hyprctl round-trip, while the insertion itself is
    // scheduled after hide(). A pick that beats the probe degrades to
    // copy-only, never to a wrong target.
    pickTarget = null
    void emojiBeginPick().then((t) => {
      pickTarget = t
    })
    win.visible = true
    // re-apply the configured width (a config edit while hidden lands here)
    clampWidth()
    // size to just the entry first, then focus
    currentH = 0
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      entry.grab_focus_without_selecting()
      animateToContent()
      return GLib.SOURCE_REMOVE
    })
  }

  function toggle() {
    if (win.visible) hide()
    else show()
  }

  function moveSelection(delta: number) {
    const n = results.peek().length
    if (n === 0) return
    setSelected((cur) => (cur + delta + n) % n)
  }

  // ── emoji mode ──
  // The emoji row (category "emoji", sorted last) is a normal-height row until
  // it is the SELECTED one: then its widget expands in place into the glyph
  // grid and the arrows drive that grid instead of the result list. Enter /
  // a glyph click inserts the grid's selected glyph.

  /** Index of the emoji row in the current results, or -1 when absent. */
  function emojiRowIndex(): number {
    const list = results.peek()
    return list.length > 0 && list[list.length - 1].emojiEntries ? list.length - 1 : -1
  }

  /** Is the emoji row selected (i.e. is its glyph grid expanded)? */
  function emojiGridActive(): boolean {
    return emojiGrid !== null && selected.peek() === emojiRowIndex()
  }

  /** Paint the grid's selected cell — only while the emoji section holds the
   *  LIST selection (otherwise two blocks would look selected at once). */
  function renderEmojiSelection(): void {
    if (!emojiGrid) return
    const active = emojiGridActive()
    const grid = emojiGrid
    grid.buttons.forEach((btn, i) => {
      if (active && grid.indices[i] === grid.selected) btn.add_css_class("selected")
      else btn.remove_css_class("selected")
    })
  }

  function moveEmojiSelection(delta: number): void {
    if (!emojiGrid || emojiGrid.entries.length === 0) return
    const n = emojiGrid.entries.length
    emojiGrid.selected = (emojiGrid.selected + delta + n) % n
    renderEmojiSelection()
    syncEmojiScroll()
  }

  /** Scroll the grid so the SELECTED cell stays visible: the arrow move past a
   *  viewport edge scrolls exactly one row (the row maths is pure in ./emoji,
   *  so it is probed headlessly). A selection already in view does not move the
   *  grid, so scrolling feels like a list, not a jump. */
  function syncEmojiScroll(): void {
    if (!emojiScroller || !emojiGrid) return
    const top = emojiScrollTop(
      emojiGrid.selected,
      emojiGrid.entries.length,
      emojiColumns(),
      emojiVisibleRows(),
      emojiScrollRow,
    )
    setEmojiScrollRow(top)
  }

  /** Move the viewport to `topRow` (the row math is the caller's): re-render the
   *  rendered row window around it when the new viewport leaves it, then apply
   *  the scroll value. One entry point for the arrows and the wheel, so both
   *  scroll the same way. */
  function setEmojiScrollRow(topRow: number): void {
    if (!emojiScroller) {
      emojiScrollRow = topRow
      return
    }
    emojiRendering = true
    try {
      emojiScrollRow = topRow
      ensureEmojiWindow(topRow)
      emojiScroller.get_vadjustment().set_value(topRow * EMOJI_ROW_PITCH)
    } finally {
      emojiRendering = false
    }
  }

  /** Re-render the grid around the viewport only when the viewport left the
   *  rendered rows. */
  function ensureEmojiWindow(topRow: number): void {
    const state = emojiGrid
    if (!state) return
    if (topRow >= state.firstRow && topRow + emojiVisibleRows() <= state.firstRow + state.rows)
      return
    renderEmojiWindow(topRow)
  }

  /** Wheel step over the card: move the VIEWPORT one row (clamped by the
   *  visible-rows cap). The wheel scrolls the grid; the selection stays where
   *  the keyboard put it, and the next arrow move scrolls it back into view. */
  function scrollEmojiGrid(delta: number): void {
    if (!emojiScroller || !emojiGrid) return
    const rows = Math.ceil(emojiGrid.entries.length / Math.max(1, emojiColumns()))
    const maxTop = Math.max(0, rows - emojiVisibleRows())
    const top = Math.min(Math.max(0, emojiScrollRow + delta), maxTop)
    setEmojiScrollRow(top)
  }

  /** Is Shift down right now? Gtk.Button's 'clicked' signal carries no modifier
   *  state, and a second click gesture on the cell could claim the press from
   *  the button's own handler — so Shift+click reads the keyboard device at
   *  click time (the win-key-tracked flag is the fallback when there is no
   *  keyboard device). */
  function shiftDown(): boolean {
    const kb = Gdk.Display.get_default()?.get_default_seat()?.get_keyboard()
    if (!kb) return shiftHeld
    return ((kb.get_modifier_state() as number) & Gdk.ModifierType.SHIFT_MASK) !== 0
  }

  /** The commit buffer's preview line: the glyphs plain Enter / plain click
   *  will insert as ONE paste. Hidden while nothing is buffered (no dead row
   *  in the card), re-applied whenever the section is rebuilt — the buffer
   *  survives a query edit, the widgets do not. */
  function syncPending(): void {
    if (!pendingRowRef || !pendingLabelRef) return
    const glyphs = pendingGlyphs.join("")
    pendingLabelRef.set_label(glyphs ? `Pending (${pendingGlyphs.length}): ${glyphs}` : "")
    pendingRowRef.visible = glyphs.length > 0
  }

  /** Shift+Enter / Shift+click: append the picked glyph to the commit buffer
   *  and keep the card open. NOTHING is inserted here — the paste only ever
   *  runs after the card hides (emojiCommitPending), so a keep-open pick can
   *  never inject the chord into the launcher's own entry. A glyph already in
   *  the buffer appends AGAIN (the buffer is a sequence, not a set). */
  function emojiAppendPending(glyph: string): void {
    pendingGlyphs.push(glyph)
    emojiRecord(glyph)
    syncPending()
    // The preview line appearing/disappearing changes the card's height.
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      animateToContent()
      return GLib.SOURCE_REMOVE
    })
  }

  /** Insert the grid's selected glyph and close — the nothing-buffered path. */
  function emojiPickSelected(): boolean {
    const e = emojiGrid?.entries[emojiGrid.selected]
    if (!e) return false
    emojiRecord(e.glyph)
    hide()
    emojiInsert(e.glyph, pickTarget)
    return true
  }

  /** Commit the buffer: hide the card FIRST (the paste must land in the target
   *  app, never in the card's own entry), then insert the whole string as ONE
   *  ladder call — one clipboard write, one paste, one restore. hide() runs the
   *  cancel path (generation++), and the insertion bumps the counter after it,
   *  so the insertion is the newest schedule and is not dropped. */
  function emojiCommitPending(): boolean {
    if (!pendingGlyphs.length) return false
    const count = pendingGlyphs.length
    const glyphs = pendingGlyphs.join("")
    pendingGlyphs = []
    syncPending()
    hide()
    log(`emoji commit: ${JSON.stringify(glyphs)} (${count} glyphs)`)
    emojiInsert(glyphs, pickTarget)
    return true
  }

  /** Plain Enter / plain click on the emoji grid: commit the buffer when one
   *  exists, else insert the selected cell (the pre-buffer behaviour). Either
   *  way the card closes. */
  function emojiConfirm(): boolean {
    if (pendingGlyphs.length) return emojiCommitPending()
    return emojiPickSelected()
  }

  /** Activate the emoji section: Enter commits when the section already holds
   *  the list selection; otherwise the press just moves the selection onto it
   *  (the arrows then drive the grid). */
  function activateEmojiRow(i: number): boolean {
    if (selected.peek() !== i) {
      setSelected(i)
      return true
    }
    return emojiConfirm()
  }

  /** The emoji key's contract (mod+. and the entry-level `:` trigger):
   *  closed → open IN EMOJI MODE; open in emoji mode → close; open in another
   *  mode → switch to emoji mode, never close. */
  function emojiMode(): void {
    if (!win.visible) {
      show()
      combiner.setEmojiMode(true)
      return
    }
    if (combiner.isEmojiMode()) hide()
    else combiner.setEmojiMode(true)
  }

  function activateIndex(i: number): boolean {
    const list = results.peek()
    const r = list[i]
    log(
      `activateIndex(${i}): count=${list.length}, title=${r ? JSON.stringify(r.title) : "NONE"}, category=${r?.category}`,
    )
    if (!r) return false
    if (r.emojiEntries) return activateEmojiRow(i)
    let hideAfter = true
    try {
      hideAfter = r.run() !== false
    } catch (e) {
      log(`activate error: ${(e as Error).message}`)
    }
    if (hideAfter) hide()
    return true
  }

  function activateSelected(): {
    selected: number
    count: number
    ran: boolean
  } {
    const sel = selected.peek()
    const count = results.peek().length
    const ran = activateIndex(sel)
    return { selected: sel, count, ran }
  }

  /** Ctrl+Enter action: run the selected row via prime-run (NVIDIA dGPU).
   *  Falls back to the normal activate for rows without runPrime. */
  function activateSelectedPrime(): {
    selected: number
    count: number
    ran: boolean
  } {
    return activateSelectedWith((r) => r.runPrime, "activatePrime")
  }

  /** Shift+Enter action: run the selected row FLOATING (stacked on top).
   *  Falls back to the normal activate for rows without runStack. */
  function activateSelectedStack(): {
    selected: number
    count: number
    ran: boolean
  } {
    return activateSelectedWith((r) => r.runStack, "activateStack")
  }

  /** Shift+Enter on the expanded glyph grid: append the selected cell to the
   *  commit buffer and keep the card open (the keyboard twin of Shift+click).
   *  Everywhere else Shift keeps its meaning — run the selected row floating. */
  function activateSelectedShift(): {
    selected: number
    count: number
    ran: boolean
  } {
    if (!emojiGridActive()) return activateSelectedStack()
    const sel = selected.peek()
    const count = results.peek().length
    const e = emojiGrid?.entries[emojiGrid.selected]
    if (!e) return { selected: sel, count, ran: false }
    log(`activateShift(${sel}): emoji cell ${emojiGrid?.selected ?? -1} — append ${e.glyph}`)
    emojiAppendPending(e.glyph)
    return { selected: sel, count, ran: true }
  }

  /** Debug: run a query through the combiner WITHOUT showing the card, and
   *  report the list it settles on — the request surface's own probe of a
   *  preview (`launcher debug query <text>`). The card must be hidden: a debug
   *  query never takes over what the user is looking at. Each row carries
   *  `preview`, the per-kind height marker, so the split is readable from the
   *  request surface. */
  function debugQuery(text: string): Promise<
    | {
        rows: { title: string; description: string; preview: boolean }[]
        selected: number
        offset: number
        viewportPx: number
        listHeight: number
        adjustment: number
        cardHeight: number
        naturalHeight: number
        shownHeight: number
      }
    | { error: string }
  > {
    if (win.visible) return Promise.resolve({ error: "launcher is open" })
    if (!text.trim()) return Promise.resolve({ error: "empty query" })
    return new Promise((resolve) => {
      combiner.queryDidChange(text)
      const start = GLib.get_monotonic_time()
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        const elapsed = GLib.get_monotonic_time() - start
        // Past the debounce window and nothing in flight: the list is settled.
        const settled = elapsed > 400_000 && !busy()
        if (!settled && elapsed < 10_000_000) return GLib.SOURCE_CONTINUE
        resolve({
          rows: results.peek().map((r) => ({
            title: r.title,
            description: r.description ?? "",
            preview: r.preview === true,
          })),
          selected: selected.peek(),
          offset: scrollOffset,
          viewportPx: viewportHeightPx(),
          listHeight: get<number>("listHeight", 5),
          adjustment: listAdjustment()?.get_value() ?? -1,
          cardHeight: currentH,
          naturalHeight: measureHeight(),
          shownHeight: win.get_height(),
        })
        return GLib.SOURCE_REMOVE
      })
    })
  }

  /** Debug: apply ONE scroll decision through the real path the controller
   *  calls (`applyScrollEvent`) and report where the list ended up — selection,
   *  row offset, viewport height, the scroller's live adjustment value, the
   *  card's height and the glide velocity still in hand. The unit `glide`
   *  instead calls the `::decelerate` hand-off (`startGlide`) with a velocity a
   *  trackpad would report, which is how a request starts a tail without a
   *  device. The device event is the only thing it does not exercise. */
  function debugScroll(
    unit: string,
    dy: number,
  ): {
    consumed: boolean
    selected: number
    rows: number
    offset: number
    adjustment: number
    viewportPx: number
    cardHeight: number
    /** Rows/ms the glide is carrying; 0 when no tail is running. */
    glideVelocity: number
    /** Frames the running tail has taken so far. */
    glideFrames: number
  } {
    let consumed = false
    if (unit === "glide") startGlide(dy)
    else consumed = applyScrollEvent(unit === "wheel" ? "wheel" : "surface", dy)
    return {
      consumed,
      selected: selected.peek(),
      rows: results.peek().length,
      offset: scrollOffset,
      adjustment: listAdjustment()?.get_value() ?? -1,
      viewportPx: viewportHeightPx(),
      cardHeight: currentH,
      glideVelocity: glideVelocityRows,
      glideFrames,
    }
  }

  // Shared body for the modifier-key activate paths: resolves the selected
  // row's optional action (runPrime/runStack), falls back to plain activate
  // when the row has none, and logs with the caller's tag.
  function activateSelectedWith(
    pick: (r: Result) => (() => boolean | void) | undefined,
    tag: string,
  ): { selected: number; count: number; ran: boolean } {
    const sel = selected.peek()
    const list = results.peek()
    const count = list.length
    const r = list[sel]
    const action = r ? pick(r) : undefined
    if (!action) return activateSelected()
    log(`${tag}(${sel}): ${JSON.stringify(r.title)}`)
    let hideAfter = true
    try {
      hideAfter = action() !== false
    } catch (e) {
      log(`${tag} error: ${(e as Error).message}`)
    }
    if (hideAfter) hide()
    return { selected: sel, count, ran: true }
  }

  // Animate the window height toward the .main card's natural content height.
  // Measures main's preferred height each time, eases currentH toward it over
  // ANIM_MS using runFrames (frame-synced). Hyprland won't animate the layer
  // surface itself, so we drive set_size_request on the window per-frame.
  function animateToContent() {
    if (!main || !win) return
    // The list is bounded at the viewport by the scroller's own
    // `max-content-height` (`applyViewport`), so `main`'s natural height is
    // already the capped one and IS what the toplevel takes: GTK sizes a window
    // from its content, and the `set_size_request` below only raises the floor.
    const target = measureHeight()
    if (target <= 0) return
    if (currentH === 0) {
      // first frame — snap then animate subsequent growths
      currentH = target
      win.set_size_request(-1, currentH)
      return
    }
    if (Math.abs(target - currentH) < 1) {
      currentH = target
      win.set_size_request(-1, currentH)
      return
    }
    if (animRef) animRef.cancel()
    const from = currentH
    const delta = target - from
    const t0 = GLib.get_monotonic_time()
    const durUs = ANIM_MS * 1000
    animRef = runFrames(win, (nowUs) => {
      const t = Math.min(1, (nowUs - t0) / durUs)
      const e = easeCubicInOut(t)
      currentH = Math.round(from + delta * e)
      win.set_size_request(-1, currentH)
      if (t >= 1) {
        currentH = target
        animRef = null
        return false
      }
      return true
    })
  }

  // Measure the .main card's natural height (entry-row + matches + padding).
  // GTK4 measure returns [minimum, natural] in pixels for the given orientation.
  function measureHeight(): number {
    if (!main) return 0
    try {
      const [, nat] = main.measure(Gtk.Orientation.VERTICAL, -1)
      return Math.max(nat, 0)
    } catch (e) {
      log(`measure error: ${(e as Error).message}`)
      return 0
    }
  }

  // ── the result list's scroll viewport (`./scroll.ts` laws) ──

  /** The rows the viewport shows. */
  function viewportRowCount(): number {
    return viewportRows(get<number>("listHeight", 5), results.peek().length)
  }

  /** The pitch of one row, measured off the first rendered row so the linear
   *  mapping and the viewport height track the real rows (a preview row is
   *  taller than an app row). The row is read off `matchesBox` — the box the
   *  rows live in — because the scroller's `get_child()` answers the
   *  `GtkViewport` GTK wraps that box in, and its first child is the box
   *  itself: measuring there answers the WHOLE LIST's height as "one row".
   *  A row's allocation exists only after a layout pass, so a row the card has
   *  not been laid out with yet is measured instead — both answer one row's
   *  height. */
  function measureRowPitch(): number {
    try {
      const first = matchesBox?.get_first_child()
      if (!first) return ROW_PITCH_FALLBACK_PX
      const [, natural] = first.measure(Gtk.Orientation.VERTICAL, cardWidth())
      const h = first.get_height() || natural
      return h > 8 ? h : ROW_PITCH_FALLBACK_PX
    } catch {
      return ROW_PITCH_FALLBACK_PX
    }
  }

  /** The viewport height in px: the configured rows × the measured pitch. */
  function viewportHeightPx(): number {
    return viewportPixels(get<number>("listHeight", 5), rowPitchPx)
  }

  /**
   * Bound the scroller at the viewport height — `viewportHeightPx()` — so the
   * list stops contributing more than `listHeight` rows to the card's natural
   * height and scrolls the rest. Idempotent; the pitch moves with the rows, so
   * this runs at realize, on show and after every batch.
   *
   * `max-content-height` is what bounds it, and it only binds while the
   * scroller's VERTICAL policy is `AUTOMATIC`: with `NEVER` a `Gtk.ScrolledWindow`
   * propagates its child's full natural height (and minimum) and ignores the
   * property, so the window — which GTK sizes from its content — took the height
   * of every row at once.
   */
  function applyViewport(): void {
    rowPitchPx = measureRowPitch()
    matchesScroll?.set_max_content_height(viewportHeightPx())
  }

  function listAdjustment(): Gtk.Adjustment | null {
    return matchesScroll?.get_vadjustment() ?? null
  }

  /** Move the viewport to a row offset — animated for a wheel notch (smooth),
   *  rigid for an arrow or a trackpad follow. */
  function applyScrollOffset(offset: number, animate: boolean): void {
    const adj = listAdjustment()
    const rows = results.peek().length
    const vp = viewportRowCount()
    scrollOffset = clampOffset(offset, rows, vp)
    if (!adj) return
    const max = Math.max(0, adj.get_upper() - adj.get_page_size())
    const target = Math.min(offsetPixels(scrollOffset, rowPitchPx), max)
    if (!animate) {
      scrollAnim?.cancel()
      scrollAnim = null
      adj.set_value(target)
      return
    }
    const from = adj.get_value()
    if (Math.abs(target - from) < 0.5) {
      adj.set_value(target)
      return
    }
    scrollAnim?.cancel()
    const t0 = GLib.get_monotonic_time()
    scrollAnim = runFrames(win, () => {
      const t = Math.min(1, (GLib.get_monotonic_time() - t0) / (SCROLL_ANIM_MS * 1000))
      adj.set_value(from + (target - from) * easeOutCubic(t))
      if (t >= 1) {
        scrollAnim = null
        return false
      }
      return true
    })
  }

  /** The selection-follow: keep the selected row inside the viewport. */
  function followSelection(animate: boolean): void {
    const rows = results.peek().length
    if (rows === 0) return
    applyScrollOffset(
      offsetForSelection(selected.peek(), scrollOffset, viewportRowCount(), rows),
      animate,
    )
  }

  /** Stop the glide — a new gesture, a wheel notch, a closing card or the list
   *  reaching an end all end the tail here. */
  function stopGlide(): void {
    if (glide) {
      glide.cancel()
      glide = null
    }
    glideVelocityRows = 0
  }

  /**
   * Start the momentum tail of a trackpad flick from the velocity GTK measured
   * for the gesture that just ended (`::decelerate`, pixels/ms). The velocity is
   * carried frame by frame through `glideStep`, so the tail decelerates and
   * stops rather than stopping dead the moment the deltas stop arriving.
   *
   * A gesture slower than `GLIDE_START_ROWS_PER_MS` starts nothing: lifting the
   * fingers after positioning the list leaves it where it was put.
   */
  function startGlide(velocityPxPerMs: number): void {
    stopGlide()
    const velocity = glideVelocity(velocityPxPerMs, rowPitchPx)
    if (!glideStarts(velocity)) return
    glideVelocityRows = velocity
    glideFrames = 0
    let last = GLib.get_monotonic_time()
    glide = runFrames(win, (nowUs) => {
      const dtMs = (nowUs - last) / 1000
      last = nowUs
      glideFrames++
      const rows = results.peek().length
      const next = glideStep(scrollOffset, glideVelocityRows, dtMs, rows, viewportRowCount())
      glideVelocityRows = next.velocity
      applyScrollOffset(next.offset, false)
      setSelected((cur) => selectionInView(cur, scrollOffset, viewportRowCount(), rows))
      if (next.velocity === 0) {
        glide = null
        return false
      }
      return true
    })
  }

  /** ONE scroll event's effect — the ONE path the controller calls and the
   *  `launcher debug scroll` request drives, so the wiring is exercised by the
   *  request surface instead of by a synthetic device event. Returns true when
   *  the event was consumed. */
  function applyScrollEvent(unit: ScrollUnit, dy: number): boolean {
    // A delta of any kind is a gesture under way, so the previous flick's tail
    // is over before this event is read.
    stopGlide()
    const decision = scrollDecision(unit, dy, emojiGridActive())
    // CONSUMED even when the list does not act: this controller sits on the
    // same scroller as GTK's own scroll controller, and under the AUTOMATIC
    // policy that caps the list the native path is live (`may_vscroll`). The
    // grid's scroller is deeper in the event path and stops the event when it
    // scrolls, so anything reaching here is a grid that cannot scroll — and the
    // LIST must then stay still rather than let the native path move it under
    // the grid. A fractional wheel click lands here too, where moving nothing
    // is the notched-wheel feel `./scroll.ts` exists for.
    if (decision.kind === "ignore") return true
    if (decision.kind === "selection") {
      const rows = results.peek().length
      if (rows === 0) return false
      wheelDriven = true
      setSelected((cur) => stepSelection(cur, decision.steps, rows))
      followSelection(true)
      return true
    }
    const rows = results.peek().length
    applyScrollOffset(
      linearOffset(scrollOffset, decision.pixels, rowPitchPx, rows, viewportRowCount()),
      false,
    )
    setSelected((cur) => selectionInView(cur, scrollOffset, viewportRowCount(), rows))
    return true
  }

  /** The unit of a scroll event: `get_unit()` reads the LAST `::scroll`
   *  signal, which is why the controller must not carry the DISCRETE flag
   *  (`./scroll.ts` documents the trap). */
  function eventUnit(ctrl: Gtk.EventControllerScroll): ScrollUnit {
    try {
      return ctrl.get_unit() === Gdk.ScrollUnit.WHEEL ? "wheel" : "surface"
    } catch {
      return "surface"
    }
  }

  // Click-outside-to-close + focus-loss-to-close: shared popup-dismiss
  // util (also used by the clipboard picker) — see common/window/popup-dismiss.

  // Key handler attached to the ENTRY (the focused widget). Returns true to
  // consume the key (stop propagation) — critical for Escape so it doesn't
  // leak to the window behind the launcher.
  function onEntryKey(_e: Gtk.EventControllerKey, keyval: number, state: number): boolean {
    log(`[entry-key] keyval=${keyval} keyname=${Gdk.keyval_name(keyval)}`)
    switch (keyval) {
      case Gdk.KEY_Escape:
        hide()
        return true
      case Gdk.KEY_Return:
      case Gdk.KEY_KP_Enter:
        // Ctrl+Enter = run the selected row on the NVIDIA dGPU (prime-run).
        if (state & Gdk.ModifierType.CONTROL_MASK) {
          activateSelectedPrime()
          return true
        }
        // Shift+Enter = the glyph grid's keep-open pick; every other row runs
        // FLOATING (stacked on top).
        if (state & Gdk.ModifierType.SHIFT_MASK) {
          activateSelectedShift()
          return true
        }
        activateSelected()
        return true
      case Gdk.KEY_Tab:
        // !p/!code/!a bangs and path queries: Tab cycles inline path
        // completions (blind autofill); the non-committed ghost suffix is shown
        // as a selection.
        {
          const r = pathAutofill.onTab(entry.get_text(), false)
          if (r !== null) {
            entry.set_text(r.text)
            entry.select_region(r.committedLen, r.text.length)
            return true
          }
        }
        moveSelection(1)
        return true
      case Gdk.KEY_Down:
        // Expanded emoji row: the arrows drive the glyph grid, not the list.
        if (emojiGridActive()) {
          moveEmojiSelection(emojiColumns())
          return true
        }
        moveSelection(1)
        return true
      case Gdk.KEY_ISO_Left_Tab:
        // Shift+Tab cycles path completions backward; falls back to result
        // selection when the entry holds no path being completed.
        {
          const r = pathAutofill.onTab(entry.get_text(), true)
          if (r !== null) {
            entry.set_text(r.text)
            entry.select_region(r.committedLen, r.text.length)
            return true
          }
        }
        moveSelection(-1)
        return true
      case Gdk.KEY_Up:
        if (emojiGridActive()) {
          moveEmojiSelection(-emojiColumns())
          return true
        }
        moveSelection(-1)
        return true
      case Gdk.KEY_Left:
        if (emojiGridActive()) {
          moveEmojiSelection(-1)
          return true
        }
        return false // let the default cursor-move happen
      case Gdk.KEY_Right:
      case Gdk.KEY_KP_Right: {
        if (emojiGridActive()) {
          moveEmojiSelection(1)
          return true
        }
        // !p/!code/!a bangs and path queries: Right Arrow locks in the current
        // completion; a directory descends (next Tab scans its children).
        const r = pathAutofill.onAccept(entry.get_text())
        if (r !== null) {
          entry.set_text(r.text)
          entry.set_position(-1)
          return true
        }
        return false // let the default cursor-move happen
      }
      default:
        return false
    }
  }

  // The card's width: the monitor fraction from config, capped by
  // window.maxWidth. This is the width the card REQUESTS — it is only
  // authoritative because capTextLabel keeps the longest text inside it, so
  // main's request is also its natural width (see the caps note above).
  function cardWidth(): number {
    let monW = 1280
    try {
      const display = Gdk.Display.get_default()
      const monitors = display?.get_monitors?.()
      const mon0 = monitors?.get_item?.(0) as Gdk.Monitor | null
      if (mon0) monW = mon0.get_geometry().width
    } catch (e) {
      // Monitor probe failed — keep the 1280 default width.
      ignore("launcher monitor probe", e)
    }
    const frac = get<number>("window.width", 0.3)
    const max = get<number>("window.maxWidth", 800)
    return Math.min(Math.round(monW * frac), max)
  }

  /** Bound a text label to the card's width budget: max_width_chars caps its
   *  natural width, and its minimum is the ellipsis width (ellipsize=END).
   *  `lines` is how many lines it may occupy before the ellipsis — one for an
   *  ordinary row (its height is the card's baseline), two for a bang preview
   *  row, which wraps with WORD_CHAR so a long token still breaks anywhere. */
  function capTextLabel(
    label: Gtk.Label,
    pxPerChar: number,
    chrome: number,
    lines: number = DESC_LINES_ROW,
  ): void {
    const budget = textBudget(cardWidth(), chrome)
    label.set_max_width_chars(capChars(budget, pxPerChar))
    label.set_ellipsize(Pango.EllipsizeMode.END)
    if (lines > DESC_LINES_ROW) {
      label.set_wrap(true)
      label.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
      label.set_lines(lines)
    }
  }

  // Apply the configured card width.
  // Row labels are capped as they are built (the result For is reference-
  // keyed, so every result batch rebuilds them); running this at realize AND
  // on every show is what makes `window.width`/`window.maxWidth` land on a
  // runtime `launcher config set` instead of only at process start.
  function clampWidth() {
    try {
      main.set_size_request(cardWidth(), -1)
    } catch (e) {
      log(`clampWidth error: ${(e as Error).message}`)
    }
  }

  return (
    <window
      namespace="launcher"
      class="launcher"
      name="launcher"
      layer={Astal.Layer.OVERLAY}
      keymode={Astal.Keymode.EXCLUSIVE}
      exclusivity={Astal.Exclusivity.NORMAL}
      anchor={NONE}
      visible={false}
      $={(self) => {
        win = self
        // Control surface for the request dispatcher (mount.ts → setControl).
        controlHandle = {
          toggle,
          show,
          hide,
          emoji: emojiMode,
          activateSelected,
          debugQuery,
          debugScroll,
        }
        // Shared dismiss util (also used by the clipboard picker).
        bindFocusLoss(self, hide)
        self.connect("realize", () => {
          self.get_surface?.()?.set_opaque_region?.(null)
          clampWidth()
        })
        // Window-level key logger: records EVERY keyval the window sees, so we
        // can confirm whether Return (65293) is arriving at all. Also an
        // Escape backstop (in case the entry isn't focused).
        const winKey = new Gtk.EventControllerKey()
        // Ctrl-held affordance: the selected row's logo turns green while the
        // prime-run modifier is down (CSS .ctrl-held scoped to .match.selected).
        const setCtrlHeld = (held: boolean) => {
          if (held) self.add_css_class("ctrl-held")
          else self.remove_css_class("ctrl-held")
        }
        const syncCtrl = (held: boolean) => {
          if (held !== ctrlHeld) {
            ctrlHeld = held
            setCtrlHeld(held)
          }
        }
        winKey.connect(
          "key-pressed",
          (_c: any, keyval: number, _keycode: number, state: number) => {
            // A modifier key's OWN press event does not include the modifier in
            // its state — treat the Ctrl key itself as the source of truth.
            const ctrlPressed = keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Control_R
            syncCtrl(ctrlPressed || !!(state & Gdk.ModifierType.CONTROL_MASK))
            // Same for Shift — feeds the onActivate fallback path (the entry's
            // 'activate' signal carries no modifier state).
            const shiftPressed = keyval === Gdk.KEY_Shift_L || keyval === Gdk.KEY_Shift_R
            shiftHeld = shiftPressed || !!(state & Gdk.ModifierType.SHIFT_MASK)
            log(`[win-key] keyval=${keyval} keyname=${Gdk.keyval_name(keyval)}`)
            if (keyval === Gdk.KEY_Escape) {
              hide()
              return true
            }
            // ALSO handle Return/Up/Down/Tab at the window level as a fallback,
            // in case the entry controller isn't receiving them.
            if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
              if (state & Gdk.ModifierType.CONTROL_MASK) {
                activateSelectedPrime()
              } else if (state & Gdk.ModifierType.SHIFT_MASK) {
                activateSelectedShift()
              } else {
                activateSelected()
              }
              return true
            }
            if (keyval === Gdk.KEY_Down && emojiGridActive()) {
              moveEmojiSelection(emojiColumns())
              return true
            }
            if (keyval === Gdk.KEY_Down || keyval === Gdk.KEY_Tab) {
              moveSelection(1)
              return true
            }
            if (keyval === Gdk.KEY_Up && emojiGridActive()) {
              moveEmojiSelection(-emojiColumns())
              return true
            }
            if (keyval === Gdk.KEY_Up || keyval === Gdk.KEY_ISO_Left_Tab) {
              moveSelection(-1)
              return true
            }
            return false
          },
        )
        winKey.connect(
          "key-released",
          (_c: any, keyval: number, _keycode: number, state: number) => {
            // Ctrl released → clear (the release event's state can't be trusted
            // to report the modifier it just released).
            if (keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Control_R) {
              syncCtrl(false)
            } else {
              syncCtrl(!!(state & Gdk.ModifierType.CONTROL_MASK))
            }
            // Same for Shift.
            if (keyval === Gdk.KEY_Shift_L || keyval === Gdk.KEY_Shift_R) {
              shiftHeld = false
            } else {
              shiftHeld = !!(state & Gdk.ModifierType.SHIFT_MASK)
            }
          },
        )
        self.add_controller(winKey)
        // Window-level click-outside (shared popup-dismiss util).
        bindOutsideClick(self, main, hide)
      }}
    >
      <box
        $={(ref) => (main = ref)}
        class="main"
        hexpand
        // Centre the painted card inside the surface box. The surface is
        // anchored NONE (Hyprland centres the box on the monitor) and a mapped
        // layer surface does not reliably shrink — the compositor keeps the
        // grown box while the content re-measures — so a START-aligned card
        // paints above the box centre as soon as the results shrink (the
        // upward drift). CENTER keeps the card on the monitor centre through
        // growth, shrink and the emoji row's expansion.
        valign={Gtk.Align.CENTER}
        orientation={Gtk.Orientation.VERTICAL}
        halign={Gtk.Align.CENTER}
      >
        {/* entry row */}
        <box class="entry-row" spacing={14} hexpand orientation={Gtk.Orientation.HORIZONTAL}>
          <label class="entry-icon" label={entryIcon} />
          <entry
            $={(ref) => {
              entry = ref
              ref.has_frame = false
              // Attach the key controller to the ENTRY so it reliably receives
              // Return/Escape/arrows while focused, and can consume them.
              // CAPTURE phase: GtkEntry's own editing/navigation handling
              // (text insertion, Left/Right cursor moves, Backspace/Home/End)
              // swallows those keys BEFORE a default BUBBLE-phase controller
              // sees them — capture runs first, so onEntryKey gets every key.
              const keyCtrl = new Gtk.EventControllerKey()
              keyCtrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
              keyCtrl.connect(
                "key-pressed",
                (_c: any, keyval: number, _keycode: number, state: number) =>
                  onEntryKey(_c as Gtk.EventControllerKey, keyval, state),
              )
              ref.add_controller(keyCtrl)
              // Bang-catalogue rows rewrite the leading token here on
              // selection — the token ONLY, so the argument already typed
              // survives (spliceBangToken: `!co ~/x` + Enter becomes
              // `!code ~/x`, never a `!code ` that dropped the path).
              setEntryApply((prefix: string) => {
                ref.set_text(spliceBangToken(ref.get_text(), prefix))
                // move cursor to end + fire the change query
                ref.set_position(-1)
                ref.grab_focus_without_selecting()
              })
            }}
            hexpand
            vexpand
            onChanged={(self: Gtk.Entry) => {
              const text = self.get_text()
              setEntryIcon(text.trimStart().startsWith("!py") ? ICON_PY : ICON_SEARCH)
              combiner.queryDidChange(text)
              pathAutofill.onInput(text)
            }}
            onActivate={() => {
              // Gtk.Entry emits 'activate' on Return/Enter — this is the
              // most reliable hook for Enter (the EventControllerKey path can
              // be beaten to the event by the entry's own default handler).
              // The signal carries no modifier state, so Shift+Enter /
              // Ctrl+Enter are detected via the window-wide shiftHeld /
              // ctrlHeld flags (fed by winKey).
              log(`[entry-activate] selected=${selected.peek()} count=${results.peek().length}`)
              if (ctrlHeld) {
                activateSelectedPrime()
                return
              }
              if (shiftHeld) {
                activateSelectedShift()
                return
              }
              activateSelected()
            }}
          />
          {busySpinner.widget}
        </box>

        {/* matches — the SCROLL VIEWPORT: the scroller's maximum content height
            is `listHeight` rows x the measured row pitch (`./scroll.ts`), so the
            card stops growing there and the rows scroll inside it. The VERTICAL
            policy must stay `AUTOMATIC` for that bound to hold: a
            `Gtk.ScrolledWindow` with `NEVER` propagates its child's full natural
            height (and ignores `max-content-height`), and GTK sizes the window
            from its content, so the card would take the height of every row. */}
        <scrolledwindow
          hexpand
          $={(self) => {
            matchesScroll = self
            self.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            self.set_propagate_natural_height(true)
            const ctrl = Gtk.EventControllerScroll.new(SCROLL_CONTROLLER_FLAGS)
            ctrl.connect("scroll", (c: Gtk.EventControllerScroll, _dx: number, dy: number) =>
              applyScrollEvent(eventUnit(c), dy),
            )
            // The end of a continuous gesture: the KINETIC flag makes GTK emit
            // the velocity it measured for the gesture, and that velocity is
            // the momentum tail's only source (GDK sends no further deltas).
            ctrl.connect("decelerate", (_c: Gtk.EventControllerScroll, _vx: number, vy: number) =>
              startGlide(vy),
            )
            self.add_controller(ctrl)
            applyViewport()
          }}
        >
          <box
            class="matches"
            hexpand
            orientation={Gtk.Orientation.VERTICAL}
            $={(self) => (matchesBox = self)}
          >
            <For each={results}>
              {(r, index) => (r.emojiEntries ? emojiResultRow(r, index) : resultRow(r, index))}
            </For>
          </box>
        </scrolledwindow>
      </box>
    </window>
  )

  // Row class: "match", plus "selected" when this index is selected, plus
  // "preview" for a bang preview row (the per-kind height marker: only those
  // rows take a second description line — ./row-caps.ts). Reads BOTH selected
  // and index reactively so a row's highlight recomputes when
  // either changes — e.g. when calc pops in at index 0 and an app shifts to
  // index 1, the shifted row must drop its stale "selected" class even though
  // the selected index value itself stayed 0.
  function rowClass(r: Result, index: Accessor<number>): Accessor<string> {
    const base = r.preview ? "match preview" : "match"
    return selected((s) => {
      const i = index()
      return s === i ? `${base} selected` : base
    })
  }

  /** The emoji section's class: the row chrome plus the section's own padding,
   *  with the row selection treatment (so arrowing onto the section reads like
   *  selecting a row and the arrows then drive its grid). */
  function emojiSectionClass(index: Accessor<number>): Accessor<string> {
    return selected((s) => (s === index() ? "match emoji-section selected" : "match emoji-section"))
  }

  /** A plain result row — icon + text fields (+ the optional prime-run
   *  button, which owns its own click and claims over the row's gesture). */
  function resultRow(r: Result, index: Accessor<number>) {
    return (
      <box
        class={rowClass(r, index)}
        spacing={10}
        orientation={Gtk.Orientation.HORIZONTAL}
        $={(self) => {
          // Prime-run button (app rows only) — a small GPU-chip glyph on the
          // row's right. Its own GestureClick CLAIMS the sequence, so the
          // row's activate never fires on its press; the row handler also
          // bails over the button's live rect (translate_coordinates — the
          // dock-menu pattern).
          let primeBtn: Gtk.Widget | null = null
          // Click-to-activate on each row. ONE press sequence = ONE
          // activation: a double-click's second press (n_press 2) must not run
          // the SAME row again — a row that keeps the card open (a catalogue
          // hint) would otherwise apply its action twice.
          const rowClick = new Gtk.GestureClick()
          rowClick.connect("pressed", (_c, nPress, x, y) => {
            if (nPress > 1) return
            if (primeBtn && primeBtn.is_visible()) {
              // SAFETY: @girs miscasts translate_coordinates' result; gjs returns a [x, y] tuple (or null).
              const [bx, by] = primeBtn.translate_coordinates(self, 0, 0) as unknown as [
                number,
                number,
              ]
              if (
                bx !== null &&
                x >= bx &&
                x <= bx + primeBtn.get_width() &&
                y >= by &&
                y <= by + primeBtn.get_height()
              ) {
                return // the button owns this press
              }
            }
            setSelected(index.peek())
            activateIndex(index.peek())
          })
          self.add_controller(rowClick)

          if (r.runPrime) {
            const btn = new Gtk.Box({
              orientation: Gtk.Orientation.VERTICAL,
              halign: Gtk.Align.CENTER,
              valign: Gtk.Align.CENTER,
            })
            btn.add_css_class("prime-run-btn")
            btn.set_tooltip_text("Launch on NVIDIA GPU (prime-run)")
            // Grey logo at rest, green on hover: two stacked images in an
            // overlay, crossfaded via CSS (.logo-grey/.logo-green).
            const ov = new Gtk.Overlay()
            const greyImg = new Gtk.Image({ file: PRIME_ICON, pixel_size: 16 })
            greyImg.add_css_class("logo-grey")
            const greenImg = new Gtk.Image({ file: PRIME_ICON_GREEN, pixel_size: 16 })
            greenImg.add_css_class("logo-green")
            ov.set_child(greyImg)
            ov.add_overlay(greenImg)
            btn.append(ov)
            const btnClick = new Gtk.GestureClick()
            btnClick.connect("pressed", (_c, nPress) => {
              if (nPress > 1) return // one launch per press sequence
              btnClick.set_state(Gtk.EventSequenceState.CLAIMED)
              setSelected(index.peek())
              r.runPrime?.()
            })
            btn.add_controller(btnClick)
            primeBtn = btn
            self.append(btn)
          }
        }}
      >
        {r.icon ? <image iconName={r.icon} /> : null}
        <box class="text-fields" orientation={Gtk.Orientation.VERTICAL} hexpand>
          <label
            class="title"
            halign={Gtk.Align.START}
            label={r.title}
            $={(ref: Gtk.Label) => capTextLabel(ref, CAP_PX_TITLE, ROW_CHROME)}
          />
          {r.description ? (
            <label
              class="description"
              halign={Gtk.Align.START}
              label={r.description}
              $={(ref: Gtk.Label) =>
                capTextLabel(ref, CAP_PX_DESC, ROW_CHROME, descriptionLines(!!r.preview))
              }
            />
          ) : null}
        </box>
      </box>
    )
  }

  /** Publish `entries` as the active grid (plain widgets, the picker's pattern
   *  — a keystroke rebuilds the whole batch, so there is nothing to reconcile)
   *  and render its first row window. Every match stays reachable: the grid's
   *  content height is carried by the spacers, not by one cell per match. */
  function createEmojiGrid(entries: EmojiEntry[]): Gtk.Grid {
    const grid = new Gtk.Grid({
      column_homogeneous: true,
      row_spacing: EMOJI_GRID_ROW_GAP,
      column_spacing: EMOJI_GRID_ROW_GAP,
    })
    grid.add_css_class("emoji-grid")
    emojiGrid = {
      entries,
      grid,
      buttons: [],
      indices: [],
      firstRow: 0,
      rows: 0,
      selected: 0,
    }
    renderEmojiWindow(0)
    return grid
  }

  /** Render the row window starting at `firstRow`: the visible rows plus the
   *  selection margin as cells, everything above/below as one spacer of the
   *  same height. Selection and click indexes are ENTRY indexes, so a window
   *  re-render never changes what the arrows or Enter act on. */
  function renderEmojiWindow(firstRow: number): void {
    const state = emojiGrid
    if (!state?.grid) return
    const grid = state.grid
    let child = grid.get_first_child()
    while (child) {
      const next = child.get_next_sibling()
      grid.remove(child)
      child = next
    }
    const columns = Math.max(1, emojiColumns())
    const total = state.entries.length
    const totalRows = Math.ceil(total / columns)
    const first = Math.min(Math.max(0, firstRow), Math.max(0, totalRows - 1))
    const rows = Math.min(emojiVisibleRows() + EMOJI_MARGIN_ROWS, Math.max(0, totalRows - first))
    const spacer = (height: number, gridRow: number): void => {
      const box = new Gtk.Box()
      box.set_size_request(-1, Math.max(0, height - EMOJI_GRID_ROW_GAP))
      grid.attach(box, 0, gridRow, columns, 1)
    }
    const rowBase = first > 0 ? 1 : 0
    if (first > 0) spacer(first * EMOJI_ROW_PITCH, 0)

    const buttons: Gtk.Button[] = []
    const indices: number[] = []
    for (let i = first * columns; i < (first + rows) * columns && i < total; i++) {
      const entry = state.entries[i]
      const btn = new Gtk.Button()
      btn.add_css_class("emoji-cell")
      btn.set_child(new Gtk.Label({ label: entry.glyph }))
      btn.set_tooltip_text(entry.name)
      btn.connect("clicked", () => {
        if (!emojiGrid) return
        emojiGrid.selected = i
        renderEmojiSelection()
        // Shift+click buffers the cell; a plain click commits (or inserts the
        // clicked cell when nothing is buffered).
        if (shiftDown()) emojiAppendPending(entry.glyph)
        else emojiConfirm()
      })
      grid.attach(btn, i % columns, rowBase + Math.floor(i / columns) - first, 1, 1)
      buttons.push(btn)
      indices.push(i)
    }
    const below = totalRows - first - rows
    if (below > 0) spacer(below * EMOJI_ROW_PITCH, rowBase + rows)

    state.firstRow = first
    state.rows = rows
    state.buttons = buttons
    state.indices = indices
    renderEmojiSelection()
  }

  /** The emoji section — the matches render AS the content: one label that
   *  folds the term and the count together (`Emoji: emo - 43 matches`, built
   *  in ./emoji) with the glyph grid directly under it. There is no expand
   *  step and no separate count line: the grid is visible immediately and
   *  filters as the query changes. The search is UNCAPPED, so the grid scrolls
   *  once the matches exceed `grid.visibleRows`: the card height stabilises at
   *  that cap instead of growing with the match count. In emoji mode the
   *  section is the whole list; in an ordinary search it is the last block
   *  among the app rows and shares their chrome + selected treatment, so it
   *  reads as part of the same list (its glyph cells are the rows there). */
  function emojiResultRow(r: Result, index: Accessor<number>) {
    const entries = r.emojiEntries ?? []
    const visibleRows = emojiVisibleRows()
    return (
      <box
        class={emojiSectionClass(index)}
        hexpand
        orientation={Gtk.Orientation.VERTICAL}
        $={(self: Gtk.Box) => {
          // Clicking the section (its label or padding) moves the list
          // selection onto it, so the arrows then drive the grid; the glyph
          // cells carry their own click handlers.
          const click = new Gtk.GestureClick()
          click.connect("pressed", () => setSelected(index.peek()))
          self.add_controller(click)
          const label = new Gtk.Label({ label: r.title, halign: Gtk.Align.START })
          label.add_css_class("title")
          capTextLabel(label, CAP_PX_TITLE, ROW_CHROME)
          self.append(label)

          // Commit buffer preview: the glyphs Shift+Enter / Shift+click have
          // collected, inserted as ONE paste by plain Enter / plain click. Its
          // own row under the count label, so the `Emoji: <term> - <n> matches`
          // line is untouched; hidden while the buffer is empty.
          const pendingRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL })
          pendingRow.add_css_class("pending-row")
          const pendingLabel = new Gtk.Label({ label: "", halign: Gtk.Align.START })
          pendingLabel.add_css_class("pending")
          capTextLabel(pendingLabel, CAP_PX_TITLE, ROW_CHROME)
          pendingRow.append(pendingLabel)
          pendingRow.visible = false
          pendingRowRef = pendingRow
          pendingLabelRef = pendingLabel
          self.append(pendingRow)
          syncPending()

          // The grid lives in a vertical scroller capped at `visibleRows` rows:
          // every match is rendered (uncapped search), the visible area stays
          // the same, and the card's natural height stops at the cap.
          const scroller = new Gtk.ScrolledWindow()
          scroller.add_css_class("emoji-scroll")
          scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
          scroller.set_propagate_natural_height(true)
          scroller.set_max_content_height(emojiGridHeight(visibleRows))
          scroller.set_child(createEmojiGrid(entries))
          // Wheel over the card scrolls the grid one row per notch. Consuming
          // the event (true) keeps the scroller's own handler from applying it
          // twice; a scroll controller never sees clicks, so the per-cell
          // click-to-insert (and the section's select-on-click) are untouched.
          const wheel = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.VERTICAL,
          })
          wheel.connect("scroll", (_c: any, _dx: number, dy: number) => {
            scrollEmojiGrid(dy > 0 ? 1 : -1)
            return true
          })
          scroller.add_controller(wheel)
          emojiScroller = scroller
          emojiScrollRow = 0
          // Keep the tracked top row in step with the real scroll position
          // (wheel scrolling moves the adjustment without going through us).
          scroller.get_vadjustment().connect("value-changed", () => {
            if (emojiRendering) return
            emojiScrollRow = Math.round(scroller.get_vadjustment().get_value() / EMOJI_ROW_PITCH)
          })
          self.append(scroller)
        }}
      />
    )
  }
}
