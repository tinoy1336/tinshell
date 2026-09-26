/**
 * files browser windows — one plain XDG Gtk.Window per open browser (NOT
 * layer-shell, so Hyprland's window rules apply: float + rounding via the
 * `files-float` rule, generic SUPER+RMB resize, etc.).
 *
 * MULTI-WINDOW: `browsers` is the registry and every entry owns its widgets,
 * state and teardown — there is no shared window handle. `files open`
 * surfaces the window a request acts on (compositor-activated else newest),
 * creating one only when none is open; `files new` and the header's
 * new-window button always add another.
 *
 * Layout: header (back/forward/up · path bar · new folder/new window ·
 * hidden/preview/reload) / body
 * (Gtk.ColumnView over a Gio.ListStore behind a Gtk.SingleSelection) /
 * status bar (count + selection + free space, also the error line).
 *
 * Keyboard (window-level backstop, installed by the frame for the keys the
 * ColumnView's own controller does not consume — it handles Return/arrow/
 * Home/End/PageUp/PageDown natively):
 *   Enter/double-click open · Backspace/Alt+Up parent · Alt+Left/Right
 *   history · Ctrl+H hidden · Ctrl+R reload · Ctrl+N new folder ·
 *   Ctrl+Shift+N new window · Ctrl+L type a path (the path bar's edit mode) ·
 *   Delete trash. F2 rename is v2.
 *
 * Focus on `map`, not creation (notes GOTCHA 9) — grab_focus before map is
 * a no-op and keyboard input goes nowhere.
 */

import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Gtk from "gi://Gtk?version=4.0"
import { scheduleUnload } from "@common/app/lazy"
import { type CardDirList, createCardDirList, HIDDEN_TOGGLE } from "@common/card/dir-list"
import { type CardFrame, createCardFrame } from "@common/card/frame"
import { createCardHeader, GLYPH, headerButton } from "@common/card/header"
import { createCardPathBar } from "@common/card/path-bar"
import { b64encode } from "@common/fs/bytes"
import { ignore, log } from "@common/log/logger"
import { isStillImage } from "@common/media/classify"
import { attachPaneDivider } from "@common/media/divider"
import { createPreviewSession } from "@common/media/preview"
import { run } from "@common/subprocess/run"
import { get as getConfig, store } from "./config"
import {
  absolutePath,
  checkDir,
  compareEntries,
  type DirEntry,
  deleteSync,
  formatBytes,
  formatDate,
  freeSpace,
  glyphFor,
  listDirAsync,
  mkdirSync,
  monitorDir,
  type OpResult,
  openWithDefault,
  renameSync,
  type SortKey,
  trashSync,
} from "./fs"
import { FILES_APP_ID } from "./identity"
import { createPreview } from "./preview"
import { setShowHidden, showHidden } from "./state"

/** List row object — plain GObject for Gio.ListStore (the DirEntry rides on
 *  a plain JS field; no ParamSpecs needed since binds read it directly). */
const FileRow = GObject.registerClass({ GTypeName: "FilesRow" }, class extends GObject.Object {})

interface BrowserHandle {
  frame: CardFrame
  path: string
  navigate(path: string): void
  back(): void
  forward(): void
  up(): void
  reload(): void
  toggleHidden(): string
  mkdir(name: string): OpResult
  renameSelected(newName: string): OpResult
  trashSelected(): void
  reveal(target: string): OpResult
  /** Re-render from the cached listing (live-tier `config set` path). */
  refresh(): void
  /** Per-window cleanup + handle drop. Idempotent; runs on EVERY close path
   *  (close-request, `files close`, shell unmount). */
  teardown(): void
}

// ── glyphs: shared MDI codepoints live in common/card/header (GLYPH) ──

/** New-window action: two stacked windows with a plus — distinct from the
 *  new-folder folder_plus next to it in the header. */
const NEW_WINDOW = "\u{f0334}" // md-plus_box_multiple

/** The router (`tinshell-route`, shell-first), NOT `ags -i <app>`: in production
 *  promptd and media are hosted by the shell instance and no `<app>` bus name
 *  exists, so a direct instance call answers `instance "<app>" is not
 *  runnning` and the action silently no-ops (the notes save-as rule). The
 *  ABSOLUTE path is deliberate — a non-interactive process has no ~/.local/bin
 *  on PATH, and the router forwards the reply on stdout. */
