/**
 * annotate window — the editor window factory: ONE plain XDG toplevel PER OPEN
 * (NOT layer-shell, so the `annotate-float` window rule applies: float +
 * rounding from GLOBAL blur on the translucent chrome).
 *
 * Every `openEditor()` mounts its own window with its own image, stroke stack
 * and popovers; each window tears down only ITSELF (registry entry dropped
 * before destroy). Re-presenting one shared window would swap the image and the
 * stroke stack out from under an annotation already in progress.
 *
 * Built on the shared card frame (common/card/frame): the frame owns the
 * toplevel, the vertical root, the header slot and the window-level key
 * backstop. This module supplies the header controls, the canvas and the
 * status strip.
 *
 * Placement: every new window is CASCADED (see the cascade-placement block) —
 * Hyprland centres floats and GTK4 exposes no position API, so without it
 * consecutive editors would stack invisibly.
 *
 * Layout: header (tool glyphs + colour well + stroke width · undo/redo/clear ·
 * save) / canvas (Gtk.Picture base + transparent Gtk.DrawingArea overlay —
 * pointer events + stroke replay on the overlay) / status strip (zoom % +
 * file + unsaved dot).
 *
 * All stroke geometry is stored in IMAGE space and replayed under a fit
 * transform (canvas) or at scale 1 (export) — same transform composition,
 * so preview and exported PNG are WYSIWYG.
 *
 * gjs gotchas honoured (notes/AGENTS.md GOTCHA 12): the GestureClick and
 * GestureDrag on the same widget are GROUPED (click.group(drag)); drag
 * coordinates come from get_start_point + get_offset, never
 * get_last_event(). Focus is grabbed on `map`, not at creation.
 */

import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import { scheduleUnload } from "@common/app/lazy"
import { isShell } from "@common/app/mode"
import { createCardFrame } from "@common/card/frame"
import { createCardHeader, glyphButton, headerButton } from "@common/card/header"
import { createCardStatusBar } from "@common/card/status-bar"
import { copy, copyImageFile } from "@common/clipboard"
import { ACCENT } from "@common/css/tokens"
import { hyprctlJson } from "@common/hyprland/dispatch"
import { ignore, log } from "@common/log/logger"
import { isStillImage } from "@common/media/classify"
import { loadStill } from "@common/media/decode"
import type { StillImage } from "@common/media/types"
import { expandPath } from "@common/path/complete"
import { run } from "@common/subprocess/run"
import app from "ags/gtk4/app"
import Cairo from "cairo"
import { applyLive, get as getConfig, set as setConfig } from "./config"
import { recentColours, rememberColour } from "./state"
import { hexToRgb, renderStroke, type Stroke, type ToolMode } from "./tools"

// ── glyphs (MDI, plain escapes + name comments — the suite's icon language.
//    Never colour emoji: an emoji carries its own palette and ignores the
//    card's ink colour, so it reads as foreign in the toolbar) ──
const G_FREEHAND = "\u{f03eb}" // md-pencil
const G_HIGHLIGHT = "\u{f0652}" // md-marker
const G_ARROW = "\u{f005c}" // md-arrow_top_right
const G_RECT = "\u{f0e5f}" // md-rectangle_outline
const G_ELLIPSE = "\u{f0766}" // md-circle_outline
const G_TEXT = "\u{f0284}" // md-format_text
const G_UNDO = "\u{f054c}" // md-undo
const G_REDO = "\u{f044e}" // md-redo
const G_CLEAR = "\u{f0a7a}" // md-trash_can_outline
const G_SAVE = "\u{f0193}" // md-content_save
const G_SAVE_AS = "\u{f0e27}" // md-content_save_move
const G_COPY = "\u{f018f}" // md-content_copy
const G_WIDTH = "\u{f05c9}" // md-format_line_weight

/** Inner width of the two header pickers (colour / stroke width): exactly one
 *  row of six 20px chips, so the colour picker and the width picker are the
 *  same size and cannot drift apart. */
const POPOVER_WIDTH = 140

/** The tool row's viewport width — a budget, not a leftover: 300 (viewport) +
 *  162 (copy, save-as, save at the shared 54px control box) + 3 (row gaps) +
 *  12 (header padding) = 477px, which is the window's WIDTH constraint and sits
 *  under the configured `window.defaultWidth` (630) so that config can be
 *  honoured. The 11 tool controls need 362px (11×32 + 10 gaps), so at 630 the
 *  whole row is visible and only a narrower window scrolls it. */
const TOOLS_VIEWPORT_MIN = 300

/** Wheel pan step: one notch moves the tool row by two 32px control boxes. */
const WHEEL_PAN_PX = 64

/** Gdk.RGBA → "#rrggbb" — the stroke model's colour format. */
function rgbaToHex(c: Gdk.RGBA): string {
  const h = (v: number): string =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0")
  return `#${h(c.red)}${h(c.green)}${h(c.blue)}`
}

/** Paint `hex` into a swatch area as a rounded square. Cairo, not CSS: a
 *  chip's job is to show a colour, and the shared button classes' min-width /
 *  padding would otherwise flatten it to zero width. */
function paintSwatch(area: Gtk.DrawingArea, hex: string): void {
  const [r, g, b] = hexToRgb(hex)
  area.set_draw_func((_a, cr, w, h) => {
    const rad = Math.min(5, w / 3, h / 3)
    cr.setSourceRGB(r, g, b)
    cr.moveTo(rad, 0)
    cr.arc(w - rad, rad, rad, -Math.PI / 2, 0)
    cr.arc(w - rad, h - rad, rad, 0, Math.PI / 2)
    cr.arc(rad, h - rad, rad, Math.PI / 2, Math.PI)
    cr.arc(rad, rad, rad, Math.PI, (3 * Math.PI) / 2)
    cr.closePath()
    cr.fill()
  })
  area.queue_draw()
}

/** A fixed-size swatch child for a colour button. */
function swatchArea(hex: string, size: number): Gtk.DrawingArea {
  const area = new Gtk.DrawingArea()
  area.set_content_width(size)
  area.set_content_height(size)
  // Keep the swatch square: without this the area stretches to the button's
  // full height (a tall rounded rectangle instead of a chip).
  area.set_halign(Gtk.Align.CENTER)
  area.set_valign(Gtk.Align.CENTER)
  paintSwatch(area, hex)
  return area
}

