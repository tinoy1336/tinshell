/**
 * portal chooser window — the TINSHELL FileChooser surface.
 *
 * Built on the shared card substrate, the way files' browser is: the frame
 * (common/card/frame) owns the plain XDG toplevel, the app id, the minimum size
 * and the window key backstop; this module supplies the header (shared card
 * header + shared path bar), the body (a places column beside a listing the
 * preview pane displaces), the status bar and the actionbar.
 *
 * WHY NOT Gtk.FileChooserWidget: that widget's own minimum width is 609px
 * (measured; its natural is 815px), so a preview pane inside a dialog could only
 * be carved out of the picker's allocation — Gtk.Paned then hands the
 * over-minimum picker its minimum anchored at the divider and the picker's
 * content slides out of the dialog's LEFT edge. A chooser built here has no such
 * floor: the listing is an ordinary card listing, so the pane displaces it
 * exactly like the browser's.
 *
 * WHAT THE WIDGET WAS CARRYING, now owned here (the portal contract):
 * navigation (back/forward/up, breadcrumbs, the Ctrl+L path entry, a places
 * column, row activation), the listing (folders first, sortable columns,
 * hidden-file filtering), FILTER matching (glob patterns + mime types from the
 * caller's `filters` / `current_filter`), the SAVE name entry (selection fills
 * it, Enter accepts, a name holding "/" or a folder name is refused),
 * overwrite confirmation, multi-selection and directory selection, and the
 * keyboard flow (Escape cancels, Enter accepts, arrows/Home/End/Page* drive the
 * listing). Gaps kept out of scope on purpose: the widget's RECURSIVE search
 * (Ctrl+F / type-to-search), its "Recent" virtual folder, and type-ahead in the
 * listing. `choices` (a(ssa(ss)s)) was never rendered.
 *
 * The window only builds widgets + collects URIs. The D-Bus reply stays
 * DEFERRED in dbus.ts via the onResponse callback (set per request). The
 * response fires EXACTLY ONCE per window (responded guard): Accept, Cancel,
 * window close-request (X), Escape, and Close() all converge on respond().
 * Escape is the dialog's CANCEL path, not a window close.
 *
 * Frost comes from the Hyprland portal-float window rule (translucent card,
 * radius 14), NOT CSS shadows.
 */

import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import {
  absolutePath,
  checkDir,
  compareEntries,
  type DirEntry,
  formatBytes,
  formatDate,
  freeSpace,
  glyphFor,
  listDirAsync,
  monitorDir,
  type SortKey,
} from "@apps/files/fs"
import { type CardDirList, createCardDirList, HIDDEN_TOGGLE } from "@common/card/dir-list"
import { createCardFrame } from "@common/card/frame"
import { createCardHeader, GLYPH, headerButton } from "@common/card/header"
import { createCardPathBar } from "@common/card/path-bar"
import { ignore, log } from "@common/log/logger"
import { attachPaneDivider } from "@common/media/divider"
import { createMediaPane, type MediaPane } from "@common/media/pane"
import { createPreviewSession, type PreviewSession } from "@common/media/preview"
import { get as getConfig } from "./config"
import { PORTAL_APP_ID } from "./identity"

export type ChooserKind = "open" | "save" | "save-many"

export interface ChooserOptions {
  title: string
  acceptLabel?: string
  modal?: boolean
  multiple?: boolean
  directory?: boolean
  /** [name, [type, pattern][]], type 0 = glob, 1 = mime-type. */
  filters?: [string, [number, string][]][]
  /** The filter selected by the app (matched by name) — `(sa(us))`, one
   *  structure of name + rules, not a list. */
  activeFilter?: [string, [number, string][]] | null
  /** NUL-terminated ay bytes decoded to a path. */
  currentFolder?: string
  currentName?: string
  currentFile?: string
  /** SaveFiles: the filenames the app wants to write (aay). */
  inputFiles?: string[]
}

/** The handle dbus.ts owns per request: response callback + lifecycle. */
export interface ChooserHandle {
  win: Gtk.Window
  /** Set by dbus.ts. Called exactly once with (code, uris) when the chooser ends. */
  onResponse: ((code: number, uris: string[]) => void) | null
  /** Close() path (app aborted): respond code 1 + destroy. */
  close(): void
  present(): void
  destroy(): void
}

/** List row object — plain GObject for Gio.ListStore (the DirEntry rides on a
 *  JS field, so no ParamSpecs). `registerClass` is what gives it a GType: a
 *  bare `class extends GObject.Object` has none, and `Gio.ListStore.new()` then
 *  throws "Tried to construct an object without a GType". The GTypeName is
 *  unique because the shell hosts this app beside files' browser. */
const ChooserRow = GObject.registerClass(
  { GTypeName: "PortalChooserRow" },
  class extends GObject.Object {},
)

/** The places column's glyphs (verified MDI names, brace form — every codepoint
 *  is above the BMP). */
