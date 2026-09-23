/**
 * common/card/dir-list.ts — the directory-listing scaffold of a card window:
 * the Gtk.ColumnView over a Gio.ListStore behind one Gtk.SingleSelection, its
 * scroller and empty-state label, the icon+name and meta cell factories, the
 * per-column sorters and the read-back that turns a header click into the
 * listing's order, the status/error line, the hidden-entries toggle's glyphs,
 * and the history and typed-path navigation helpers.
 *
 * The host keeps everything that is its own: the GObject row class it
 * registers, the columns and the text and glyph each cell shows, the order
 * policy, what activating a row does, what its status line leads with, and
 * where a directory is shown from. Both card listings in the home — the files
 * browser and the portal chooser — build through this factory.
 *
 * FIXED WORDING: the empty-state text ("empty folder" / "cannot read this
 * folder") and the hidden-entries toggle's tooltips are the listing's own
 * vocabulary, identical in every card listing — they are NOT options. Every
 * other visible string comes from the host: the columns' glyphs and text, the
 * status line's lead and error, the byte formatting.
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import { type CardStatusBar, createCardStatusBar } from "./status-bar"

/** The hidden-entries toggle's glyph pair: the preview toggle owns eye /
 *  eye-off, so two identical eyes in one header would name nothing. */
export const HIDDEN_TOGGLE = {
  hide: "\u{f179e}", // md-folder_hidden
  show: "\u{f178a}", // md-folder_eye
} as const

/** A listing row: the GObject the row store holds, carrying the host's entry.
 *  `GObject.registerClass` is what gives the row its GType — a bare
 *  `class extends GObject.Object` has none and `Gio.ListStore.new()` then
 *  throws "Tried to construct an object without a GType". */
interface CardListRow<TEntry> extends GObject.Object {
  entry: TEntry
}

/** The listing's order: the header's sort choice. */
interface CardSortOrder<TKey extends string> {
  key: TKey
  ascending: boolean
}

/** The icon+name column — the listing's identity cell, and the one column that
 *  is always on screen. */
interface CardListNameColumn<TEntry, TKey extends string> {
  /** The sort key this column reports to a header click. */
  key: TKey
  /** Header title. */
  title: string
  /** The cell's type glyph. */
  glyph(entry: TEntry): string
  /** The cell's text — the entry's display name. */
  label(entry: TEntry): string
  /** Entries that read as hidden: their glyph and name carry the listing's
   *  `<cssPrefix>-hidden` class. */
  hidden(entry: TEntry): boolean
}

/** A column beside the name column: one text cell per entry. */
interface CardListMetaColumn<TEntry, TKey extends string> {
  key: TKey
  title: string
  /** Right-align the cell (a size) or left-align it (a date). */
  align: "start" | "end"
  /** The cell's text. */
  text(entry: TEntry): string
}

/** What the status line shows, read fresh on every repaint. */
interface CardListStatus {
  /** The line's lead — what the host's selection means (a selected name, a
   *  picked count). Null when nothing is selected. */
  lead(): string | null
  /** The listing's error text (null when none): its own read failures and the
   *  host's operational errors. */
  error(): string | null
  /** The byte formatting of the free-space tail. */
  formatBytes(n: number): string
}

/** Where a directory is shown and how a typed path is gated. */
interface CardListNav {
  /** Show a directory: the host's own open — its monitor, its title, its
   *  listing. It is handed a RESOLVED path: a host whose entry points can
   *  receive raw text (a request token) resolves it there, before `navigate`,
   *  so the same-path test and the title cannot disagree with what is listed. */
  show(path: string): void
  /** The directory on screen. */
  currentPath(): string
  /** Resolve typed text into an absolute path. */
  resolvePath(text: string): string
  /** Gate a typed path (it exists and can be listed); a refusal answers the
   *  status line and keeps the path bar in edit mode. */
  checkPath(path: string): { ok: boolean; error?: string }
  /** The refusal text used when `checkPath` gives none. */
  checkErrorText: string
  /** Report a refusal (the host's own error reporter, the one that logs). */
  reportError(msg: string): void
  /** A navigate naming the directory already on screen: true re-lists it (the
   *  chooser — a crumb click there is a refresh), omitted leaves the listing
   *  untouched (the browser). */
  relistOnSamePath?: boolean
}