const TOOLS: { mode: ToolMode; glyph: string; tip: string }[] = [
  { mode: "freehand", glyph: G_FREEHAND, tip: "pen" },
  { mode: "highlight", glyph: G_HIGHLIGHT, tip: "highlighter" },
  { mode: "arrow", glyph: G_ARROW, tip: "arrow" },
  { mode: "rect", glyph: G_RECT, tip: "rectangle" },
  { mode: "ellipse", glyph: G_ELLIPSE, tip: "ellipse" },
  { mode: "text", glyph: G_TEXT, tip: "text (click to place)" },
]

interface LoadedImage {
  path: string
  still: StillImage
}

interface EditorHandle {
  win: Gtk.Window
  path: string | null
  /** Load/reload the image (null = clear). Internal, but on the handle for openEditor. */
  load(path: string | null): void
  /** Save image+strokes → <base>-annotated.png, notify, optional clipboard. */
  save(): { ok: boolean; path?: string; error?: string }
  close(): void
  /** Per-window cleanup + handle drop. Idempotent; runs on EVERY close path
   *  (close-request, `close()`, shell unmount). */
  teardown(): void
}

/** Every OPEN editor window, in creation order. annotate is MULTI-WINDOW: one
 *  window per open call, each with its own image, strokes and popovers. */
const editors: EditorHandle[] = []

// ── cascade placement ──
// Hyprland centres every float at the SAME spot and GTK4 exposes no position
// API for a plain XDG toplevel, so consecutive editors would stack invisibly.
// Each NEW window is placed by a map-time window rule (the notes session-
// restore pattern): static rule effects are evaluated once, when the window
// opens, so the rule is registered and awaited BEFORE present(), which puts the
// window's FIRST commit at its cascade slot instead of at the monitor centre
// (no centre-then-jump flash). annotate persists no window geometry, so the
// cascade is the whole placement story: a re-open is a NEW window and takes the
// next slot.

/** Cascade step: each newly opened editor steps this far down and right from
 *  the one before it (logical px). */
const CASCADE_STEP = 30

/** hyprctl answers in milliseconds; a wedged compositor must not stall the
 *  placement chain (and behind it every later editor's window). */
const HYPRCTL_TIMEOUT_MS = 3_000

/** Cascade slot for the NEXT new editor; reset when the registry empties, so a
 *  fresh run of editors starts at the origin again. */
let cascadeSlot = 0

/** Placement chain — see placeAndPresent. */
let placement: Promise<void> = Promise.resolve()

interface HyprMonitor {
  x?: number
  y?: number
  width?: number
  height?: number
  scale?: number
  transform?: number
  focused?: boolean
}

interface MonitorBox {
  x: number
  y: number
  w: number
  h: number
}

/** The focused monitor's box in LAYOUT space (logical px — the space a rule's
 *  `move` and a client's `at`/`size` use): hyprctl reports the monitor's NATIVE
 *  resolution plus a transform, so divide by the scale factor and transpose
 *  when rotated 90/270deg. null when Hyprland cannot be read. */
async function monitorBox(): Promise<MonitorBox | null> {
  const mons = (await hyprctlJson("monitors")) as HyprMonitor[] | null
  if (!Array.isArray(mons) || mons.length === 0) return null
  const m = mons.find((x) => x.focused) ?? mons[0]
  if (typeof m.width !== "number" || typeof m.height !== "number") return null
  const scale = typeof m.scale === "number" && m.scale > 0 ? m.scale : 1
  const rotated = (typeof m.transform === "number" ? m.transform : 0) % 2 === 1
  const w = Math.round((rotated ? m.height : m.width) / scale)
  const h = Math.round((rotated ? m.width : m.height) / scale)
  if (w <= 0 || h <= 0) return null
  return { x: m.x ?? 0, y: m.y ?? 0, w, h }
}

/** Where editor `slot` lands inside monitor box `mon` for a window of `size`.
 *  The ORIGIN is the position Hyprland gives a lone float — the monitor's
 *  centre — so the first window stays where it has always been, and slot `n`
 *  steps one CASCADE_STEP down-right from it: every open is offset from the one
 *  before it by exactly one step. The slot COUNT is what fits between the
 *  origin and the monitor's far edge on whichever axis runs out first (both
 *  axes step together), and slot `n` wraps modulo that count, so a window can
 *  never be pushed off the output. */
function cascadeTarget(
  slot: number,
  mon: MonitorBox,
  size: { w: number; h: number },
): { x: number; y: number } {
  const { w, h } = size
  const clamp = (v: number, min: number, max: number): number =>
    Math.round(max < min ? min : Math.max(min, Math.min(max, v)))
  // A window larger than the output cannot be centred inside it; pinning the
  // origin to the monitor edge also keeps the room-to-edge terms below
  // non-negative, so at least one slot always fits.
  const baseX = clamp(mon.x + (mon.w - w) / 2, mon.x, mon.x + mon.w - w)
  const baseY = clamp(mon.y + (mon.h - h) / 2, mon.y, mon.y + mon.h - h)
  const slots = Math.max(
    1,
    Math.min(
      Math.floor((mon.x + mon.w - w - baseX) / CASCADE_STEP) + 1,
      Math.floor((mon.y + mon.h - h - baseY) / CASCADE_STEP) + 1,
    ),
  )
  const k = slot % slots
  // The clamp is the requirement itself: whatever the compositor ends up doing
  // with the size, the requested slot is never outside the output.
  return {
    x: clamp(baseX + k * CASCADE_STEP, mon.x, mon.x + mon.w - w),
    y: clamp(baseY + k * CASCADE_STEP, mon.y, mon.y + mon.h - h),
  }
}

/** The size the window really maps at: the frame's configured default raised by
 *  the content's own minimum (the toolbar's controls make the editor wider than
 *  `window.defaultWidth`). The placement rule pins this size, because a rule
 *  that moves a window the client then RESIZES is re-centred by Hyprland — the
 *  move does not land where it asked — and because the clamp has to reason
 *  about the geometry the window actually has. */