const PLACE_GLYPH = {
  home: GLYPH.home,
  desktop: "\u{f0379}", // md-monitor
  documents: "\u{f0219}", // md-file_document
  downloads: "\u{f01da}", // md-download
  music: "\u{f0223}", // md-file_music
  pictures: "\u{f02e9}", // md-image
  videos: "\u{f022b}", // md-file_video
  public: "\u{f0dcd}", // md-folder_account
  templates: "\u{f0866}", // md-file_outline
  bookmark: "\u{f0183}", // md-bookmark
  folder: "\u{f024b}", // md-folder
} as const

/** A places-column row. */
interface Place {
  label: string
  path: string
  glyph: string
}

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

/** The places column's rows: the session's XDG directories that exist, then the
 *  GTK bookmark file's entries. GTK's "Recent" virtual folder is deliberately
 *  not reproduced (see the module note). */
function buildPlaces(): Place[] {
  const out: Place[] = []
  const seen = new Set<string>()
  const add = (label: string, path: string | null, glyph: string) => {
    if (!path || seen.has(path)) return
    if (!GLib.file_test(path, GLib.FileTest.IS_DIR)) return
    seen.add(path)
    out.push({ label, path, glyph })
  }
  add("Home", GLib.get_home_dir(), PLACE_GLYPH.home)
  const xdg: [string, GLib.UserDirectory, string][] = [
    ["Desktop", GLib.UserDirectory.DIRECTORY_DESKTOP, PLACE_GLYPH.desktop],
    ["Documents", GLib.UserDirectory.DIRECTORY_DOCUMENTS, PLACE_GLYPH.documents],
    ["Downloads", GLib.UserDirectory.DIRECTORY_DOWNLOAD, PLACE_GLYPH.downloads],
    ["Music", GLib.UserDirectory.DIRECTORY_MUSIC, PLACE_GLYPH.music],
    ["Pictures", GLib.UserDirectory.DIRECTORY_PICTURES, PLACE_GLYPH.pictures],
    ["Videos", GLib.UserDirectory.DIRECTORY_VIDEOS, PLACE_GLYPH.videos],
    ["Public", GLib.UserDirectory.DIRECTORY_PUBLIC_SHARE, PLACE_GLYPH.public],
    ["Templates", GLib.UserDirectory.DIRECTORY_TEMPLATES, PLACE_GLYPH.templates],
  ]
  for (const [label, kind, glyph] of xdg) add(label, GLib.get_user_special_dir(kind), glyph)
  try {
    const bookmarks = GLib.build_filenamev([GLib.get_user_config_dir(), "gtk-3.0", "bookmarks"])
    if (GLib.file_test(bookmarks, GLib.FileTest.EXISTS)) {
      const [ok, contents] = GLib.file_get_contents(bookmarks)
      if (ok) {
        const text = new TextDecoder("utf-8").decode(contents as Uint8Array)
        for (const line of text.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith("#")) continue
          const space = trimmed.indexOf(" ")
          const uri = space < 0 ? trimmed : trimmed.slice(0, space)
          const label = space < 0 ? "" : trimmed.slice(space + 1).trim()
          if (!uri.startsWith("file://")) continue
          add(label || basename(uri), Gio.File.new_for_uri(uri).get_path(), PLACE_GLYPH.bookmark)
        }
      }
    }
  } catch (e) {
    ignore("chooser bookmarks", e)
  }
  return out
}

/** POSIX-ish glob → RegExp, the semantics `Gtk.FileFilter` patterns have:
 *  `*` any run, `?` one character, `[...]` a character class (a leading `!` or
 *  `^` negates it), everything else literal. Case-sensitive, like fnmatch on
 *  Linux. */
function globToRegExp(pattern: string): RegExp {
  let out = "^"
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") out += ".*"
    else if (c === "?") out += "."
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1)
      if (end < 0) out += "\\["
      else {
        let set = pattern.slice(i + 1, end)
        if (set.startsWith("!")) set = `^${set.slice(1)}`
        out += `[${set.replace(/\\/g, "\\\\")}]`
        i = end
      }
    } else out += c.replace(/[.+^${}()|[\]\\]/, (m) => `\\${m}`)
  }
  return new RegExp(`${out}$`)
}

/** The caller's filter list, compiled once per window: a pattern rule compiles
 *  to a RegExp over the file NAME, a mime rule matches the guessed content type
 *  (`type/*` included). */
interface CompiledFilter {
  name: string
  globs: RegExp[]
  mimes: string[]
}

function compileFilters(filters: [string, [number, string][]][]): CompiledFilter[] {
  return filters.map(([name, rules]) => ({
    name,
    globs: rules.filter(([type]) => type === 0).map(([, pattern]) => globToRegExp(pattern)),
    mimes: rules.filter(([type]) => type === 1).map(([, value]) => value),
  }))
}