/** The host's own per-cell work, on top of what the factory paints: a pick
 *  gesture on the cell, a cell→entry-path registry, picked-row classes.
 *  `setup` runs once per cell (when the listItem builds its child), `bind` on
 *  every bind after the factory painted the cell, `unbind` when the listItem is
 *  recycled. */
interface CardListCellHooks<TEntry> {
  setup?(cell: Gtk.Widget): void
  bind?(cell: Gtk.Widget, entry: TEntry): void
  unbind?(cell: Gtk.Widget): void
}

interface CardDirListOptions<TEntry, TKey extends string> {
  /** CSS class prefix of the listing: `<prefix>-view`, `<prefix>-scroll`,
   *  `<prefix>-empty`, `<prefix>-icon`, `<prefix>-name`, `<prefix>-meta`,
   *  `<prefix>-hidden`. */
  cssPrefix: string
  /** The GObject row class the store holds — `GObject.registerClass`'s result.
   *  The factory instantiates one per entry and assigns `entry` before it is
   *  appended. */
  rowType: new (
    ...args: any[]
  ) => GObject.Object
  /** The icon+name column. */
  name: CardListNameColumn<TEntry, TKey>
  /** The columns after the name column, left to right. */
  meta: CardListMetaColumn<TEntry, TKey>[]
  /** The listing's order policy: the render order and the comparison every
   *  column sorter runs (a sorter passes its own column's key with the
   *  listing's current direction). */
  compare(a: TEntry, b: TEntry, order: CardSortOrder<TKey>): number
  /** A row was activated — Return on the view's activatable row, or a
   *  double-click. */
  onActivate(entry: TEntry): void
  /** The header changed the order: re-render, so the listing is in the order
   *  the arrow names. */
  onOrderChanged(): void
  /** The cursor moved — the host repaints what follows its selection (a preview
   *  pane, picked-row classes) AND the status line, through its own
   *  `updateStatus()` call: the factory reports the move only, so one cursor
   *  move repaints once. */
  onSelectionChanged(entry: TEntry | null): void
  /** The listing's status line. */
  status: CardListStatus
  /** The host's own per-cell work. */
  cells?: CardListCellHooks<TEntry>
  /** The hidden-entries toggle: the factory paints it, the host owns the switch
   *  (its config, or its own per-window state). */
  hiddenButton: Gtk.Button
  /** The keys currently on screen, when they can change with the host's live
   *  config; omitted, every column stays on screen. The name column is always
   *  among them. */
  visibleColumns?(): TKey[]
  /** The host's navigation. */
  nav: CardListNav
}

export interface CardDirList<TEntry, TKey extends string> {
  /** The listing's ColumnView. */
  view: Gtk.ColumnView
  /** The selection model: the cursor a plain click and the keyboard move. */
  selection: Gtk.SingleSelection
  /** The listing area — the scroller and the empty-state label in one vertical
   *  box, for the host's own body layout. */
  area: Gtk.Box
  /** The status line — the host appends `status.widget` to the frame root. */
  status: CardStatusBar
  /** Rebuild the listing from `entries` (the host's own filtered set): the rows
   *  are ordered into the current sort, one row object is appended per entry,
   *  and the empty-state label and the scroller's visibility follow. */
  setRows(entries: TEntry[]): void
  /** The rows the last `setRows` built, in the listing order. */
  rows(): TEntry[]
  /** The entry under the cursor (null when nothing is selected). */
  selected(): TEntry | null
  /** Repaint the status line: the error slot, the selection lead, the item
   *  count and the free space. */
  updateStatus(): void
  /** The free space the status line's tail shows (null: no tail). */
  setFreeSpace(fs: { free: number; total: number } | null): void
  /** Repaint the hidden-entries toggle for `hidden`. */
  setHiddenVisual(hidden: boolean): void
  /** Show `path`. `push: false` leaves the history alone — the directory a
   *  window opens on. A navigate naming the directory already on screen follows
   *  `CardListNav.relistOnSamePath`. */
  navigate(path: string, opts?: { push?: boolean }): void
  /** Back and forward through the visited directories. */
  back(): void
  forward(): void
  /** True while the back / forward history holds an entry — what the header's
   *  arrows read. */
  canGoBack(): boolean
  canGoForward(): boolean
  /** The parent directory (a no-op at the root). */
  up(): void
  /** Enter on the path bar's typed text: resolve it and navigate into it when
   *  the host's gate accepts it. A refusal lands on the status line and keeps
   *  the entry open, which is the false return. */
  commitTypedPath(text: string): boolean
  /** The listing is going away (an idempotent host teardown): the factory's own
   *  entry points stop. */
  dispose(): void
}

