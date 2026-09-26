/**
 * Clipboard picker — the launcher-style popup for the clipboard surface.
 *
 * Mirrors launcher/Launcher.tsx window/UX exactly:
 *   - layer surface, namespace "clipboard-picker", keymode EXCLUSIVE
 *     (Escape/Return must never leak to the window behind), anchored none,
 *     auto-sized to content, frosted translucent card.
 *   - dismiss: Escape (entry controller + window backstop via popup-dismiss),
 *     click outside the card, focus loss — the shared popup-dismiss util.
 *   - search entry (auto-focused) filters text entries; image rows match the
 *     "image" keyword and always show on an empty query.
 *   - Enter → copy the selected entry + dismiss; Delete → remove entry;
 *     Ctrl+P → toggle pin (right-click does the same).
 */

import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { glyphButton } from "@common/card/header"
import { copy as copyText } from "@common/clipboard"
import { dispatch } from "@common/commands/registry"
import { ignore } from "@common/log/logger"
import { bindEscape, bindFocusLoss } from "@common/window/popup-dismiss"
import { type Accessor, createState, For } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { get as getConfig } from "./config"
import { CLIPBOARD_PICKER_NAMESPACE } from "./identity"
import { log } from "./log"
import { previewEntry } from "./preview"
import type { ClipboardEntry } from "./store"
import {
  imagePath,
  pinned,
  storageDir,
  all as storeAll,
  remove as storeRemove,
  togglePin,
} from "./store"
import { thumbTexture } from "./thumbs"

const { NONE } = Astal.WindowAnchor

interface ClipboardControl {
  toggle(): void
  show(): void
  hide(): void
  focusSearch(): void
}

/** The control surface, set while Picker() builds its window; mount.ts hands
 *  it to the request dispatcher (null before Picker() ran). */
let controlHandle: ClipboardControl | null = null

export function pickerControl(): ClipboardControl | null {
  return controlHandle
}

const PIN_GLYPH = "\uf4d8" // pin glyph (nerd font)
const DELETE_GLYPH = "\u{f0a7a}" // md-trash_can_outline
const PREVIEW_GLYPH = "\u{f06d0}" // md-eye_outline

/** Filtered + ordered rows: pinned float top (stable order), then newest. */
function computeRows(
  query: string,
  entries: ClipboardEntry[],
  pinnedIds: Set<string>,
): ClipboardEntry[] {
  const q = query.trim().toLowerCase()
  const isImageMatch = (e: ClipboardEntry) =>
    e.mime === "image" && (q === "" || q.includes("image"))
  const isTextMatch = (e: ClipboardEntry) =>
    e.mime === "text" && (q === "" || (e.text ?? "").toLowerCase().includes(q))
  const shown = entries.filter((e) => (q === "" ? true : isImageMatch(e) || isTextMatch(e)))
  const pinnedList = shown.filter((e) => pinnedIds.has(e.id))
  const rest = shown.filter((e) => !pinnedIds.has(e.id))
  return [...pinnedList, ...rest]
}

/** One-line text snippet (strip newlines, cap length). */
function snippet(text: string, max = 120): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? one.slice(0, max - 1) + "…" : one
}

/** True when a press at (x, y), row-relative, landed on one of the row's
 *  control buttons rather than on the row itself. */
function pressedOnControl(row: Gtk.Box, x: number, y: number): boolean {
  let w: Gtk.Widget | null = row.pick(x, y, Gtk.PickFlags.DEFAULT)
  while (w && w !== row) {
    if (w instanceof Gtk.Button) return true
    w = w.get_parent()
  }
  return false
}