function mappedSize(win: Gtk.Window): { w: number; h: number } {
  const [min] = win.get_preferred_size()
  return {
    w: Math.max(getConfig("window.defaultWidth"), min?.width ?? 0),
    h: Math.max(getConfig("window.defaultHeight"), min?.height ?? 0),
  }
}

/** Register `handle`'s map-time placement rule (AWAITED — it must exist before
 *  the window opens) and present the window. The chain is serialized because
 *  static rule effects are LAST-WINS: rule N has to be registered before window
 *  N maps, or two rapid opens interleave and land both windows at the newer
 *  slot. A placement failure (no Hyprland, a wedged hyprctl) still presents the
 *  editor at Hyprland's default spot — placement must never lose a window. */
function placeAndPresent(handle: EditorHandle, slot: number): void {
  placement = placement.then(async () => {
    if (!editors.includes(handle)) return // torn down while queued behind an earlier placement
    try {
      const mon = await monitorBox()
      if (mon) {
        const size = mappedSize(handle.win)
        const p = cascadeTarget(slot, mon, size)
        // Long-bracket Lua literals: the class regex keeps its backslashes
        // verbatim, so no Lua string escaping sits between here and the rule.
        // `float` rides along so the move lands on an already-floating window
        // regardless of how Hyprland orders runtime rules against
        // annotate-float.
        //
        // The NAME must be unique for the whole HYPRLAND session, not just for
        // this process: Hyprland silently IGNORES a rule whose name it has
        // already registered (verified live — re-registering a name produced no
        // rule at all, while a fresh name applied immediately). A per-process
        // counter therefore breaks the cascade on the second run of a session
        // (after a shell restart, or an app unload): every window would fall
        // back to Hyprland's plain centre. Monotonic time is unique for as long
        // as the compositor runs, which is exactly the rule table's lifetime.
        const code =
          `hl.window_rule({ name = [[annotate-cascade-${slot}-${GLib.get_monotonic_time()}]], ` +
          `match = { class = [[^(io\\.Astal\\.annotate)$]] }, float = true, ` +
          `size = { ${size.w}, ${size.h} }, move = { ${p.x}, ${p.y} } })`
        const res = await run(["hyprctl", "eval", code], {
          timeoutMs: HYPRCTL_TIMEOUT_MS,
          captureStderr: true,
        })
        if (res.exit !== 0) log(`[annotate] cascade rule rejected: ${res.stderr.trim()}`)
      }
    } catch (e) {
      log(`[annotate] cascade placement failed: ${String(e)}`)
    }
    try {
      handle.win.present()
    } catch (e) {
      ignore("annotate present", e)
    }
  })
}

/** The window a request with no window argument acts on: the most recently
 *  opened one (null when none is open). */
export function getEditor(): EditorHandle | null {
  return editors[editors.length - 1] ?? null
}

/** What a request's image-path argument names, expanded, or the reason it
 *  cannot be opened.
 *
 *  A request that NAMES a path gets that image: the path is expanded through
 *  the shared helper first, so `~` and a relative path reach the loader as an
 *  absolute path instead of as literal text, and a path that is not a still
 *  image FILE (nothing at it, a directory, a special file, or a kind the shared
 *  still predicate rejects — the predicate the viewer and files recognise an
 *  image with) is refused. The empty editor belongs to a request that named NO
 *  path; a file that disappears between open and reload is still reported by
 *  the window's own error state (`load`). */
export function resolveTarget(target: string): { path: string } | { reason: string } {
  const path = expandPath(target.trim())
  let type: Gio.FileType
  try {
    type = Gio.File.new_for_path(path).query_file_type(Gio.FileQueryInfoFlags.NONE, null)
  } catch (e) {
    return { reason: `cannot read ${path}: ${(e as Error).message}` }
  }
  if (type === Gio.FileType.UNKNOWN) return { reason: `no such file or directory: ${path}` }
  if (type === Gio.FileType.DIRECTORY) return { reason: `is a directory: ${path}` }
  if (type !== Gio.FileType.REGULAR) return { reason: `not a regular file: ${path}` }
  if (!isStillImage(path)) return { reason: `not a still image: ${path}` }
  return { path }
}

/** Open a NEW editor window at `path` (null = no image). Every call mounts its
 *  own window — see the module header for why a shared window is wrong — at the
 *  next CASCADE slot, presented once its placement rule is registered.
 *
 *  A NAMED path is resolved and refused first (`resolveTarget`): nothing is
 *  mounted for a path that is not a decodable image file and the refusal is
 *  logged, so no caller can leave an editor showing nothing behind (the empty
 *  editor is the no-argument start). Returns the handle, or null when the named
 *  path was refused. */
export function openEditor(path: string | null): EditorHandle | null {
  const resolved = path === null ? null : resolveTarget(path)
  if (resolved && "reason" in resolved) {
    log(`[annotate] open refused — ${resolved.reason}`)
    return null
  }
  const handle = createEditorWindow()
  editors.push(handle)
  handle.load(resolved ? resolved.path : null)
  placeAndPresent(handle, cascadeSlot++)
  return handle
}