const ROUTER = GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin", "tinshell-route"])

// ── window registry ──

/** Open browser windows, oldest first. Each entry owns its own widgets, state
 *  and teardown; a closing window leaves this list from its `teardown()`
 *  BEFORE it is destroyed, so no request can reach a destroyed window (the
 *  zombie shape — GOTCHA 15). */
const browsers: BrowserHandle[] = []

/** The window per-window requests act on: the compositor-activated one
 *  (`notify::is-active`, wired per window), else the newest. */
let lastFocused: BrowserHandle | null = null

function activeBrowser(): BrowserHandle | null {
  return lastFocused ?? browsers[browsers.length - 1] ?? null
}

/** The window a per-window request acts on (null when none is open). */
export function getBrowser(): BrowserHandle | null {
  return activeBrowser()
}

/** Make `b` the request target (called on present and on compositor
 *  activation). */
function focus(b: BrowserHandle): void {
  lastFocused = b
}

/** Open (warm: focus + navigate) or create the window at `path` (default:
 *  the startup dir). `files open` semantics: an existing browser is surfaced,
 *  never duplicated — another window comes from `files new` or the header's
 *  new-window button. Cold-start argv arrives via run.sh → main → openPath,
 *  so the app must NOT also issue a bus request on cold start (double-open). */
export function openPath(path?: string): void {
  const target = path ? absolutePath(path) : startupDir()
  const existing = activeBrowser()
  if (existing) {
    existing.frame.present()
    focus(existing)
    if (existing.path !== target) existing.navigate(target)
    return
  }
  createBrowserWindow(target)
}

/** Always create another independent browser window (`files new`). */
export function newBrowserWindow(path?: string): void {
  createBrowserWindow(path ? absolutePath(path) : startupDir())
}

/** Close the window a request acts on (`files close`). False when none is
 *  open, so the handler can reply `error: no window`. */
export function closeActiveBrowser(): boolean {
  const b = activeBrowser()
  if (!b) return false
  b.frame.close()
  return true
}

/** Close EVERY open window — the shell lazy-unload hook (mount.ts `unmount`)
 *  and the island's onQuit. Each close runs that window's own teardown (drops
 *  its handle, arms the unload grace once the last one is gone) and only then
 *  destroys the window (see the teardown note in createBrowserWindow). */
export function destroyBrowser(): void {
  for (const b of [...browsers]) b.frame.close()
}

/** Live-tier `config set` refresh — every open window, not just the active
 *  one, so columns and hidden filtering cannot drift between windows. */
export function refreshBrowsers(): void {
  for (const b of browsers) b.refresh()
}

function startupDir(): string {
  const p = getConfig("startup.dir")
  return absolutePath(p || "~")
}