/** Build a card listing: its view, columns and sorters, scroller, empty-state
 *  label, status line and navigation history. */
export function createCardDirList<TEntry, TKey extends string>(
  opts: CardDirListOptions<TEntry, TKey>,
): CardDirList<TEntry, TKey> {
  const cls = (suffix: string) => `${opts.cssPrefix}-${suffix}`

  // ── the listing: ColumnView over a row store behind the cursor model ──
  // @ts-expect-error runtime accepts this argument shape (type-only gap: the
  // store declares a GType while gjs takes the registered class itself)
  const store = Gio.ListStore.new(opts.rowType)
  const selection = new Gtk.SingleSelection({ model: store, autoselect: false })
  const view = new Gtk.ColumnView({
    model: selection,
    single_click_activate: false,
    show_row_separators: false,
  })
  view.add_css_class(cls("view"))
  view.set_hexpand(true)
  view.set_vexpand(true)
  const scroll = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true })
  scroll.add_css_class(cls("scroll"))
  scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
  scroll.child = view

  const empty = new Gtk.Label({
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    hexpand: true,
    vexpand: true,
  })
  empty.add_css_class(cls("empty"))

  // The list area: the scroller and the empty label in one vertical box with no
  // spacing, so a host body that adds nothing beside them lays the listing out
  // exactly as a bare scroller did.
  const area = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    hexpand: true,
    vexpand: true,
  })
  area.append(scroll)
  area.append(empty)

  const status = createCardStatusBar()

  /** The entry a listItem holds (null while the item is recycled). The signal
   *  callback's own argument is not typed as the list item it is, so the access
   *  goes through a cast. */
  function entryOf(item: unknown): TEntry | null {
    const row = (item as Gtk.ListItem).item as CardListRow<TEntry> | null
    return row?.entry ?? null
  }

  // ── columns ──

  function makeNameColumn(): Gtk.ColumnViewColumn {
    const factory = Gtk.SignalListItemFactory.new()
    const cells = new Map<GObject.Object, { box: Gtk.Box; glyph: Gtk.Label; name: Gtk.Label }>()
    factory.connect("setup", (_f, listItem) => {
      const box = new Gtk.Box({ spacing: 10, hexpand: true })
      const glyph = new Gtk.Label({ halign: Gtk.Align.START, xalign: 0 })
      glyph.add_css_class(cls("icon"))
      const name = new Gtk.Label({
        halign: Gtk.Align.START,
        xalign: 0,
        hexpand: true,
        ellipsize: Pango.EllipsizeMode.END,
      })
      name.add_css_class(cls("name"))
      box.append(glyph)
      box.append(name)
      opts.cells?.setup?.(box)
      // @ts-expect-error @girs under-declares `child`; gjs provides it at runtime
      listItem.child = box
      // @ts-expect-error @girs under-declares `set_activatable`; gjs provides it at runtime
      listItem.set_activatable(true)
      cells.set(listItem, { box, glyph, name })
    })
    factory.connect("bind", (_f, listItem) => {
      const entry = entryOf(listItem)
      const cell = cells.get(listItem)
      if (!cell || entry === null) return
      cell.glyph.label = opts.name.glyph(entry)
      cell.name.label = opts.name.label(entry)
      const hidden = opts.name.hidden(entry)
      for (const label of [cell.glyph, cell.name]) {
        if (hidden) label.add_css_class(cls("hidden"))
        else label.remove_css_class(cls("hidden"))
      }
      opts.cells?.bind?.(cell.box, entry)
    })
    factory.connect("unbind", (_f, listItem) => {
      const cell = cells.get(listItem)
      if (cell) opts.cells?.unbind?.(cell.box)
    })
    return new Gtk.ColumnViewColumn({ title: opts.name.title, factory, expand: true })
  }

  function makeMetaColumn(meta: CardListMetaColumn<TEntry, TKey>): Gtk.ColumnViewColumn {
    const factory = Gtk.SignalListItemFactory.new()
    const cells = new Map<GObject.Object, Gtk.Label>()
    factory.connect("setup", (_f, listItem) => {
      const label = new Gtk.Label({
        halign: meta.align === "end" ? Gtk.Align.END : Gtk.Align.START,
        xalign: meta.align === "end" ? 1 : 0,
      })
      label.add_css_class(cls("meta"))
      opts.cells?.setup?.(label)
      // @ts-expect-error @girs under-declares `child`; gjs provides it at runtime
      listItem.child = label
      cells.set(listItem, label)
    })
    factory.connect("bind", (_f, listItem) => {
      const entry = entryOf(listItem)
      const label = cells.get(listItem)
      if (!label || entry === null) return
      label.label = meta.text(entry)
      opts.cells?.bind?.(label, entry)
    })
    factory.connect("unbind", (_f, listItem) => {
      const label = cells.get(listItem)
      if (label) opts.cells?.unbind?.(label)
    })
    return new Gtk.ColumnViewColumn({ title: meta.title, factory })
  }

  const columns = new Map<TKey, Gtk.ColumnViewColumn>()
  const colName = makeNameColumn()
  columns.set(opts.name.key, colName)
  for (const meta of opts.meta) columns.set(meta.key, makeMetaColumn(meta))

  /** The order the listing is in — the header's choice, name-ascending until a
   *  click names another column. */
  let order: CardSortOrder<TKey> = { key: opts.name.key, ascending: true }

  /** The sorter a header needs to be a sort control: GTK gives the header
   *  button and its indicator arrow only to a column that carries one. Its
   *  comparison is the host's own policy, with this column's key and the
   *  listing's current direction, so a header click cannot disagree with the
   *  order the host renders. */
  function columnSorter(key: TKey): Gtk.Sorter {
    return Gtk.CustomSorter.new((a: CardListRow<TEntry> | null, b: CardListRow<TEntry> | null) => {
      if (!a?.entry || !b?.entry) return 0
      return opts.compare(a.entry, b.entry, { key, ascending: order.ascending })
    })
  }

  /** The header's choice, read back from the VIEW's sorter: the primary sort
   *  column is the clicked one and a second click inverts it. The store keeps
   *  the order this listing computed, so the view's sorter is never attached to
   *  a sort model. */
  function applySortChoice(): void {
    const sorter = view.get_sorter() as Gtk.ColumnViewSorter | null
    if (!sorter) return
    const column = sorter.get_primary_sort_column()
    let key: TKey | null = null
    for (const [candidate, col] of columns) {
      if (col === column) key = candidate
    }
    if (key === null) return // no primary column — the listing keeps its order
    const ascending = sorter.get_primary_sort_order() === Gtk.SortType.ASCENDING
    if (key === order.key && ascending === order.ascending) return
    order = { key, ascending }
    opts.onOrderChanged()
  }

  for (const [key, col] of columns) col.set_sorter(columnSorter(key))
  // The name column is appended ONCE, here, and never removed — the column sync
  // skips its key, and it is the only removal site — so the view's sorter
  // exists from here on and the initial order is the one the arrow names.
  view.append_column(colName)
  view.get_sorter()?.connect("changed", applySortChoice)
  view.sort_by_column(colName, Gtk.SortType.ASCENDING)

  function hasColumn(col: Gtk.ColumnViewColumn): boolean {
    const cols = view.get_columns()
    for (let i = 0; i < cols.get_n_items(); i++) {
      if (cols.get_item(i) === col) return true
    }
    return false
  }

  /** The columns the host keeps on screen, the name column always among them. */
  function visibleKeys(): Set<TKey> {
    return new Set(opts.visibleColumns ? opts.visibleColumns() : [...columns.keys()])
  }

  /** Append the visible columns and remove the hidden ones — a column switched
   *  back on lands at the row's end, the order a Gtk.ColumnView appends in. An
   *  order whose column is no longer on screen falls back to the name column,
   *  keeping the direction, so the arrow always names the order the listing is
   *  in. */
  function syncColumns(): void {
    const keys = visibleKeys()
    if (!keys.has(order.key)) {
      order = { key: opts.name.key, ascending: order.ascending }
      view.sort_by_column(
        colName,
        order.ascending ? Gtk.SortType.ASCENDING : Gtk.SortType.DESCENDING,
      )
    }
    for (const [key, col] of columns) {
      if (key === opts.name.key) continue
      const onScreen = hasColumn(col)
      if (keys.has(key) && !onScreen) view.append_column(col)
      else if (!keys.has(key) && onScreen) view.remove_column(col)
    }
  }

  // ── rows and the status line ──

  let rows: TEntry[] = []
  let free: { free: number; total: number } | null = null

  function updateStatus(): void {
    const err = opts.status.error()
    if (err) {
      status.setText(`error: ${err}`)
      return
    }
    const parts: string[] = []
    const lead = opts.status.lead()
    if (lead) parts.push(lead)
    parts.push(`${rows.length} item${rows.length === 1 ? "" : "s"}`)
    if (free && free.total > 0) parts.push(`${opts.status.formatBytes(free.free)} free`)
    status.setText(parts.join("  ·  "))
  }

  function setRows(entries: TEntry[]): void {
    syncColumns()
    rows = [...entries].sort((a, b) => opts.compare(a, b, order))
    store.remove_all()
    for (const entry of rows) {
      const row = new opts.rowType() as CardListRow<TEntry>
      row.entry = entry
      store.append(row)
    }
    empty.label = opts.status.error() ? "cannot read this folder" : "empty folder"
    empty.set_visible(rows.length === 0)
    scroll.set_visible(rows.length > 0)
  }

  function selected(): TEntry | null {
    const row = selection.get_selected_item() as CardListRow<TEntry> | null
    return row?.entry ?? null
  }

  // ── navigation ──

  const backStack: string[] = []
  const fwdStack: string[] = []
  let disposed = false

  function navigate(path: string, navOpts: { push?: boolean } = {}): void {
    if (disposed) return
    const current = opts.nav.currentPath()
    if (path === current && !opts.nav.relistOnSamePath) return
    if (navOpts.push !== false) {
      if (path !== current && current) backStack.push(current)
      fwdStack.length = 0
    }
    opts.nav.show(path)
  }

  function back(): void {
    const target = backStack.pop()
    if (target === undefined) return
    fwdStack.push(opts.nav.currentPath())
    opts.nav.show(target)
  }

  function forward(): void {
    const target = fwdStack.pop()
    if (target === undefined) return
    backStack.push(opts.nav.currentPath())
    opts.nav.show(target)
  }

  function up(): void {
    const current = opts.nav.currentPath()
    const parent = GLib.path_get_dirname(current)
    if (parent === current) return // already at the root
    navigate(parent)
  }

  /** Enter on the path bar's typed text: the host resolves it and gates it, and
   *  only an accepted directory is shown. A refusal goes on the status line and
   *  leaves the entry open on the text, which is the false return. */
  function commitTypedPath(text: string): boolean {
    if (disposed) return false
    const target = opts.nav.resolvePath(text)
    const probe = opts.nav.checkPath(target)
    if (!probe.ok) {
      opts.nav.reportError(probe.error ?? opts.nav.checkErrorText)
      return false
    }
    navigate(target)
    return true
  }

  // ── signals ──

  view.connect("activate", (_v, position) => {
    const row = store.get_item(position) as CardListRow<TEntry> | null
    if (row?.entry) opts.onActivate(row.entry)
  })

  selection.connect("notify::selected", () => {
    // No repaint here — the host's hook owns it (see onSelectionChanged).
    opts.onSelectionChanged(selected())
  })

  return {
    view,
    selection,
    area,
    status,
    setRows,
    rows: () => rows,
    selected,
    updateStatus,
    setFreeSpace: (fs) => {
      free = fs
    },
    setHiddenVisual: (hidden) => {
      opts.hiddenButton.label = hidden ? HIDDEN_TOGGLE.hide : HIDDEN_TOGGLE.show
      opts.hiddenButton.set_tooltip_text(
        hidden ? "hide hidden files (Ctrl+H)" : "show hidden files (Ctrl+H)",
      )
    },
    navigate,
    back,
    forward,
    canGoBack: () => backStack.length > 0,
    canGoForward: () => fwdStack.length > 0,
    up,
    commitTypedPath,
    dispose: () => {
      disposed = true
    },
  }
}