function createEditorWindow(): EditorHandle {
  // ── state ──
  let image: LoadedImage | null = null
  let strokes: Stroke[] = []
  let mode: ToolMode = "freehand"
  /** Current ink. A new window starts from the last colour the user picked
   *  (state.ts), so consecutive annotations keep the same pen; the config
   *  palette's first entry is the fallback before any colour was ever used. */
  let colour: string = recentColours()[0] ?? getConfig("tools.colours")[0] ?? ACCENT
  let dirty = false
  /** The file Save writes to. Null until the first save derives it from the
   *  source (`<base>-annotated.png`, never clobbering the screenshot); Save As
   *  sets it to the chosen path, and the title and status strip follow it. */
  let workingPath: string | null = null
  let error: string | null = null
  let lastScale = 1
  let lastStart: [number, number] = [0, 0]

  // ── header controls: the six tools · colour well · stroke width · undo /
  //    redo / clear · save ──
  const toolBtns = new Map<ToolMode, Gtk.Button>()
  const toolButtons: Gtk.Button[] = []
  for (const t of TOOLS) {
    const b = headerButton(t.glyph, t.tip)
    b.connect("clicked", () => setMode(t.mode))
    toolBtns.set(t.mode, b)
    toolButtons.push(b)
  }

  // ── colour well + stroke width: two popovers instead of a row of ovals.
  //    The well shows the current ink; its popover holds ONE list — the colours
  //    last used (state.ts, primed with the config defaults while nothing was
  //    used yet) as chips, plus a Custom… escape hatch into Gtk.ColorDialog.
  //    There is no static palette row beside it: `tools.colours` is the seed
  //    SOURCE for that list, not a second surface. Both pickers share one
  //    surface (.annotate-popover, the card family's tokens) and one inner
  //    width, so they cannot drift apart. ──
  const btnColour = new Gtk.Button()
  btnColour.add_css_class("annotate-well")
  btnColour.add_css_class("card-btn")
  btnColour.set_valign(Gtk.Align.CENTER)
  btnColour.set_tooltip_text("colour")
  const wellArea = swatchArea(colour, 18)
  btnColour.set_child(wellArea)
  const paintWell = (): void => paintSwatch(wellArea, colour)

  interface Chip {
    btn: Gtk.Button
    hex: string
  }
  /** One rounded swatch chip; clicking it selects that ink. The swatch is 16px
   *  inside the chip's 20px BOX: the selection/hover ring is a CSS inset
   *  box-shadow on the box, and a swatch that filled the box would paint over
   *  it (the ring went invisible the moment the chip shrank to the swatch). */
  function makeChip(hex: string): Chip {
    const btn = new Gtk.Button()
    btn.add_css_class("annotate-chip")
    btn.set_valign(Gtk.Align.CENTER)
    btn.set_tooltip_text(hex)
    btn.set_child(swatchArea(hex, 16))
    btn.connect("clicked", () => {
      setColour(hex)
      colourPopover.popdown()
    })
    return { btn, hex }
  }

  const colourPopover = new Gtk.Popover()
  colourPopover.add_css_class("annotate-popover")
  colourPopover.set_parent(btnColour)
  const colourBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 })
  colourBox.set_size_request(POPOVER_WIDTH, -1)
  const recentRow = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 4,
    halign: Gtk.Align.START,
  })
  let recentChips: Chip[] = []

  /** Ring the chip carrying the current ink — the "selected" state the picker
   *  shows for the preselected (most recent) colour when it opens. */
  function refreshSelection(): void {
    for (const c of recentChips) {
      if (c.hex.toLowerCase() === colour.toLowerCase())
        c.btn.add_css_class("annotate-swatch-selected")
      else c.btn.remove_css_class("annotate-swatch-selected")
    }
  }

  /** Rebuild the chips from the state store (fresh on every open, so a colour
   *  used a moment ago is already there). Up to RECENT_COLOURS_MAX chips — one
   *  row at POPOVER_WIDTH; an empty list (no config palette AND no history)
   *  hides the row so it contributes no spacing. */
  function rebuildRecents(): void {
    for (const c of recentChips) c.btn.unparent()
    recentChips = recentColours().map(makeChip)
    for (const c of recentChips) recentRow.append(c.btn)
    recentRow.set_visible(recentChips.length > 0)
    refreshSelection()
  }

  colourBox.append(recentRow)
  const colourDialog = new Gtk.ColorDialog({ title: "stroke colour", withAlpha: false })
  const btnCustom = new Gtk.Button({ label: "Custom…" })
  btnCustom.add_css_class("card-btn")
  btnCustom.set_halign(Gtk.Align.FILL)
  btnCustom.connect("clicked", () => {
    colourPopover.popdown()
    const initial = new Gdk.RGBA()
    initial.parse(colour)
    colourDialog.choose_rgba(win, initial, null, (_src, res) => {
      try {
        const picked = colourDialog.choose_rgba_finish(res)
        if (picked) setColour(rgbaToHex(picked))
      } catch (e) {
        ignore("annotate colour dialog", e) // dismissed
      }
    })
  })
  colourBox.append(btnCustom)
  colourPopover.child = colourBox
  btnColour.connect("clicked", () => {
    try {
      rebuildRecents()
      colourPopover.popup()
    } catch (e) {
      log(`well popover failed: ${String(e)}`)
    }
  })

  const btnWidth = headerButton(G_WIDTH, "stroke width")
  const widthPopover = new Gtk.Popover()
  widthPopover.add_css_class("annotate-popover")
  widthPopover.set_parent(btnWidth)
  // Stroke width: the scale drives the LIVE config so a stroke draws with the
  // new width as soon as the slider moves, but the PERSISTED write waits for
  // the interaction to settle — `value-changed` fires once per integer step of
  // a drag, and persisting in that handler rewrites the whole config file the
  // dotfiles repo tracks on every frame (one dirty tracked file per step).
  let widthLive = Math.round(getConfig("tools.lineWidth"))
  let widthSaved = widthLive
  /** Persist the settled width, once: a popover closed without a change writes
   *  nothing, and `teardown` calls this for a window closed with the width
   *  popover still open. */
  function commitWidth(): void {
    if (widthLive === widthSaved) return
    setConfig("tools.lineWidth", widthLive)
    widthSaved = widthLive
  }
  // Slider + value: GTK's own drawValue paints the number above the trough with
  // the theme's tall scale metrics (the picker grew a large empty half), so the
  // value rides BESIDE the slider in the family's muted status ink instead.
  const widthValue = new Gtk.Label({ label: String(widthLive) })
  widthValue.add_css_class("card-status")
  widthValue.set_size_request(24, -1)
  widthValue.set_halign(Gtk.Align.END)
  const widthScale = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    drawValue: false,
    hexpand: true,
    adjustment: new Gtk.Adjustment({
      lower: 1,
      upper: 24,
      stepIncrement: 1,
      pageIncrement: 4,
      value: widthLive,
    }),
  })
  widthScale.add_css_class("annotate-width")
  widthScale.connect("value-changed", () => {
    const v = Math.round(widthScale.get_value())
    widthValue.label = String(v)
    if (v === widthLive) return
    widthLive = v
    applyLive("tools.lineWidth", v)
  })
  const widthRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 })
  widthRow.set_size_request(POPOVER_WIDTH, -1)
  widthRow.append(widthScale)
  widthRow.append(widthValue)
  widthPopover.child = widthRow
  // The settle point: the popover closing is what ends the slider interaction
  // (drag release, a trough click, an arrow key, Escape and a click outside all
  // land here), so exactly one persistence follows a whole drag.
  widthPopover.connect("closed", commitWidth)
  btnWidth.connect("clicked", () => widthPopover.popup())

  const btnUndo = headerButton(G_UNDO, "undo (Ctrl+Z)")
  btnUndo.connect("clicked", () => undo())
  const btnRedo = headerButton(G_REDO, "redo (Ctrl+Shift+Z)")
  btnRedo.connect("clicked", () => redo())
  const btnClear = headerButton(G_CLEAR, "clear all")
  btnClear.connect("clicked", () => clearAll())

  // Copy sits beside Save as its clipboard sibling — the annotated image is
  // rarely destined for a file. Save keeps the accent: it stays the card's ONE
  // primary action, and the growing spacer pins the pair to the header's end.
  const btnCopy = headerButton(G_COPY, "copy to clipboard (Ctrl+C)")
  btnCopy.connect("clicked", () => copyImage())

  const btnSaveAs = headerButton(G_SAVE_AS, "save as…")
  btnSaveAs.connect("clicked", () => saveAs())

  const btnSave = glyphButton("card-primary card-primary-icon", G_SAVE, "save (Ctrl+S)")
  btnSave.connect("clicked", () => save())

  // ── header row: the LEFT tool group scrolls, the right three keep the shared
  //    control box. The row is the window's width constraint (AGENTS.md
  //    §Layout): 300 (viewport) + 162 (the right three) + 3 (gaps) + 12
  //    (padding) = 477px, so the window maps at its configured 630. ──
  const tools = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 1 })
  tools.add_css_class("annotate-tools")
  for (const w of [...toolButtons, btnColour, btnWidth, btnUndo, btnRedo, btnClear]) tools.append(w)

  const toolsScroll = new Gtk.ScrolledWindow({ hexpand: true })
  toolsScroll.add_css_class("annotate-tools-scroll")
  toolsScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
  // Overlay scrolling hides the bar until a scroll happens: the thin pill has
  // to be there as the cue that the row continues off the edge (the
  // menu-framework rule).
  toolsScroll.set_overlay_scrolling(false)
  toolsScroll.set_size_request(TOOLS_VIEWPORT_MIN, -1)
  toolsScroll.set_child(tools)
  // A wheel has no horizontal axis: map its vertical delta onto the row so the
  // controls past the edge are reachable on a plain mouse too (a trackpad
  // scrolls the row natively). Returning true consumes the event — the
  // launcher's wheel-pan pattern, which keeps the scroller from applying the
  // same delta twice.
  const wheelPan = new Gtk.EventControllerScroll({
    flags: Gtk.EventControllerScrollFlags.VERTICAL,
  })
  wheelPan.connect("scroll", (_c, _dx: number, dy: number) => {
    const adj = toolsScroll.get_hadjustment()
    adj.set_value(adj.get_value() + dy * WHEEL_PAN_PX)
    return true
  })
  toolsScroll.add_controller(wheelPan)

  // The scroller hexpands, so the row's remaining width goes to the tool group
  // and the right three stay pinned to the header's end without a spacer.
  const header = createCardHeader({
    spacing: 1,
    leading: [toolsScroll],
    trailing: [btnCopy, btnSaveAs, btnSave],
  })

  /** Key-binding adapter: run the action, then report the press consumed. */
  const consume = (action: () => void) => () => {
    action()
    return true
  }

  /** True while the text popover's entry owns the keyboard (see
   *  openTextPopover). */
  let typing = false

  /** The plain-letter TOOL bindings: an annotation containing "pen", "rect" or
   *  "text" must not switch tools mid-typing, and the character itself must
   *  still reach the entry — so while the entry is open the binding reports
   *  "not consumed" and lets it through. */
  const consumeToolKey = (action: () => void) => () => {
    if (typing) return false
    action()
    return true
  }

  const frame = createCardFrame({
    app: "annotate",
    appId: "io.Astal.annotate", // app id matched by the annotate Hyprland windowrule
    title: "annotate",
    defaultWidth: getConfig("window.defaultWidth"),
    defaultHeight: getConfig("window.defaultHeight"),
    header,
    // ── window backstop: tool letters (the reference tools' set —
    //    ShareX/Snipaste/CleanShot: P pen, H highlighter, A arrow, R rect,
    //    E ellipse, T text) plus Ctrl+Z undo, Ctrl+Shift+Z redo, Ctrl+S save,
    //    Ctrl+Shift+S save as, Ctrl+C copy the annotated image.
    //    A shifted key arrives as its SHIFTED keyval (Ctrl+Shift+Z = KEY_Z),
    //    so each shortcut binds both spellings. Every modifier is stated
    //    EXPLICITLY: the matcher treats an omitted one as a wildcard, so the
    //    plain Ctrl+S entry would otherwise swallow Ctrl+Shift+S as well.
    //    Escape stays unbound: the text popover's entry owns it. ──
    keys: {
      bindings: [
        { key: Gdk.KEY_z, ctrl: true, shift: true, run: consume(redo) },
        { key: Gdk.KEY_Z, ctrl: true, shift: true, run: consume(redo) },
        { key: Gdk.KEY_s, ctrl: true, shift: true, run: consume(saveAs) },
        { key: Gdk.KEY_S, ctrl: true, shift: true, run: consume(saveAs) },
        { key: Gdk.KEY_z, ctrl: true, shift: false, run: consume(undo) },
        { key: Gdk.KEY_Z, ctrl: true, shift: false, run: consume(undo) },
        { key: Gdk.KEY_s, ctrl: true, shift: false, run: consume(save) },
        { key: Gdk.KEY_S, ctrl: true, shift: false, run: consume(save) },
        { key: Gdk.KEY_c, ctrl: true, shift: false, run: consume(copyImage) },
        { key: Gdk.KEY_C, ctrl: true, shift: false, run: consume(copyImage) },
        {
          key: Gdk.KEY_p,
          ctrl: false,
          shift: false,
          run: consumeToolKey(() => setMode("freehand")),
        },
        {
          key: Gdk.KEY_h,
          ctrl: false,
          shift: false,
          run: consumeToolKey(() => setMode("highlight")),
        },
        { key: Gdk.KEY_a, ctrl: false, shift: false, run: consumeToolKey(() => setMode("arrow")) },
        { key: Gdk.KEY_r, ctrl: false, shift: false, run: consumeToolKey(() => setMode("rect")) },
        {
          key: Gdk.KEY_e,
          ctrl: false,
          shift: false,
          run: consumeToolKey(() => setMode("ellipse")),
        },
        { key: Gdk.KEY_t, ctrl: false, shift: false, run: consumeToolKey(() => setMode("text")) },
      ],
    },
  })
  const { win, root } = frame

  // ── canvas ──
  const picture = new Gtk.Picture()
  picture.set_content_fit(Gtk.ContentFit.CONTAIN)
  picture.set_hexpand(true)
  picture.set_vexpand(true)

  const canvas = new Gtk.DrawingArea()
  canvas.add_css_class("annotate-canvas")
  canvas.set_hexpand(true)
  canvas.set_vexpand(true)

  const overlay = new Gtk.Overlay({ hexpand: true, vexpand: true })
  overlay.set_child(picture)
  overlay.add_overlay(canvas)
  root.append(overlay)

  canvas.set_draw_func((_area, cr, w, h) => {
    if (!image || w <= 0 || h <= 0) return
    const s = Math.min(w / image.still.width, h / image.still.height)
    lastScale = s
    const ox = (w - image.still.width * s) / 2
    const oy = (h - image.still.height * s) / 2
    cr.save()
    cr.translate(ox, oy)
    cr.scale(s, s)
    // Faint bounds outline so the annotatable region is visible when the
    // window is larger than the image.
    cr.setSourceRGBA(0, 0, 0, 0.12)
    cr.setLineWidth(1 / s)
    cr.rectangle(0, 0, image.still.width, image.still.height)
    cr.stroke()
    for (const st of strokes) renderStroke(cr, st, 1)
    cr.restore()
  })

  // ── pointer → image coords ──
  function toImg(wx: number, wy: number): [number, number] | null {
    if (!image) return null
    const w = canvas.get_width()
    const h = canvas.get_height()
    if (w <= 0 || h <= 0) return null
    const s = Math.min(w / image.still.width, h / image.still.height)
    const ox = (w - image.still.width * s) / 2
    const oy = (h - image.still.height * s) / 2
    const ix = (wx - ox) / s
    const iy = (wy - oy) / s
    return [
      Math.max(0, Math.min(image.still.width, ix)),
      Math.max(0, Math.min(image.still.height, iy)),
    ]
  }

  // ── gestures (grouped — notes GOTCHA 12) ──
  const drag = Gtk.GestureDrag.new()
  const click = Gtk.GestureClick.new()
  click.group(drag)

  // A drag still ends with a GestureClick release on this GTK — grouping does
  // NOT suppress it. Without this flag every pen/highlighter drag leaves a
  // phantom single-point dot on the stack (pushed at the release point, hidden
  // under the stroke the user drew), which is why undo appeared to need two
  // presses: the first popped the invisible dot, the second removed the stroke.
  // Reset on click-press (which fires before the drag threshold is crossed),
  // so the released handler knows which gesture owned the sequence.
  let draggedThisPress = false

  drag.connect("drag-begin", (_g, startX, startY) => {
    // The TEXT tool has no drag geometry: dragging on the canvas must neither
    // push a stroke nor (through drag-update) move the PREVIOUS tool's stroke,
    // whose `to`/points would silently follow the pointer.
    if (!image || mode === "text") return
    const p = toImg(startX, startY)
    if (!p) return
    draggedThisPress = true
    lastStart = [startX, startY]
    const width = getConfig("tools.lineWidth")
    if (mode === "freehand" || mode === "highlight") {
      strokes.push({
        type: "freehand",
        colour,
        width,
        points: [p],
        highlighter: mode === "highlight",
      })
    } else if (mode === "arrow") {
      strokes.push({ type: "arrow", colour, width, from: p, to: p })
    } else if (mode === "rect" || mode === "ellipse") {
      strokes.push({ type: "rect", colour, width, from: p, to: p, ellipse: mode === "ellipse" })
    }
    markDrawn()
  })

  drag.connect("drag-update", (_g, dx, dy) => {
    if (!image || mode === "text") return
    const cur = toImg(lastStart[0] + dx, lastStart[1] + dy)
    const last = strokes[strokes.length - 1]
    if (!last || !cur) return
    if (last.type === "freehand") last.points.push(cur)
    else if (last.type === "arrow" || last.type === "rect") last.to = cur
    canvas.queue_draw()
  })

  drag.connect("drag-end", () => {
    canvas.queue_draw()
  })

  // released (not "clicked" — this GTK4 gir exposes only pressed/released
  // on GestureClick; "clicked" throws at runtime).
  click.connect("pressed", () => {
    draggedThisPress = false
  })
  click.connect("released", (_c, _n, x, y) => {
    if (!image) return
    // A jittery press cannot swallow the text placement: the drag handlers
    // ignore text mode, so draggedThisPress stays false for the TEXT tool.
    if (draggedThisPress) return // the drag gesture already owns this stroke
    const p = toImg(x, y)
    if (!p) return
    if (mode === "text") {
      openTextPopover(x, y, p)
    } else if (mode === "freehand" || mode === "highlight") {
      strokes.push({
        type: "freehand",
        colour,
        width: getConfig("tools.lineWidth"),
        points: [p],
        highlighter: mode === "highlight",
      })
      markDrawn()
      canvas.queue_draw()
    }
  })

  canvas.add_controller(drag)
  canvas.add_controller(click)

  // ── text popover ──
  //    Return commits through GtkEntry's OWN ::activate signal: a single-line
  //    entry consumes Enter itself and emits ::activate, so a key controller
  //    attached to the entry never sees the press (the text tool pushed
  //    nothing at all before). Escape stays on the controller — an entry does
  //    not consume it.
  function openTextPopover(wx: number, wy: number, imgPos: [number, number]): void {
    const popover = new Gtk.Popover()
    popover.add_css_class("annotate-popover")
    const entry = new Gtk.Entry({ placeholderText: "annotation text" })
    entry.add_css_class("card-path-entry") // the family's flat entry ink + metrics
    entry.set_size_request(180, -1)
    popover.child = entry
    popover.set_parent(overlay)
    popover.set_pointing_to(
      new Gdk.Rectangle({
        x: Math.round(wx),
        y: Math.round(wy),
        width: 1,
        height: 1,
      }),
    )

    // Single-shot: ::activate and a stray controller press must never push the
    // same text twice.
    let committed = false
    const commit = (): void => {
      if (committed) return
      committed = true
      const text = entry.get_text().trim()
      if (text) {
        strokes.push({
          type: "text",
          colour,
          width: getConfig("tools.lineWidth"),
          pos: imgPos,
          text,
          fontSize: getConfig("tools.fontSize"),
        })
        markDrawn()
        canvas.queue_draw()
      }
      popover.popdown()
    }
    entry.connect("activate", commit)
    const ek = Gtk.EventControllerKey.new()
    ek.connect("key-pressed", (_c, keyval) => {
      if (keyval === Gdk.KEY_Escape) {
        popover.popdown()
        return true
      }
      return false
    })
    entry.add_controller(ek)
    // A popover parented by hand must be unparented when it closes: leaving it
    // a child of the overlay leaks the entry's text imcontext (GTK then warns
    // "GtkText - did not receive a focus-out event"). `typing` hands the tool
    // letters back to the entry for as long as it is open.
    popover.connect("closed", () => {
      typing = false
      popover.unparent()
    })
    popover.connect("show", () => {
      typing = true
      entry.grab_focus()
    })
    popover.popup()
  }

  // ── tool / colour state ──
  function setMode(m: ToolMode): void {
    mode = m
    for (const [k, b] of toolBtns) {
      if (k === m) b.add_css_class("card-btn-active")
      else b.remove_css_class("card-btn-active")
    }
  }

  function setColour(c: string): void {
    colour = c
    paintWell()
    // The picker's recent swatches AND the ink a new window starts with: the
    // history lives in the state store, so it survives an unload/restart.
    rememberColour(c)
    refreshSelection()
  }

  function setDirty(): void {
    dirty = true
    updateStatus()
  }

  const redoStack: Stroke[] = []

  /** Availability IS the stacks: a button with nothing to pop goes insensitive
   *  (visibly dead, .card-btn:disabled ink) and comes back the moment the
   *  stack holds an entry again. */
  function updateUndoRedo(): void {
    btnUndo.set_sensitive(strokes.length > 0)
    btnRedo.set_sensitive(redoStack.length > 0)
  }

  /** Drop every stroke AND both branch stacks — a freshly loaded image must not
   *  be undoable into the previous one's strokes. */
  function resetHistory(): void {
    strokes = []
    redoStack.length = 0
    updateUndoRedo()
  }

  /** Any newly drawn stroke invalidates the redo branch (standard semantics). */
  function markDrawn(): void {
    redoStack.length = 0
    setDirty()
    updateUndoRedo()
  }

  function undo(): void {
    const s = strokes.pop()
    if (!s) return
    redoStack.push(s)
    dirty = strokes.length > 0
    canvas.queue_draw()
    updateStatus()
    updateUndoRedo()
  }

  function redo(): void {
    const s = redoStack.pop()
    if (!s) return
    strokes.push(s)
    setDirty()
    canvas.queue_draw()
    updateUndoRedo()
  }

  function clearAll(): void {
    if (strokes.length === 0) return
    resetHistory()
    dirty = false
    canvas.queue_draw()
    updateStatus()
  }

  // ── status strip (zoom · file · unsaved) — also the error line ──
  const status = createCardStatusBar()
  root.append(status.widget)

  /** Transient status note (clears itself) — the copy action's only feedback,
   *  since it deliberately writes nothing to disk. */
  let flash: string | null = null
  function setFlash(text: string): void {
    flash = text
    updateStatus()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
      flash = null
      updateStatus()
      return GLib.SOURCE_REMOVE
    })
  }

  function updateStatus(): void {
    if (error) {
      status.setText(`error: ${error}`)
      return
    }
    if (!image) {
      status.setText("no image")
      return
    }
    const parts = [
      `${Math.round(lastScale * 100)}%`,
      GLib.path_get_basename(workingPath ?? image.path),
    ]
    if (dirty) parts.push("unsaved")
    if (flash) parts.push(flash)
    status.setText(parts.join("  ·  "))
  }

  // ── load / save ──
  function exportPath(src: string): string {
    const dir = GLib.path_get_dirname(src)
    const base = GLib.path_get_basename(src).replace(/\.[^.]+$/, "")
    return GLib.build_filenamev([dir, base + getConfig("export.suffix") + ".png"])
  }

  /** Render image + strokes at full size — the ONE export composition, shared by
   *  save() (writes it to disk) and copyImage() (sends it to the clipboard). */
  function renderComposite(): Cairo.ImageSurface | null {
    if (!image) return null
    const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, image.still.width, image.still.height)
    const cr = new Cairo.Context(surf)
    cr.setSourceSurface(image.still.surface(), 0, 0)
    cr.paint()
    for (const st of strokes) renderStroke(cr, st, 1)
    return surf
  }

  /** Put the annotated image on the clipboard WITHOUT writing an export — a copy
   *  is not a save, so the source folder stays untouched until Save. gjs cairo
   *  exposes no writeToPNGStream (undefined), so PNG bytes require a file: the
   *  scratch path is FIXED and overwritten per copy, never unlinked, because the
   *  detached wl-copy child reads it after this returns. */
  function copyImage(): { ok: boolean; error?: string } {
    const surf = renderComposite()
    if (!surf) return { ok: false, error: "no image loaded" }
    const scratch = GLib.build_filenamev([
      GLib.get_user_runtime_dir() || GLib.get_tmp_dir(),
      "annotate-copy.png",
    ])
    try {
      surf.writeToPNG(scratch)
      surf.finish()
      copyImageFile(scratch)
      setFlash("copied")
      return { ok: true }
    } catch (e) {
      log(`[annotate] copy failed: ${e}`)
      setFlash("copy failed")
      return { ok: false, error: String(e) }
    }
  }

  /** Write the composite to `outPath` — the shared body of Save and Save As
   *  (same notification, same optional clipboard copy). */
  function writeComposite(outPath: string): { ok: boolean; path?: string; error?: string } {
    try {
      const surf = renderComposite()
      if (!surf) return { ok: false, error: "no image loaded" }
      surf.writeToPNG(outPath)
      surf.finish()
      workingPath = outPath
      dirty = false
      updateStatus()
      // Fire-and-forget: the annotation IS saved (and copied below), so a failed
      // notification must not become an unhandled rejection — log it instead.
      run([
        "notify-send",
        "-a",
        "annotate",
        "-i",
        "image-x-generic",
        "annotation saved",
        outPath,
      ]).catch((e: Error) => log(`[annotate] save notification failed: ${e.message}`))
      if (getConfig("export.copyToClipboard")) copy(outPath)
      return { ok: true, path: outPath }
    } catch (e) {
      log(`[annotate] save failed: ${e}`)
      return { ok: false, error: String(e) }
    }
  }

  function save(): { ok: boolean; path?: string; error?: string } {
    if (!image) return { ok: false, error: "no image loaded" }
    // The first save derives the export path from the source; after a Save As,
    // Save writes the file the user picked.
    return writeComposite(workingPath ?? exportPath(image.path))
  }

  /** Save As — pick a destination and adopt it as the working file. Gtk.FileDialog
   *  has no sync form: the chooser is async, and a dismissal arrives as an
   *  error. */
  function saveAs(): void {
    if (!image) return
    const dialog = new Gtk.FileDialog({ title: "save annotation as" })
    dialog.set_initial_name(GLib.path_get_basename(workingPath ?? exportPath(image.path)))
    dialog.set_initial_folder(Gio.File.new_for_path(GLib.path_get_dirname(image.path)))
    dialog.save(win, null, (_src: unknown, res: Gio.AsyncResult) => {
      let file: Gio.File | null = null
      try {
        file = dialog.save_finish(res)
      } catch (e) {
        ignore("annotate save-as dismissed", e)
        return
      }
      const path = file?.get_path()
      if (!path) return
      const written = writeComposite(path)
      if (written.ok) win.title = GLib.path_get_basename(path)
      else setFlash("save failed")
    })
  }

  win.connect("map", () => canvas.grab_focus())

  // Every close path converges on teardown() + destroy. The window's own
  // `destroy` signal is NOT a usable cleanup hook: gjs keeps the Gtk.Window
  // alive through gtk_window_destroy (the JS handle holds a ref, so dispose
  // never runs) and the signal was observed never to fire. A handle left
  // behind then points at a DESTROYED window — the next open present()s it,
  // GTK re-shows it and the result is a ZOMBIE no close can remove
  // (files/AGENTS.md GOTCHA 15). Each window therefore drops only ITS OWN
  // registry entry, before its destroy: a request with no window argument can
  // never reach a destroyed window, and the last teardown arms the unload.
  let torn = false
  function teardown(): void {
    if (torn) return
    torn = true
    commitWidth() // a window closed with the width popover still open keeps the width
    const i = editors.indexOf(handle)
    if (i >= 0) editors.splice(i, 1)
    if (editors.length === 0) {
      cascadeSlot = 0 // no editors left: the next open starts at the origin again
      scheduleUnload("annotate") // shell unload grace (no-op in islands)
    }
  }
  win.connect("destroy", teardown) // backstop only — may never fire (see above)
  win.connect("close-request", () => {
    teardown()
    win.destroy()
    return true // the close is done here; never defer to the default handler
  })

  // ── public handle ──
  const handle: EditorHandle = {
    win,
    path: null as string | null,
    save,
    close() {
      teardown()
      try {
        win.destroy()
      } catch (e) {
        ignore("annotate window destroy", e)
      }
    },
    teardown,
    load(path: string | null) {
      error = null
      // A freshly loaded image is not the file a previous Save As chose.
      workingPath = null
      if (!path) {
        image = null
        resetHistory()
        dirty = false
        win.title = "annotate"
        canvas.queue_draw()
        updateStatus()
        return
      }
      const f = Gio.File.new_for_path(path)
      if (!f.query_exists(null)) {
        error = `file not found: ${path}`
        image = null
        resetHistory()
        dirty = false
        canvas.queue_draw()
        updateStatus()
        return
      }
      try {
        const still = loadStill(path)
        image = { path, still }
        resetHistory()
        dirty = false
        win.title = GLib.path_get_basename(path)
        picture.paintable = still.texture
        handle.path = path
      } catch (e) {
        log(`[annotate] load failed: ${e}`)
        error = `cannot load image: ${e}`
        image = null
        resetHistory()
        dirty = false
      }
      canvas.queue_draw()
      updateStatus()
    },
  }

  setMode("freehand")
  setColour(colour)
  updateUndoRedo() // nothing drawn yet: undo and redo open insensitive
  updateStatus()
  return handle
}

// The app quits when the last window closes (desktop-app lifecycle, notes
// pattern). In the shell this is DISABLED: closing the editor must never kill the
// shared shell. The connection is created only when !isShell, so no disconnect
// is needed on shell unload/reload (the module is cached).
if (!isShell) {
  app.connect("window-removed", () => {
    if (app.windows.length === 0) app.quit()
  })
}

/** Close EVERY open editor window — the `close` request's app-level action
 *  (each window runs its own teardown before its destroy). */
export function closeEditors(): void {
  for (const e of [...editors]) e.close()
}

/** Shell unmount: tear down EVERY open editor window. */
export function unmountAnnotate(): void {
  cascadeSlot = 0 // module scope survives a lazy unload — re-arm the cascade origin
  for (const e of [...editors]) {
    e.teardown()
    try {
      e.win.destroy()
    } catch (err) {
      ignore("annotate window destroy on unmount", err)
    }
  }
}