/** Build the custom chooser window for one request. */
export function createChooserWindow(kind: ChooserKind, opts: ChooserOptions): ChooserHandle {
  const winCfg = getConfig("window")
  const appearance = getConfig("appearance") as {
    textColour: string
    accentColour: string
    selectionColour: string
    hoverColour: string
    fontSize: number
  }
  const isSave = kind === "save" || kind === "save-many"
  const selectFolder = kind === "open" && !!opts.directory
  const multiSelect = kind === "save-many" || (kind === "open" && !!opts.multiple)
  const saveNames = opts.inputFiles ?? []
  const iconSize = Math.round(appearance.fontSize + 6)

  // ── per-window state ──
  const state = {
    path: "",
    items: [] as DirEntry[], // raw listing (hidden included — filtered at render)
    error: null as string | null,
    gen: 0, // stale-enumeration guard
    cancel: null as Gio.Cancellable | null,
    monitor: null as ReturnType<typeof monitorDir> | null,
    debounceId: null as number | null,
    hidden: false,
    destroyed: false,
  }
  // The caller's suggested file: selected (and scrolled to) once the folder
  // that holds it has listed. `current_file` carries it for open requests.
  let pendingSelect: string | null = opts.currentFile ? absolutePath(opts.currentFile) : null
  // Content types are guessed once per path per listing (the guess reads only
  // the name — no I/O — so this is a cache to keep re-renders cheap, not a
  // performance fix).
  const mimeCache = new Map<string, string>()

  // ── widgets ──
  const pathBar = createCardPathBar({
    onNavigate: (p) => list.navigate(p),
    onCommit: (p) => list.commitTypedPath(p),
  })
  const btnBack = headerButton(GLYPH.back, "back (Alt+Left)")
  const btnFwd = headerButton(GLYPH.fwd, "forward (Alt+Right)")
  const btnUp = headerButton(GLYPH.up, "parent directory (Backspace / Alt+Up)")
  const btnHidden = headerButton(HIDDEN_TOGGLE.show, "show hidden files (Ctrl+H)")
  const btnReload = headerButton(GLYPH.reload, "reload (Ctrl+R)")
  const btnPreview = headerButton(GLYPH.eyeOff, "show the preview pane")

  const header = createCardHeader({
    leading: [btnBack, btnFwd, btnUp],
    title: pathBar.widget,
    trailing: [btnHidden, btnReload],
  })

  /** Key-binding adapter: run the action, then report the press consumed. */
  const consume = (action: () => void) => () => {
    action()
    return true
  }

  const frame = createCardFrame({
    app: "portal",
    appId: PORTAL_APP_ID, // app id matched by the portal-float generated compositor rule
    title: opts.title || "Open File",
    defaultWidth: winCfg.defaultWidth,
    defaultHeight: winCfg.defaultHeight,
    modal: !!opts.modal,
    header,
    // Escape cancels the request; it never closes the window on its own (see
    // the response machinery below). The listing keeps the ColumnView's own
    // controller for arrows / Home / End / Page*, and Return reaches the
    // activate-item action first.
    keys: {
      escape: () => respond(1, []),
      bindings: [
        { key: Gdk.KEY_l, ctrl: true, run: consume(() => pathBar.beginEdit()) },
        { key: Gdk.KEY_h, ctrl: true, run: consume(toggleHidden) },
        { key: Gdk.KEY_r, ctrl: true, run: consume(reload) },
        { key: Gdk.KEY_BackSpace, ctrl: false, alt: false, run: consume(() => list.up()) },
        { key: Gdk.KEY_Up, alt: true, run: consume(() => list.up()) },
        { key: Gdk.KEY_Left, alt: true, run: consume(() => list.back()) },
        { key: Gdk.KEY_Right, alt: true, run: consume(() => list.forward()) },
        { key: Gdk.KEY_Return, ctrl: false, alt: false, run: tryAccept },
        { key: Gdk.KEY_KP_Enter, ctrl: false, alt: false, run: tryAccept },
      ],
    },
  })
  const { win, root } = frame

  // ── places column ──
  const placesList = new Gtk.ListBox()
  placesList.add_css_class("chooser-places")
  placesList.set_selection_mode(Gtk.SelectionMode.SINGLE)
  const placesScroll = new Gtk.ScrolledWindow({ vexpand: true })
  placesScroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
  placesScroll.child = placesList
  placesScroll.add_css_class("chooser-places-scroll")
  placesScroll.set_size_request(150, -1)
  const placeRows: { row: Gtk.ListBoxRow; place: Place }[] = []
  for (const place of buildPlaces()) {
    const row = new Gtk.ListBoxRow()
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 })
    const glyph = new Gtk.Label({ label: place.glyph })
    glyph.add_css_class("chooser-place-icon")
    const label = new Gtk.Label({
      label: place.label,
      xalign: 0,
      hexpand: true,
      single_line_mode: true,
      ellipsize: Pango.EllipsizeMode.END,
    })
    label.add_css_class("chooser-place-label")
    box.append(glyph)
    box.append(label)
    row.child = box
    row.set_tooltip_text(place.path)
    placesList.append(row)
    placeRows.push({ row, place })
  }
  placesList.connect("row-activated", (_l, row) => {
    const hit = placeRows.find((p) => p.row === row)
    // SINGLE selection mode is what makes a click emit row-activated; the
    // highlight is cleared straight away so no place ever reads as "current".
    placesList.unselect_all()
    if (hit) list.navigate(hit.place.path)
  })

  // ── the listing: the shared card listing (common/card/dir-list) ──
  // A SINGLE selection model carries the CURSOR (the row the keyboard and a
  // plain click move), and the multi-selection is this app's own set of picked
  // paths. GTK's Gtk.MultiSelection does not select on a click in this GTK
  // (verified: SingleSelection notifies on a row click, MultiSelection never
  // does, with or without can_unselect), so a multiple-selection dialog built on
  // it could not be driven with the mouse at all.
  const list: CardDirList<DirEntry, SortKey> = createCardDirList<DirEntry, SortKey>({
    cssPrefix: "chooser",
    rowType: ChooserRow,
    name: {
      key: "name",
      title: "name",
      glyph: glyphFor,
      label: (entry) => entry.displayName,
      hidden: (entry) => entry.hidden,
    },
    meta: [
      {
        key: "size",
        title: "size",
        align: "end",
        text: (entry) => (entry.isDir ? "" : formatBytes(entry.size)),
      },
      {
        key: "modified",
        title: "modified",
        align: "start",
        text: (entry) => (entry.modifiedMs ? formatDate(entry.modifiedMs) : ""),
      },
    ],
    // Folders always lead (the chooser's own order policy) — the same
    // comparison for the render order and for every column sorter.
    compare: (a, b, order) => compareEntries(a, b, order, true),
    onActivate: activateEntry,
    onOrderChanged: () => render(),
    onSelectionChanged: () => onSelectionChanged(),
    status: {
      lead: () => {
        const pickedList = pickedEntries()
        if (pickedList.length === 1) {
          return pickedList[0].displayName + (pickedList[0].isDir ? "/" : "")
        }
        return pickedList.length > 1 ? `${pickedList.length} selected` : null
      },
      error: () => state.error,
      formatBytes,
    },
    hiddenButton: btnHidden,
    // The multi-selection's own per-cell work: the pick gesture, the cell→path
    // registry and the picked-row classes (row:selected is painted from the
    // model, which only ever holds the cursor).
    cells: {
      setup: (cell) => attachPickGesture(cell),
      bind: (cell, entry) => {
        cellPaths.set(cell, entry.path)
        if (picked.has(entry.path)) {
          cell.add_css_class("chooser-picked")
          cell.get_parent()?.add_css_class("chooser-picked")
        } else {
          cell.remove_css_class("chooser-picked")
          cell.get_parent()?.remove_css_class("chooser-picked")
        }
      },
      unbind: (cell) => cellPaths.delete(cell),
    },
    nav: {
      show: showDir,
      currentPath: () => state.path,
      resolvePath: absolutePath,
      checkPath: checkDir,
      checkErrorText: "cannot open this folder",
      reportError: setError,
      // A crumb click on the directory already on screen RE-LISTS it: a dialog
      // refreshes where the browser leaves the listing alone.
      relistOnSamePath: true,
    },
  })

  // ── body: places | listing | pane ──
  // The pane always takes the SIDE slot: a dialog whose listing is hidden cannot
  // pick anything, so only the shared width follows the preference.
  const body = new Gtk.Paned({
    orientation: Gtk.Orientation.HORIZONTAL,
    hexpand: true,
    vexpand: true,
  })
  body.set_start_child(list.area)
  // THIS dialog's preview switch: seeded from the stored last-applied value,
  // flipped by the header glyph and by a divider fold, never moved by another
  // window's flip.
  const session: PreviewSession = createPreviewSession()
  const pane: MediaPane = createMediaPane({
    appearance: { textColour: appearance.textColour, fontSize: appearance.fontSize, iconSize },
    mode: "pane",
    onOpen: (path) => {
      // The pane's open action ACCEPTS the item it holds — the chooser's own
      // current item, re-read here so a moved selection cannot accept the wrong
      // file.
      if (currentItemPath() === path) tryAccept()
      else log(`[preview] open ignored: selection moved off ${path}`)
    },
  })
  pane.widget.add_css_class("media-pane-split")
  body.set_end_child(pane.widget)
  const detachDivider = attachPaneDivider({ paned: body, pane: pane.widget, display: win, session })

  const bodyRow = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    hexpand: true,
    vexpand: true,
  })
  bodyRow.add_css_class("chooser-body")
  bodyRow.append(placesScroll)
  bodyRow.append(body)
  root.append(bodyRow)

  // status bar (also the error line)
  root.append(list.status.widget)

  // ── actionbar: filter control · save name · preview toggle · Cancel/Accept ──
  root.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }))

  const bar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, hexpand: true })
  bar.add_css_class("card-actionbar")

  const filters = compileFilters(opts.filters ?? [])
  let activeFilter: CompiledFilter | null = null
  if (filters.length > 0) {
    // Gtk.FileChooserWidget applies the FIRST filter added when the caller
    // named none, so the chooser opens the same way.
    const wanted = opts.activeFilter?.[0]
    const index = Math.max(
      0,
      filters.findIndex((f) => f.name === wanted),
    )
    activeFilter = filters[index]
    const dropdown = Gtk.DropDown.new_from_strings(filters.map((f) => f.name))
    dropdown.add_css_class("chooser-filter")
    dropdown.set_selected(index)
    dropdown.set_tooltip_text("file type filter")
    dropdown.connect("notify::selected", () => {
      activeFilter = filters[dropdown.get_selected()] ?? null
      render()
    })
    bar.append(dropdown)
  }

  const nameEntry = new Gtk.Entry({ hexpand: true, placeholder_text: "file name" })
  nameEntry.add_css_class("chooser-name-entry")
  if (isSave) {
    const initial = opts.currentName ?? (opts.currentFile ? basename(opts.currentFile) : "")
    if (initial) nameEntry.text = initial
    nameEntry.connect("changed", () => followCurrentItem())
    nameEntry.connect("activate", () => tryAccept())
    bar.append(nameEntry)
  }

  bar.append(btnPreview)
  const spacer = new Gtk.Box({ hexpand: true })
  bar.append(spacer)
  // No mnemonic underscores: GTK4's Gtk.Button:use-underline defaults to FALSE,
  // so an underscore in the label renders literally. Strip the one a caller may
  // have sent through accept_label as well.
  const acceptText = (opts.acceptLabel ?? (isSave ? "Save" : "Open")).replace(/^_/, "")
  const btnCancel = new Gtk.Button({ label: "Cancel" })
  btnCancel.add_css_class("card-action")
  const btnAccept = new Gtk.Button({ label: acceptText })
  btnAccept.add_css_class("card-primary")
  bar.append(btnCancel)
  bar.append(btnAccept)
  root.append(bar)

  // ── selection / preview ──

  /** The picked paths (multi-selection) and the cursor row's entry. */
  const picked = new Set<string>()
  /** The cell widget → entry path, for the picked-row visuals (every column's
   *  cell registers itself here so a click anywhere in the row finds its path). */
  const cellPaths = new Map<Gtk.Widget, string>()
  /** The row index a Shift+click extends from (the last plain selection). */
  let pickAnchor = -1

  function pickedEntries(): DirEntry[] {
    return list.rows().filter((entry) => picked.has(entry.path))
  }

  /** Repaint the picked rows. The selected STATE comes from the selection
   *  model, so the picks carry their own class. */
  function syncPickedVisuals(): void {
    for (const [widget, path] of cellPaths) {
      const row = widget.get_parent() ?? widget
      for (const target of row === widget ? [widget] : [widget, row]) {
        if (picked.has(path)) target.add_css_class("chooser-picked")
        else target.remove_css_class("chooser-picked")
      }
    }
  }

  /** The modifier state at the moment of a click — the keyboard's live state is
   *  the portable read (GtkGesture's current-event accessor is not bound). */
  function currentModifiers(): number {
    try {
      const seat = Gdk.Display.get_default()?.get_default_seat()
      return seat?.get_keyboard()?.get_modifier_state() ?? 0
    } catch (e) {
      ignore("chooser modifier read", e)
      return 0
    }
  }

  /** A Ctrl/Shift click picks without moving the cursor, so it CONSUMES the
   *  press; a plain click falls through to the selection model. */
  function attachPickGesture(cell: Gtk.Widget): void {
    if (!multiSelect) return
    const gesture = new Gtk.GestureClick()
    gesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    gesture.connect("pressed", () => {
      const path = cellPaths.get(cell)
      if (!path) return false
      const modifiers = currentModifiers()
      const ctrl = (modifiers & Gdk.ModifierType.CONTROL_MASK) !== 0
      const shift = (modifiers & Gdk.ModifierType.SHIFT_MASK) !== 0
      const rows = list.rows()
      const index = rows.findIndex((entry) => entry.path === path)
      if (index < 0) return false
      if (ctrl) {
        if (picked.has(path)) picked.delete(path)
        else picked.add(path)
        pickAnchor = index
        syncPickedVisuals()
        list.updateStatus()
        followCurrentItem()
        return true
      }
      if (shift) {
        const from = pickAnchor >= 0 ? pickAnchor : index
        picked.clear()
        for (let i = Math.min(from, index); i <= Math.max(from, index); i++) {
          picked.add(rows[i].path)
        }
        syncPickedVisuals()
        list.updateStatus()
        followCurrentItem()
        return true
      }
      return false // plain press: the selection model moves the cursor
    })
    cell.add_controller(gesture)
  }

  let panePath: string | null = null

  /** The file the preview pane should hold: the selection (open), the resolved
   *  name the user typed (save, when it exists — the overwrite preview), or
   *  nothing (directory mode has no single file). */
  function currentItemPath(): string | null {
    if (selectFolder) return null
    if (isSave) {
      const target = saveTargetPath()
      return target && GLib.file_test(target, GLib.FileTest.EXISTS) ? target : null
    }
    const pickedList = pickedEntries()
    return pickedList.length > 0 ? pickedList[0].path : null
  }

  function followCurrentItem(): void {
    const path = currentItemPath()
    if (path === panePath) return
    panePath = path
    pane.setItem(path)
  }

  function onSelectionChanged(): void {
    // A plain click (or the keyboard) moves the CURSOR: it is the selection, so
    // the picks collapse onto it. Ctrl/Shift clicks never reach here — they
    // consume the press and manage the picks themselves.
    const cursor = list.selected()
    picked.clear()
    if (cursor) {
      picked.add(cursor.path)
      pickAnchor = list.rows().findIndex((entry) => entry.path === cursor.path)
    }
    // A click in the listing names the file in save mode — the stock dialog's
    // behaviour, and the reason the accept path can then target it.
    if (isSave && cursor && !cursor.isDir && nameEntry.text !== cursor.name) {
      nameEntry.text = cursor.name
    }
    syncPickedVisuals()
    list.updateStatus()
    followCurrentItem()
  }

  // Select-all rides a CAPTURE-phase controller on the LISTING rather than the
  // window key table: GTK's list view claims Ctrl+A at its own node, so a
  // window-level binding would never see the chord (the path bar's entry uses
  // the same capture rule for Return).
  if (multiSelect) {
    const selectKeys = new Gtk.EventControllerKey()
    selectKeys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    selectKeys.connect("key-pressed", (_c, keyval: number, _code: number, state: number) => {
      if (keyval !== Gdk.KEY_a) return false
      if ((state & Gdk.ModifierType.CONTROL_MASK) === 0) return false
      if ((state & Gdk.ModifierType.SHIFT_MASK) !== 0) return false
      selectAll()
      return true
    })
    list.view.add_controller(selectKeys)
  }

  // ── navigation ──

  function activateEntry(entry: DirEntry): void {
    if (entry.isDir) {
      list.navigate(entry.path)
      return
    }
    if (isSave) {
      // A file row names the target; the accept action then confirms it.
      nameEntry.text = entry.name
      followCurrentItem()
      return
    }
    tryAccept()
  }

  /** Show a directory: the path bar follows it, the error line clears and the
   *  listing re-enumerates. The history is the listing's own. */
  function showDir(target: string): void {
    state.path = target
    pathBar.setPath(target)
    setError(null)
    reload()
  }

  function reload(): void {
    if (state.destroyed) return
    state.gen++
    const gen = state.gen
    if (state.cancel) state.cancel.cancel()
    const cancel = new Gio.Cancellable()
    state.cancel = cancel
    if (state.monitor) {
      state.monitor.cancel()
      state.monitor = null
    }
    mimeCache.clear()
    listDirAsync(state.path, cancel)
      .then((result) => {
        if (state.destroyed || gen !== state.gen) return // stale result
        if (!result.ok) {
          state.items = []
          setError(result.error ?? "cannot read this folder")
          render()
          return
        }
        state.items = result.items ?? []
        list.setFreeSpace(freeSpace(state.path))
        render()
        state.monitor = monitorDir(state.path, () => {
          if (state.debounceId !== null) GLib.source_remove(state.debounceId)
          state.debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            state.debounceId = null
            reload()
            return GLib.SOURCE_REMOVE
          })
        })
      })
      .catch((e) => {
        if (state.destroyed || gen !== state.gen) return
        setError(String(e))
        render()
      })
  }

  function toggleHidden(): void {
    state.hidden = !state.hidden
    list.setHiddenVisual(state.hidden)
    render() // live re-filter from the cached listing — no re-enumeration
  }

  function selectAll(): void {
    if (!multiSelect) return
    picked.clear()
    for (const entry of list.rows()) picked.add(entry.path)
    syncPickedVisuals()
    list.updateStatus()
    followCurrentItem()
  }

  // ── render ──

  function matchesFilter(entry: DirEntry): boolean {
    // Folders always show: a filter narrows FILES, or a filtered dialog could
    // not be navigated.
    if (entry.isDir) return true
    if (!activeFilter) return true
    if (activeFilter.globs.length === 0 && activeFilter.mimes.length === 0) return true
    for (const glob of activeFilter.globs) {
      if (glob.test(entry.name)) return true
    }
    if (activeFilter.mimes.length > 0) {
      let type = mimeCache.get(entry.path)
      if (type === undefined) {
        try {
          const [guessed] = Gio.content_type_guess(entry.path, null) as unknown as [string, boolean]
          type = guessed ?? ""
        } catch {
          type = ""
        }
        mimeCache.set(entry.path, type)
      }
      for (const mime of activeFilter.mimes) {
        if (mime === type) return true
        if (mime.endsWith("/*") && type.startsWith(`${mime.slice(0, -1)}`)) return true
      }
    }
    return false
  }

  function render(): void {
    if (state.destroyed) return
    const visible = state.items.filter((e) => {
      if (selectFolder && !e.isDir) return false
      if (!state.hidden && e.hidden) return false
      return matchesFilter(e)
    })
    list.setRows(visible)
    if (pendingSelect) {
      const rows = list.rows()
      const index = rows.findIndex((entry) => entry.path === pendingSelect)
      if (index >= 0) {
        pendingSelect = null
        try {
          list.selection.select_item(index, true)
          list.view.scroll_to(index, null, Gtk.ListScrollFlags.NONE, null)
        } catch (e) {
          ignore("chooser preselection", e)
        }
      } else if (rows.length > 0) {
        // The listing answered and the caller's file is not in it — the
        // suggestion is spent (a stale path must not keep re-selecting).
        pendingSelect = null
      }
    }
    list.updateStatus()
    followCurrentItem()
  }

  // ── status / errors ──

  function setError(msg: string | null): void {
    state.error = msg
    if (msg) log(`[chooser] ${msg}`)
    list.updateStatus()
  }

  // ── accept / URIs ──

  /** The save target: the typed name resolved against the current folder. A
   *  name holding "/" is refused by tryAccept, so this can compose freely. */
  function saveTargetPath(): string | null {
    const name = nameEntry.text.trim()
    if (!name) return null
    return GLib.build_filenamev([state.path, name])
  }

  function collectUris(): string[] {
    if (selectFolder) return [Gio.File.new_for_path(state.path).get_uri()]
    if (kind === "save-many" && saveNames.length > 0) {
      return saveNames.map((name) =>
        Gio.File.new_for_path(GLib.build_filenamev([state.path, name])).get_uri(),
      )
    }
    if (kind === "save") {
      const target = saveTargetPath()
      return target ? [Gio.File.new_for_path(target).get_uri()] : []
    }
    const selected = pickedEntries()
    return selected.map((entry) => Gio.File.new_for_path(entry.path).get_uri())
  }

  function alertMessage(msg: string): void {
    const a = new Gtk.AlertDialog({ message: msg, buttons: ["OK"] })
    a.set_default_button(0)
    a.choose(win, null, () => {})
  }

  function confirmOverwrite(target: Gio.File, onReplace: () => void, detail?: string): void {
    const a = new Gtk.AlertDialog({
      message: `A file named "${target.get_basename()}" already exists.`,
      detail: detail ?? "Do you want to replace it?",
      buttons: ["Cancel", "Replace"],
    })
    a.set_cancel_button(0)
    a.set_default_button(0)
    a.choose(win, null, (dialog: Gtk.AlertDialog | null, result: Gio.AsyncResult) => {
      try {
        if (dialog && dialog.choose_finish(result) === 1) onReplace()
      } catch (_err) {
        /* user cancelled the confirm — stay in the chooser */
        void _err
      }
    })
  }

  /** True when the accept action can proceed. Reports through alerts and the
   *  status bar otherwise, and never replies. */
  function tryAccept(): boolean {
    if (selectFolder) {
      respond(0, collectUris())
      return true
    }
    if (kind === "open") {
      const selected = pickedEntries()
      if (selected.length === 0) {
        alertMessage(multiSelect ? "Please select at least one file." : "Please select a file.")
        return true
      }
      respond(0, collectUris())
      return true
    }
    // save / save-many
    if (kind === "save-many" && saveNames.length > 0) {
      const folder = Gio.File.new_for_path(state.path)
      const clashes = saveNames.filter((name) => folder.get_child(name).query_exists(null))
      if (clashes.length > 0) {
        // The spec leaves name collisions to the implementation; asking once
        // beats silently replacing the user's files.
        confirmOverwrite(
          folder.get_child(clashes[0]),
          () => respond(0, collectUris()),
          clashes.length === 1
            ? undefined
            : `${clashes.length} of the ${saveNames.length} files already exist. Replace them?`,
        )
        return true
      }
      respond(0, collectUris())
      return true
    }
    const name = nameEntry.text.trim()
    if (!name) {
      alertMessage("Please enter a file name.")
      return true
    }
    if (name.includes("/")) {
      alertMessage("A file name cannot contain a slash.")
      return true
    }
    const target = Gio.File.new_for_path(GLib.build_filenamev([state.path, name]))
    if (target.query_exists(null)) {
      const info = target.query_info("standard::type", Gio.FileQueryInfoFlags.NONE, null)
      if (info && info.get_file_type() === Gio.FileType.DIRECTORY) {
        // A folder name in the entry is a navigation, the way the stock dialog
        // treats it — saving a folder path is never what the user meant.
        list.navigate(target.get_path() ?? state.path)
        return true
      }
      confirmOverwrite(target, () => respond(0, collectUris()))
      return true
    }
    respond(0, collectUris())
    return true
  }

  // ── response machinery: exactly once on every path ──
  let responded = false
  let destroyed = false
  let cleaned = false

  /** Release every resource this window owns: the monitor, the debounce, the
   *  cancel, the switch subscription and the pane's decoded still. Idempotent. */
  function cleanup(): void {
    if (cleaned) return
    cleaned = true
    state.destroyed = true
    state.gen++
    if (state.debounceId !== null) {
      GLib.source_remove(state.debounceId)
      state.debounceId = null
    }
    if (state.cancel) state.cancel.cancel()
    if (state.monitor) state.monitor.cancel()
    list.dispose()
    session.dispose()
    detachDivider()
    pane.dispose()
  }
  let onResponseCb: ((code: number, uris: string[]) => void) | null = null
  win.connect("destroy", () => {
    destroyed = true
    // Backstop: no path may destroy the window without replying. Without this a
    // teardown that throws between the accept path and the callback leaves the
    // calling application waiting forever on a dialog that no longer exists.
    respond(2, [])
    cleanup()
  })

  function respond(code: number, uris: string[]): void {
    if (responded) return
    responded = true
    // Reply FIRST: the callback is what ends the caller's wait, so nothing that
    // can throw may run before it. Cleanup and destroy follow, each guarded, so
    // an exception in either can no longer leave the request unanswered — a
    // caller left waiting is a hung Firefox or VSCode, not a stuck dialog.
    try {
      log(`reply ${code} (${uris.length} uri, ${kind})`)
      if (onResponseCb) onResponseCb(code, uris)
    } catch (e) {
      log(`reply callback failed: ${(e as Error).message}`)
    }
    try {
      cleanup()
    } catch (e) {
      log(`cleanup failed: ${(e as Error).message}`)
    }
    try {
      if (!destroyed) win.destroy()
    } catch (e) {
      log(`destroy failed: ${(e as Error).message}`)
    }
  }

  win.connect("close-request", () => {
    respond(1, [])
    return false
  })

  btnCancel.connect("clicked", () => respond(1, []))
  btnAccept.connect("clicked", () => tryAccept())
  btnBack.connect("clicked", () => list.back())
  btnFwd.connect("clicked", () => list.forward())
  btnUp.connect("clicked", () => list.up())
  btnHidden.connect("clicked", () => toggleHidden())
  btnReload.connect("clicked", () => reload())

  btnPreview.connect("clicked", () => session.toggle())

  // Keep the header's controls honest about what the window can do.
  btnBack.set_sensitive(false)
  btnFwd.set_sensitive(false)
  const syncHeader = () => {
    btnBack.set_sensitive(list.canGoBack())
    btnFwd.set_sensitive(list.canGoForward())
  }
  // ONE subscription per window: this dialog's own switch flip (the header
  // glyph, a divider fold), the shared width/mode a drag in either host wrote,
  // and the header's back/forward sensitivity. Dropped by session.dispose().
  session.subscribe(() => {
    const on = session.enabled()
    pane.widget.set_visible(on)
    pane.setLayout("pane")
    btnPreview.label = on ? GLYPH.eye : GLYPH.eyeOff
    btnPreview.set_tooltip_text(on ? "hide the preview pane" : "show the preview pane")
    if (!on) {
      // A hidden pane holds no decoded still.
      panePath = null
      pane.setItem(null)
    } else {
      followCurrentItem()
    }
    syncHeader()
  })
  const onSession = session.enabled()
  pane.widget.set_visible(onSession)
  pane.setLayout("pane")
  btnPreview.label = onSession ? GLYPH.eye : GLYPH.eyeOff
  btnPreview.set_tooltip_text(onSession ? "hide the preview pane" : "show the preview pane")

  // Start where the caller asked: its folder, else the file's folder, else home.
  const startFolder =
    opts.currentFolder && GLib.file_test(opts.currentFolder, GLib.FileTest.IS_DIR)
      ? opts.currentFolder
      : opts.currentFile
        ? GLib.path_get_dirname(absolutePath(opts.currentFile))
        : GLib.get_home_dir()
  list.navigate(startFolder, { push: false })
  syncHeader()

  // Focus the control the mode is about: the name in a save dialog, the listing
  // otherwise (grab_focus before map is a no-op — notes GOTCHA 9).
  win.connect("map", () => {
    if (isSave) nameEntry.grab_focus()
    else list.view.grab_focus()
  })

  return {
    win,
    get onResponse() {
      return onResponseCb
    },
    set onResponse(cb) {
      onResponseCb = cb
    },
    close() {
      respond(1, [])
    },
    present() {
      frame.present()
    },
    destroy() {
      if (!destroyed) win.destroy()
    },
  }
}