function createBrowserWindow(startPath: string): BrowserHandle {
  // The hidden filter is NOT here: it is state (./state), like the preview
  // switch — the view block holds the preferences only.
  const viewCfg = () =>
    getConfig("view") as {
      sortDirsFirst: boolean
      showSize: boolean
      showModified: boolean
    }
  const trashCfg = () => getConfig("trash") as { useTrash: boolean; confirm: boolean }

  // ── state (all per-window) ──
  const state = {
    path: startPath,
    items: [] as DirEntry[], // raw listing (hidden included — filtered at render)
    error: null as string | null,
    gen: 0, // stale-enumeration guard
    cancel: null as Gio.Cancellable | null,
    monitor: null as ReturnType<typeof monitorDir> | null,
    debounceId: null as number | null,
    destroyed: false,
    pendingReveal: null as string | null,
  }

  // ── widgets ──
  const pathBar = createCardPathBar({
    onNavigate: (path) => list.navigate(path),
    onCommit: (text) => list.commitTypedPath(text),
  })

  const btnBack = headerButton(GLYPH.back, "back (Alt+Left)")
  const btnFwd = headerButton(GLYPH.fwd, "forward (Alt+Right)")
  const btnUp = headerButton(GLYPH.up, "parent directory (Backspace / Alt+Up)")
  const btnNewFolder = headerButton(GLYPH.newFolder, "new folder (Ctrl+N)")
  const btnNewWindow = headerButton(NEW_WINDOW, "new window (Ctrl+Shift+N)")
  const btnHidden = headerButton(HIDDEN_TOGGLE.show, "show hidden files (Ctrl+H)")
  const btnPreview = headerButton(GLYPH.eyeOff, "show the preview pane")
  const btnReload = headerButton(GLYPH.reload, "reload (Ctrl+R)")

  const header = createCardHeader({
    leading: [btnBack, btnFwd, btnUp],
    title: pathBar.widget,
    trailing: [btnNewFolder, btnNewWindow, btnHidden, btnPreview, btnReload],
  })

  /** Key-binding adapter: run the action, then report the press consumed. */
  const consume = (action: () => void) => () => {
    action()
    return true
  }

  const frame = createCardFrame({
    app: "files",
    appId: FILES_APP_ID, // app id matched by the files-float generated compositor rule
    title: "files",
    defaultWidth: getConfig("window.width"),
    defaultHeight: getConfig("window.height"),
    header,
    // Window-level key backstop — the keys the ColumnView does not consume
    // natively (its own controller handles Return/arrows/Home/End/Page*).
    keys: {
      bindings: [
        { key: Gdk.KEY_h, ctrl: true, run: consume(toggleHidden) },
        { key: Gdk.KEY_r, ctrl: true, run: consume(reload) },
        // shift:false keeps the two Ctrl+N chords apart: an omitted modifier
        // flag is not tested at all and the first match wins, so a bare
        // ctrl:true binding would also swallow Ctrl+Shift+N. The chord binds
        // BOTH keyval spellings: a shifted press arrives as the SHIFTED keyval
        // (Ctrl+Shift+N = KEY_N), while CapsLock delivers KEY_n with Shift
        // still held (annotate's Ctrl+Shift+S/Z rule).
        { key: Gdk.KEY_n, ctrl: true, shift: false, run: consume(promptNewFolder) },
        { key: Gdk.KEY_n, ctrl: true, shift: true, run: consume(newWindow) },
        { key: Gdk.KEY_N, ctrl: true, shift: true, run: consume(newWindow) },
        { key: Gdk.KEY_l, ctrl: true, run: consume(() => pathBar.beginEdit()) },
        { key: Gdk.KEY_BackSpace, ctrl: false, alt: false, run: consume(() => list.up()) },
        { key: Gdk.KEY_Up, alt: true, run: consume(() => list.up()) },
        { key: Gdk.KEY_Left, alt: true, run: consume(() => list.back()) },
        { key: Gdk.KEY_Right, alt: true, run: consume(() => list.forward()) },
        { key: Gdk.KEY_Delete, ctrl: false, alt: false, run: consume(trashSelected) },
        // Full-pane mode hides the list, which is where the ColumnView's own
        // keynav lives — these two are the backstop for it and report the press
        // UNCONSUMED (false) whenever the list is on screen, so the key table
        // behaves exactly as it did before the pane existed.
        { key: Gdk.KEY_Down, ctrl: false, alt: false, run: () => stepSelection(1) },
        { key: Gdk.KEY_Up, ctrl: false, alt: false, run: () => stepSelection(-1) },
        // Enter: the ColumnView's activate-item action opens activatable rows
        // first, so this binding only fires when the view did not consume it —
        // and it must report that honestly to stay a backstop.
        { key: Gdk.KEY_Return, ctrl: false, alt: false, run: openSelected },
        { key: Gdk.KEY_KP_Enter, ctrl: false, alt: false, run: openSelected },
      ],
    },
  })
  const root = frame.root

  // body — the shared card listing (common/card/dir-list) beside the optional
  // preview pane. The listing owns the ColumnView over its row store, the
  // name/size/modified columns and their sorters, the hidden-entries toggle's
  // glyphs, the status line and the navigation history; this window owns the
  // rows, the order policy and what activating a row does.
  const list: CardDirList<DirEntry, SortKey> = createCardDirList<DirEntry, SortKey>({
    cssPrefix: "files",
    rowType: FileRow,
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
    // The listing's order policy (fs.ts compareEntries) — the SAME comparison
    // the render order and every column sorter runs, so a header click cannot
    // disagree with the order on screen.
    compare: (a, b, order) => compareEntries(a, b, order, viewCfg().sortDirsFirst),
    onActivate: openRow,
    onOrderChanged: () => render(),
    onSelectionChanged: () => {
      // The status line and the pane follow THIS window's selection; the
      // listing only reports the move (one repaint per cursor move).
      list.updateStatus()
      preview.follow(list.selected())
    },
    status: {
      lead: () => {
        const sel = list.selected()
        return sel ? sel.displayName + (sel.isDir ? "/" : "") : null
      },
      error: () => state.error,
      formatBytes,
    },
    hiddenButton: btnHidden,
    // The size/modified columns come and go with the LIVE config; the name
    // column is always on screen.
    visibleColumns: () => {
      const v = viewCfg()
      const keys: SortKey[] = ["name"]
      if (v.showSize) keys.push("size")
      if (v.showModified) keys.push("modified")
      return keys
    },
    nav: {
      show: setPath,
      currentPath: () => state.path,
      resolvePath: absolutePath,
      checkPath: checkDir,
      checkErrorText: "cannot open directory",
      reportError: setError,
    },
  })

  // body — the list area plus the optional preview pane. The default layout
  // (preview disabled) is the list area alone, so the body row is transparent
  // to it: two boxes with no spacing or margin change nothing about how the
  // scroller and the empty label share the window.
  // A split, not a box: the divider is the pane's grab handle, and where it is
  // left is written into the shared preview width, so the number is the same in
  // the portal chooser and survives a restart. The pane carries only a minimum
  // size request — the paned position is the width.
  const body = new Gtk.Paned({
    orientation: Gtk.Orientation.HORIZONTAL,
    hexpand: true,
    vexpand: true,
  })
  // THIS window's preview switch: seeded from the stored last-applied value,
  // flipped by the header glyph and by a divider fold, and never moved by
  // another window's flip.
  const previewSession = createPreviewSession()
  const preview = createPreview({ list: list.area, onOpen: openRow, session: previewSession })
  body.set_start_child(list.area)
  body.set_end_child(preview.widget)
  const detachDivider = attachPaneDivider({
    paned: body,
    pane: preview.widget,
    display: frame.win,
    session: previewSession,
  })
  root.append(body)

  // status bar (also the error line)
  root.append(list.status.widget)

  // ── header state ──

  function updateHeader(): void {
    btnBack.set_sensitive(list.canGoBack())
    btnFwd.set_sensitive(list.canGoForward())
    list.setHiddenVisual(showHidden())
    // The preview switch is THIS window's own (common/media/preview's session)
    // — the stored value only decides what a new window starts with.
    const preview = previewSession.enabled()
    btnPreview.label = preview ? GLYPH.eye : GLYPH.eyeOff
    btnPreview.set_tooltip_text(preview ? "hide the preview pane" : "show the preview pane")
  }

  // ── status / errors ──

  function setError(msg: string | null): void {
    state.error = msg
    if (msg) log(`[files] ${msg}`)
    list.updateStatus()
  }

  // ── render ──

  function render(): void {
    if (state.destroyed) return
    // The pane's slot/mode/width follow the shared preview preference, so every
    // render re-applies them before the listing is rebuilt.
    preview.sync()
    // Hidden filter is LIVE — filter at render from the cached listing, do NOT
    // re-enumerate on toggle. The listing orders what it is handed (this
    // window's own compare policy) and points the header's arrow at that order,
    // so a sort whose column the config just hid cannot disagree with the
    // listing.
    const visible = state.items.filter((e) => showHidden() || !e.hidden)

    // Remember the selection by path so a monitor-triggered reload keeps it.
    const prevPath = list.selected()?.path ?? null

    list.setRows(visible)
    pathBar.setPath(state.path)
    updateHeader()

    // restore selection: pendingReveal wins, then previous path, else first.
    const rows = list.rows()
    if (state.pendingReveal) {
      const idx = rows.findIndex((e) => e.path === state.pendingReveal)
      state.pendingReveal = null
      log(`[reveal] found ${idx} of ${rows.length} rows`)
      if (idx >= 0) {
        list.selection.selected = idx
        list.updateStatus()
        return
      }
    }
    if (prevPath) {
      const idx = rows.findIndex((e) => e.path === prevPath)
      if (idx >= 0) {
        list.selection.selected = idx
        list.updateStatus()
        return
      }
    }
    if (rows.length > 0) list.selection.selected = 0
    list.updateStatus()
  }

  // ── navigation / enumeration ──

  function reload(): void {
    const gen = ++state.gen
    if (state.cancel) state.cancel.cancel()
    state.cancel = new Gio.Cancellable()
    const dir = state.path
    const cancel = state.cancel
    void listDirAsync(dir, cancel).then((r) => {
      if (gen !== state.gen || state.destroyed) return // stale result — discard
      if (r.ok) {
        state.items = r.items ?? []
        state.error = null
      } else {
        state.items = []
        state.error = r.error ?? "cannot read directory"
      }
      render()
    })
  }

  function setPath(path: string): void {
    state.path = path
    state.gen++ // invalidate any in-flight enumeration
    if (state.cancel) state.cancel.cancel()
    if (state.monitor) {
      state.monitor.cancel()
      state.monitor = null
    }
    if (state.debounceId !== null) {
      GLib.source_remove(state.debounceId)
      state.debounceId = null
    }
    state.monitor = monitorDir(path, scheduleReload)
    list.setFreeSpace(freeSpace(path))
    frame.setTitle(path)
    reload()
  }

  function scheduleReload(): void {
    log(`[monitor] change in ${state.path} → scheduled reload`)
    if (state.debounceId !== null) GLib.source_remove(state.debounceId)
    state.debounceId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      getConfig("timing.reloadDebounceMs"),
      () => {
        state.debounceId = null
        reload()
        return GLib.SOURCE_REMOVE
      },
    )
  }

  // ── actions ──

  /** Window-level selection step for the FULL-pane mode, where the list is
   *  hidden and the ColumnView's own keynav is unreachable. Returns false
   *  whenever the list is on screen — the press then keeps propagating to the
   *  view exactly as it did before the pane existed. */
  function stepSelection(step: number): boolean {
    if (!preview.isFull()) return false
    const n = list.rows().length
    if (n === 0) return false
    const cur = list.selection.selected
    const next = Math.min(n - 1, Math.max(0, (cur >= n ? 0 : cur) + step))
    list.selection.selected = next
    return true
  }

  /** Enter on the selected row — the window-level backstop for the key the
   *  ColumnView's activate-item action handles on activatable rows. */
  function openSelected(): boolean {
    const sel = list.selected()
    if (!sel) return false
    openRow(sel)
    return true
  }

  function openRow(entry: DirEntry): void {
    if (entry.isDir) {
      list.navigate(entry.path)
      return
    }
    if (entry.isSymlink) {
      // Resolve the link target: dir symlink → navigate; else open.
      try {
        const t = Gio.File.new_for_path(entry.path).query_file_type(
          Gio.FileQueryInfoFlags.NONE,
          null,
        )
        if (t === Gio.FileType.DIRECTORY) {
          list.navigate(entry.path)
          return
        }
      } catch (e) {
        ignore("files symlink target query", e)
      }
    }
    // Images go to the suite's own viewer: the router finds a live host and
    // cold-starts one when nothing is up. xdg-open would hand them to the
    // browser, which is not a viewer (this machine has no image app).
    // ABSOLUTE router path: a non-interactive process has no ~/.local/bin on
    // PATH (the keybind-exec rule, in-process variant).
    if (isStillImage(entry.path)) {
      void run([ROUTER, "media", "open", entry.path]).then((r) => {
        if (r.exit !== 0) void openWithDefault(entry.path)
      })
      return
    }
    void openWithDefault(entry.path).then((r) => {
      if (!r.ok) setError(r.error ?? "no default application")
    })
  }

  function toggleHidden(): string {
    const next = !showHidden()
    setShowHidden(next)
    // Repaint EVERY window: the filter and the toggle glyph are one value, and
    // the state store has no change event — this call is what the config
    // store's listener used to reach. Live re-filter from the cached listing,
    // no re-enumeration.
    refreshBrowsers()
    return next ? "on" : "off"
  }

  function mkdir(name: string): OpResult {
    const clean = name.replace(/[/\0]/g, "").trim()
    if (!clean) return { ok: false, error: "invalid name" }
    const r = mkdirSync(GLib.build_filenamev([state.path, clean]))
    if (r.ok) reload()
    return r
  }

  function renameSelected(newName: string): OpResult {
    const sel = list.selected()
    if (!sel) return { ok: false, error: "nothing selected" }
    const r = renameSync(sel.path, newName)
    if (r.ok) reload()
    return r
  }

  function trashSelected(): void {
    const entry = list.selected()
    if (!entry) return
    const useTrash = trashCfg().useTrash

    const doIt = (): void => {
      const r = useTrash ? trashSync(entry.path) : deleteSync(entry.path)
      if (!r.ok) {
        setError(r.error ?? (useTrash ? "cannot trash" : "cannot delete"))
        return
      }
      reload()
    }

    if (!trashCfg().confirm) {
      doIt()
      return
    }
    void run([
      ROUTER,
      "promptd",
      "confirm " +
        b64encode(
          JSON.stringify({
            title: useTrash ? "Move to trash?" : "Delete permanently?",
            body: entry.displayName + (entry.isDir ? "/" : ""),
            okLabel: useTrash ? "Trash" : "Delete",
            cancelLabel: "Cancel",
          }),
        ),
      // No timeoutMs ON PURPOSE: this is the confirmation for a DESTRUCTIVE
      // operation — the prompt is modal and the user may take minutes to answer.
    ])
      .then((res) => {
        if (res.stdout.trim() === "ok") doIt()
      })
      // The prompt IS the confirmation, so a failed spawn means the operation
      // never ran: say so on the window's own error line instead of leaving an
      // unhandled rejection and a click that silently did nothing.
      .catch((e: Error) => {
        log(`[trash] prompt failed: ${e.message}`)
        setError(
          useTrash ? "cannot trash: confirm prompt failed" : "cannot delete: confirm prompt failed",
        )
      })
  }

  /** Another independent window on THIS window's directory — the header
   *  button and Ctrl+Shift+N. (`files new` without a path opens the startup
   *  dir instead, the way `files open` without one does.) */
  function newWindow(): void {
    newBrowserWindow(state.path)
  }

  function promptNewFolder(): void {
    void run([
      ROUTER,
      "promptd",
      "input " +
        b64encode(
          JSON.stringify({
            mode: "text",
            title: "new folder",
            body: `Create a folder in ${state.path}`,
            placeholder: "untitled folder",
          }),
        ),
      // No timeoutMs ON PURPOSE: a modal prompt waits for the user, however long
      // that takes (see trashSelected above).
    ])
      .then((res) => {
        const out = res.stdout.trim()
        if (!out || out.startsWith("error:")) return // cancelled → silent
        const r = mkdir(out)
        if (!r.ok) setError(r.error ?? "mkdir failed")
      })
      // A failed prompt means no folder was created: name it on the error line
      // (mkdir's own failures already go there) rather than swallowing it.
      .catch((e: Error) => {
        log(`[new-folder] prompt failed: ${e.message}`)
        setError("cannot create folder: prompt failed")
      })
  }

  function reveal(target: string): OpResult {
    const abs = absolutePath(target)
    const parent = GLib.path_get_dirname(abs)
    log(`[reveal] target=${abs} parent=${parent} current=${state.path}`)
    state.pendingReveal = abs
    if (state.path === parent) reload()
    else list.navigate(parent)
    return { ok: true }
  }

  // ── signals ──

  btnBack.connect("clicked", () => list.back())
  btnFwd.connect("clicked", () => list.forward())
  btnUp.connect("clicked", () => list.up())
  btnNewFolder.connect("clicked", () => promptNewFolder())
  btnNewWindow.connect("clicked", () => newWindow())
  btnHidden.connect("clicked", () => toggleHidden())
  btnPreview.connect("clicked", () => {
    // Flip THIS window; the session subscription below re-renders it (glyph +
    // layout). The write reaches the other hosts as geometry only — the switch
    // is per window.
    previewSession.toggle()
  })
  btnReload.connect("clicked", () => reload())

  // Keyboard backstop: the bindings live on the frame (see the keys option
  // above) — the ColumnView's own controller sees Return/arrows first.

  // Focus on map, not at creation (notes GOTCHA 9).
  frame.win.connect("map", () => list.view.grab_focus())

  // Live-tier config: re-render from cache when config.json is reloaded
  // (direct `config set` goes through refresh() via the command handler). The
  // snapshot covers every live key the window reacts to: the view block
  // re-renders the listing. The hidden filter is state (./state), not config,
  // so the toggle repaints the windows itself.
  const liveSnapshot = () => JSON.stringify(viewCfg())
  let lastLive = liveSnapshot()
  const offStore = store.onConfigChanged(() => {
    const s = liveSnapshot()
    if (s !== lastLive) {
      lastLive = s
      render()
    }
  })

  // The preview state this window reacts to: its OWN switch (a glyph click or a
  // divider fold — a fold lands here rather than through the store) plus every
  // shared preference change (the side-slot width a drag in either host wrote,
  // the pane mode). `render()` re-applies the pane layout and the toggle glyph,
  // and the explicit follow gives the newly shown pane its item in the same
  // turn.
  const offPreview = previewSession.subscribe(() => {
    render()
    preview.follow(list.selected())
  })

  // Every close path converges on teardown() + destroy. The window's own
  // `destroy` signal is NOT a usable cleanup hook: gjs keeps the Gtk.Window
  // alive through gtk_window_destroy (the JS handle holds a ref, so dispose
  // never runs) and the signal was observed to never fire. A handle left
  // behind then points at a DESTROYED window — the next open present()s it,
  // GTK re-shows it ("A window is shown after it has been destroyed…") and the
  // result is a ZOMBIE the compositor keeps mapped while no destroy() and no
  // close request can remove it. teardown() therefore drops this handle from
  // `browsers` BEFORE the destroy, on every close path.
  let torn = false
  function teardown(): void {
    if (torn) return
    torn = true
    offStore() // drop the store's closure over this window (leak across unload)
    offPreview() // same for this window's preview session
    previewSession.dispose()
    list.dispose()
    state.destroyed = true
    state.gen++
    preview.dispose() // drop the decoded still before the window goes
    if (state.cancel) state.cancel.cancel()
    if (state.monitor) state.monitor.cancel()
    if (state.debounceId !== null) GLib.source_remove(state.debounceId)
    detachDivider()
    // Drop this window from the registry BEFORE the destroy below: the other
    // windows stay open and fully usable, and no request can reach this one
    // again (see the registry note at the top of the file).
    const i = browsers.indexOf(handle)
    if (i >= 0) browsers.splice(i, 1)
    if (lastFocused === handle) lastFocused = browsers[browsers.length - 1] ?? null
    // Only the LAST window arms the shell's unload grace (no-op in islands).
    if (browsers.length === 0) scheduleUnload("files")
  }

  frame.win.connect("destroy", teardown) // backstop only — may never fire (see above)
  frame.win.connect("close-request", () => {
    teardown()
    frame.win.destroy()
    return true // the close is done here; never defer to the default handler
  })

  const handle: BrowserHandle = {
    frame,
    get path() {
      return state.path
    },
    navigate: (path) => list.navigate(absolutePath(path)),
    back: () => list.back(),
    forward: () => list.forward(),
    up: () => list.up(),
    reload,
    toggleHidden,
    mkdir,
    renameSelected,
    trashSelected,
    reveal,
    refresh() {
      render()
    },
    teardown,
  }

  // The request target follows the compositor's activation, so `files close`
  // and the path/selection commands act on the window the user last touched
  // rather than merely the newest one.
  frame.win.connect("notify::is-active", () => {
    if (frame.win.is_active) focus(handle)
  })

  setPath(startPath)
  browsers.push(handle)
  focus(handle)
  frame.present()
  return handle
}