export default function Picker() {
  let win: Astal.Window
  let entry: Gtk.Entry
  let main: Gtk.Box
  let scroller: Gtk.ScrolledWindow

  const [rows, setRows] = createState<ClipboardEntry[]>([])
  const [selected, setSelected] = createState(0)
  // Pinned ids cached per refresh — pinned() reads pinned.json per call; per-
  // row calls in the render path would hit the disk N× per frame.
  const [pinnedIds, setPinnedIds] = createState<Set<string>>(new Set())

  /** Rebuild the rows from the store. `preferred` is the row position the
   *  caller wants selected afterwards (deleting a row passes the position that
   *  takes its place); without it the current selection is kept. The value is
   *  clamped to the new length, so a selection can never point past the end. */
  function refreshRows(preferred?: number): void {
    const all = storeAll()
    const p = pinned()
    setPinnedIds(p)
    const next = computeRows(entry ? entry.get_text() : "", all, p)
    // Read the selection BEFORE the setter below: the re-set is what
    // invalidates the row highlight, so the target must be decided first.
    const target = preferred ?? selected.peek()
    setSelected(-1)
    setSelected(next.length === 0 ? -1 : Math.min(Math.max(target, 0), next.length - 1))
    setRows(next)
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      sizeToContent()
      return GLib.SOURCE_REMOVE
    })
  }

  /** Copy an entry to the clipboard + dismiss. Images: read the saved PNG
   *  back to bytes → new_for_bytes("image/png", bytes) (new_for_texture does
   *  NOT exist in the installed GDK). */
  function activateEntry(e: ClipboardEntry): void {
    try {
      if (e.mime === "text" && e.text !== null && e.text !== undefined) {
        copyText(e.text)
      } else if (e.mime === "image" && e.imagePath) {
        const path = GLib.build_filenamev([storageDir(), e.imagePath])
        const [ok, bytes] = GLib.file_get_contents(path)
        if (!ok || !bytes) {
          log(`picker copy: missing image file ${path}`)
          return
        }
        const provider = Gdk.ContentProvider.new_for_bytes("image/png", bytes)
        Gdk.Display.get_default()?.get_clipboard().set_content(provider)
      }
    } catch (e) {
      log(`picker copy error: ${(e as Error).message}`)
    }
    hide()
  }

  function activateSelected(): void {
    const r = rows.peek()[selected.peek()]
    if (r) activateEntry(r)
  }

  /** Show one IMAGE entry in a media window of its own (./preview owns the
   *  request: media's spawn verb, so a second preview adds a window instead of
   *  replacing what the first one is showing). The row's own file is what the
   *  spawned window loads. */
  function previewRow(e: ClipboardEntry): void {
    if (!e.imagePath) return
    previewEntry(imagePath(e.id), { dispatch, log, hide })
  }

  /** Remove the row at `index` (its leading delete button, or the Delete key on
   *  the selected row). The selection lands on the row that takes its place —
   *  the previous one when the removed row was the last, none when the list is
   *  now empty. An unknown id removes nothing and leaves the rows alone. */
  function deleteRow(index: number): void {
    const r = rows.peek()[index]
    if (!r) return
    if (!storeRemove(r.id)) return
    refreshRows(index)
  }

  function deleteSelected(): void {
    deleteRow(selected.peek())
  }

  function toggleSelectedPin(): void {
    const r = rows.peek()[selected.peek()]
    if (!r) return
    togglePin(r.id)
    refreshRows()
  }

  function hide(): void {
    win.visible = false
  }

  function show(): void {
    entry.set_text("")
    setSelected(0)
    refreshRows()
    win.visible = true
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      entry.grab_focus_without_selecting()
      sizeToContent()
      return GLib.SOURCE_REMOVE
    })
  }

  function toggle(): void {
    if (win.visible) hide()
    else show()
  }

  function moveSelection(delta: number): void {
    const n = rows.peek().length
    if (n === 0) return
    setSelected((cur) => (cur + delta + n) % n)
  }

  function sizeToContent(): void {
    if (!main || !win) return
    try {
      const w = cardWidth()
      const ceiling = maxCardHeight()
      scroller?.set_max_content_height(ceiling)
      const [, nat] = main.measure(Gtk.Orientation.VERTICAL, w)
      // Guard the measurement: an absurd or non-finite value must never reach
      // GTK as a surface size (that is what crashed the GL renderer).
      const h = Number.isFinite(nat) ? Math.min(Math.max(nat, 0), ceiling) : ceiling
      win.set_size_request(w, h)
    } catch (e) {
      log(`sizeToContent error: ${(e as Error).message}`)
    }
  }

  /** Card width: a fraction of the monitor, hard-capped (window.width/maxWidth). */
  function cardWidth(): number {
    let monW = 1280
    try {
      const display = Gdk.Display.get_default()
      const monitors = display?.get_monitors?.()
      const mon0 = monitors?.get_item?.(0) as Gdk.Monitor | null
      if (mon0) monW = mon0.get_geometry().width
    } catch (e) {
      // Monitor probe failed — keep the 1280 default width.
      ignore("clipboard picker monitor probe", e)
    }
    const frac = getConfig<number>("window.width", 0.3)
    const max = getConfig<number>("window.maxWidth", 800)
    return Math.max(200, Math.min(Math.round(monW * frac), max))
  }

  /** Card height ceiling: the config cap, never more than the monitor allows.
   *  A layer surface sized to the FULL natural height of the list is an
   *  impossible surface (measured 22588px tall against a 900px screen): shm
   *  reports "too big" and the GL renderer segfaults in Mesa. The list scrolls
   *  under this ceiling instead of growing the window. */
  function maxCardHeight(): number {
    let monH = 800
    try {
      const display = Gdk.Display.get_default()
      const monitors = display?.get_monitors?.()
      const mon0 = monitors?.get_item?.(0) as Gdk.Monitor | null
      if (mon0) monH = mon0.get_geometry().height
    } catch (e) {
      ignore("clipboard picker monitor probe (height)", e)
    }
    const cap = getConfig<number>("window.maxHeight", 600)
    return Math.max(120, Math.min(cap, Math.round(monH * 0.9)))
  }

  // Entry-level key handling (CAPTURE phase — same as the launcher: the
  // focused entry must see Return/Escape/arrows before GtkEntry's own
  // editing handling swallows them). A binding that consumes here never
  // reaches GtkEntry, so no printable character may be bound without a
  // modifier: a bare letter binding would make that letter untypable in the
  // filter. Hence pin is Ctrl+P, and a bare p falls through to the entry.
  function onEntryKey(keyval: number, ctrl: boolean): boolean {
    switch (keyval) {
      case Gdk.KEY_Escape:
        hide()
        return true
      case Gdk.KEY_Return:
      case Gdk.KEY_KP_Enter:
        activateSelected()
        return true
      case Gdk.KEY_Down:
      case Gdk.KEY_Tab:
        moveSelection(1)
        return true
      case Gdk.KEY_Up:
      case Gdk.KEY_ISO_Left_Tab:
        moveSelection(-1)
        return true
      case Gdk.KEY_Delete:
        deleteSelected()
        return true
      case Gdk.KEY_p:
      case Gdk.KEY_P: // Ctrl+P toggles pin (right-click also works)
        if (!ctrl) return false
        toggleSelectedPin()
        return true
      default:
        return false
    }
  }

  function rowClass(index: Accessor<number>): Accessor<string> {
    // Reads BOTH selected and index reactively (launcher pattern) so a row's
    // highlight recomputes when the selected index or the row position moves.
    return selected((s) => (s === index.peek() ? "row selected" : "row"))
  }

  return (
    <window
      namespace={CLIPBOARD_PICKER_NAMESPACE}
      class="clipboard-picker"
      name={CLIPBOARD_PICKER_NAMESPACE}
      layer={Astal.Layer.OVERLAY}
      keymode={Astal.Keymode.EXCLUSIVE}
      exclusivity={Astal.Exclusivity.IGNORE}
      anchor={NONE}
      visible={false}
      $={(self) => {
        win = self
        // Control surface for the request dispatcher (mount.ts → setControl).
        controlHandle = {
          toggle,
          show,
          hide,
          focusSearch: () => entry?.grab_focus_without_selecting(),
        }
        self.connect("realize", () => {
          self.get_surface?.()?.set_opaque_region?.(null)
          sizeToContent()
        })
        // Shared dismiss util (also used by the launcher).
        bindEscape(self, hide)
        bindFocusLoss(self, hide)
      }}
    >
      <box
        $={(ref) => (main = ref)}
        class="main"
        hexpand
        // CENTER (not START) because the window is anchored NONE (Hyprland
        // centres the box) and the explicit set_size_request height does not
        // shrink reliably — a START-aligned card would paint above the box
        // centre as the rows shrink (the upward drift).
        valign={Gtk.Align.CENTER}
        orientation={Gtk.Orientation.VERTICAL}
      >
        {/* search row */}
        <box class="entry-row" spacing={14} hexpand orientation={Gtk.Orientation.HORIZONTAL}>
          <label class="entry-icon" label={PIN_GLYPH} />
          <entry
            $={(ref) => {
              entry = ref
              ref.has_frame = false
              const keyCtrl = new Gtk.EventControllerKey()
              keyCtrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
              keyCtrl.connect(
                "key-pressed",
                (_c: any, keyval: number, _code: number, state: number) =>
                  onEntryKey(keyval, (state & Gdk.ModifierType.CONTROL_MASK) !== 0),
              )
              ref.add_controller(keyCtrl)
              // connect("changed") instead of the onChanged JSX prop — the
              // installed @girs Entry typing omits the signal (launcher ships
              // a TS error for the same prop; connect is type-safe).
              ref.connect("changed", () => {
                setSelected(0)
                const all = storeAll()
                const p = pinned()
                setPinnedIds(p)
                setRows(computeRows(ref.get_text(), all, p))
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                  sizeToContent()
                  return GLib.SOURCE_REMOVE
                })
              })
            }}
            hexpand
            vexpand
          />
        </box>

        {/* rows — inside a scroller: the card grows with the list only up to
            maxCardHeight(), then the list scrolls. Without this the window is
            sized to the full natural height of every entry. */}
        <scrolledwindow
          class="rows-scroll"
          hexpand
          vscrollbar_policy={Gtk.PolicyType.AUTOMATIC}
          hscrollbar_policy={Gtk.PolicyType.NEVER}
          $={(ref: Gtk.ScrolledWindow) => {
            scroller = ref
            // Grow with the list, capped by sizeToContent()'s
            // set_max_content_height — without this the scroller reports no
            // natural height and the card collapses to the search row.
            ref.set_propagate_natural_height(true)
          }}
        >
          <box class="rows" hexpand orientation={Gtk.Orientation.VERTICAL}>
            <For each={rows}>
              {(r: ClipboardEntry, index: any) => (
                <box
                  class={rowClass(index)}
                  spacing={10}
                  orientation={Gtk.Orientation.HORIZONTAL}
                  $={(self: Gtk.Box) => {
                    const rowClick = new Gtk.GestureClick()
                    rowClick.connect("pressed", (_c: any, n: number, px: number, py: number) => {
                      setSelected(index.peek())
                      // A press that landed on one of the row's control buttons
                      // belongs to that control: each carries its own click
                      // handler, and this one hides the card on press, which
                      // would swallow the button's click before it is delivered.
                      if (pressedOnControl(self, px, py)) return
                      if (n === 1) activateEntry(r)
                      else if (n === 3) {
                        togglePin(r.id)
                        refreshRows()
                      }
                    })
                    self.add_controller(rowClick)
                  }}
                >
                  <box
                    class="row-delete-slot"
                    valign={Gtk.Align.CENTER}
                    $={(slot: Gtk.Box) => {
                      // The shared card glyph button (it measures the glyph's ink
                      // and centres it optically) — the same control the card
                      // apps' headers use. Own click handler: the row's copy
                      // gesture must not also fire for a press on the button.
                      const del = glyphButton("row-delete", DELETE_GLYPH, "Delete entry")
                      del.valign = Gtk.Align.CENTER
                      del.connect("clicked", () => deleteRow(index.peek()))
                      slot.append(del)
                    }}
                  />
                  {r.mime === "image" ? (
                    <box
                      valign={Gtk.Align.CENTER}
                      $={(slot: Gtk.Box) => {
                        // Beside the delete control and built the same way (the
                        // shared card glyph button + its own click handler, so
                        // the row's copy gesture does not also fire for a press
                        // on the button). IMAGE rows only — a text entry keeps
                        // the delete control alone.
                        const preview = glyphButton(
                          "row-preview",
                          PREVIEW_GLYPH,
                          "Preview in media player",
                        )
                        preview.valign = Gtk.Align.CENTER
                        preview.connect("clicked", () => previewRow(r))
                        slot.append(preview)
                      }}
                    />
                  ) : null}
                  <label class="pin-badge" label={pinnedIds().has(r.id) ? PIN_GLYPH : ""} />
                  {r.mime === "text" ? (
                    <label
                      class="snippet"
                      halign={Gtk.Align.START}
                      hexpand
                      label={snippet(r.text ?? "")}
                      $={(ref: Gtk.Label) => ref.set_ellipsize(Pango.EllipsizeMode.END)}
                    />
                  ) : (
                    <box
                      class="thumb-wrap"
                      hexpand
                      spacing={8}
                      orientation={Gtk.Orientation.HORIZONTAL}
                    >
                      <Gtk.Picture
                        class="thumb"
                        valign={Gtk.Align.CENTER}
                        $={(pic: Gtk.Picture) => {
                          // Cached thumbnail only — decoding the entry's full PNG
                          // here cost ~47 ms per image row on EVERY open (see
                          // thumbs.ts). A missing thumbnail just renders empty;
                          // the host backfills those at mount.
                          const tex = thumbTexture(r.id)
                          if (tex) pic.set_paintable(tex)
                        }}
                      />
                      <label
                        class="snippet"
                        halign={Gtk.Align.START}
                        hexpand
                        label={r.imagePath ?? "image"}
                        $={(ref: Gtk.Label) => ref.set_ellipsize(Pango.EllipsizeMode.END)}
                      />
                    </box>
                  )}
                  <label class="timestamp" label={formatTs(r.ts)} />
                </box>
              )}
            </For>
          </box>
        </scrolledwindow>
      </box>
    </window>
  )
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  // Today's entries show the time alone; older ones carry dd/mm beside it so
  // the list stays readable once history spans more than one day.
  const now = new Date()
  const today =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return today ? time : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`
}
