/**
 * common/card/path-bar.tsx — the segmented, editable path bar of the card
 * family (GTK4 has no Gtk.PathBar).
 *
 * Breadcrumb mode: one button per path segment, each navigating to its own
 * prefix, with a home glyph as the root segment and chevron separators between
 * segments. The scroller follows the tail of a long path: the segments are
 * rebuilt on every navigation, so the bar is scrolled to its end once layout
 * has settled.
 *
 * Edit mode: the entry replaces the breadcrumbs in the same row, pre-filled
 * with the current path, its text selected, the cursor at the end and the
 * focus on the entry. The host enters it through `beginEdit()` (its own
 * Ctrl+L binding) or by clicking the bar's empty tail right of the last
 * segment. The entry's own key controller resolves Return (the text goes to
 * the host's `onCommit`) and Escape (leave without navigating).
 *
 * Type-ahead: the entry carries the SAME inline Tab cycle every other path
 * entry in the home uses (`createPathAutofill` over @common/path/complete) —
 * a path-shaped text completes on Tab, Shift+Tab cycles back, the
 * non-committed ghost shows as a selection, and a `*`/`?` pattern in the last
 * segment previews that directory's matches (newest first), the chosen one
 * REPLACING the pattern with a concrete path. Gating the cycle on
 * `isPathShaped` is what keeps Tab working as plain focus navigation in an
 * entry holding an ordinary word.
 */
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import { ignore } from "@common/log/logger"
import { createPathAutofill } from "@common/path/autofill"
import { isPathShaped } from "@common/path/complete"
import { GLYPH } from "./header"

interface CardPathBarOptions {
  /** Called with the absolute target when a segment is activated. */
  onNavigate: (path: string) => void
  /** Called with the typed text when the entry is confirmed. Return true when
   *  the host took the path — the bar then leaves edit mode — and false to
   *  keep the entry, and its text, on screen for correction. */
  onCommit: (text: string) => boolean
}

interface CardPathBar {
  /** The bar — the header's title slot: the breadcrumbs, or the entry while
   *  edit mode is on. */
  widget: Gtk.Stack
  /** Rebuild the segments for `path` (absolute); in edit mode the rebuild is
   *  deferred to `endEdit`. */
  setPath: (path: string) => void
  /** Swap the breadcrumbs for the entry, pre-filled with the current path,
   *  text selected, cursor at the end, focus on the entry. */
  beginEdit: () => void
  /** Restore the breadcrumbs for the current path. */
  endEdit: () => void
}

/** The bar's two rows, as stack child names. */
const CRUMBS = "crumbs"
const ENTRY = "entry"

export function createCardPathBar(opts: CardPathBarOptions): CardPathBar {
  let segments!: Gtk.Box
  const scroller = (
    <scrolledwindow
      class="card-pathscroll"
      hexpand
      $={(ref) => {
        ref.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
      }}
    >
      <box
        class="card-pathbar"
        spacing={2}
        $={(ref) => {
          segments = ref
        }}
      />
    </scrolledwindow>
  ) as Gtk.ScrolledWindow

  const entry = new Gtk.Entry({ hexpand: true })
  entry.add_css_class("card-path-entry")

  // Path type-ahead for the typed text — the shared inline Tab cycle (see the
  // file header). One instance per bar: the cycle describes THIS entry's text
  // and dies with the edit session, so an aborted edit never seeds the next.
  const pathAutofill = createPathAutofill({
    extract: (t) => (isPathShaped(t) ? t.trim() : null),
  })
  entry.connect("changed", () => pathAutofill.onInput(entry.get_text()))

  // The two rows share one slot through a stack of two NON-homogeneous
  // children: the bar is the header's title slot in either mode, and while the
  // breadcrumbs are on screen the stack measures the scroller alone — the row
  // measures exactly what it measured before the entry existed.
  const stack = new Gtk.Stack()
  stack.set_hhomogeneous(false)
  stack.set_vhomogeneous(false)
  stack.set_hexpand(true)
  stack.add_named(scroller, CRUMBS)
  stack.add_named(entry, ENTRY)
  stack.set_visible_child_name(CRUMBS)

  /** The path the bar stands for — the entry's pre-fill and the directory the
   *  breadcrumbs return to. */
  let currentPath = ""
  /** A setPath while the entry is on screen defers its rebuild to the exit. */
  let crumbsStale = false
  let editing = false
  /** Set from `beginEdit`, consumed on the entry's map (see there). */
  let focusPending = false

  function pushSegment(label: string, target: string, last: boolean): void {
    const b = new Gtk.Button({ label })
    b.add_css_class("card-path-btn")
    if (last) b.add_css_class("card-path-btn-current")
    b.set_tooltip_text(target)
    b.connect("clicked", () => opts.onNavigate(target))
    segments.append(b)
  }

  function pushSeparator(): void {
    const s = new Gtk.Label({ label: GLYPH.chevron })
    s.add_css_class("card-sep")
    segments.append(s)
  }

  function buildSegments(path: string): void {
    let child = segments.get_first_child()
    while (child) {
      const next = child.get_next_sibling()
      segments.remove(child)
      child = next
    }

    if (path === "/") {
      pushSegment(GLYPH.home, "/", true)
    } else {
      pushSegment(GLYPH.home, "/", false)
      let acc = ""
      const parts = path.split("/").filter(Boolean)
      parts.forEach((part, i) => {
        acc += `/${part}`
        pushSeparator()
        pushSegment(part, acc, i === parts.length - 1)
      })
    }

    // Scroll the bar to the end after layout.
    const adj = scroller.get_hadjustment()
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      adj.set_value(adj.get_upper())
      return GLib.SOURCE_REMOVE
    })
  }

  function setPath(path: string): void {
    currentPath = path
    if (editing) {
      // The entry owns the row: what it hides is rebuilt when it goes away, so
      // the breadcrumbs that return always describe the current directory —
      // a directory left behind by an external change included.
      crumbsStale = true
      return
    }
    buildSegments(path)
  }

  function endEdit(): void {
    if (!editing) return
    editing = false
    pathAutofill.reset()
    if (crumbsStale) {
      crumbsStale = false
      buildSegments(currentPath)
    }
    stack.set_visible_child_name(CRUMBS)
  }

  function beginEdit(): void {
    if (editing) {
      entry.grab_focus()
      entry.select_region(0, -1)
      return
    }
    editing = true
    // reset before the fill: the pre-filled path is a fresh starting point,
    // never a continuation of the previous edit's cycle.
    pathAutofill.reset()
    entry.set_text(currentPath)
    // grab_focus before the stack shows the row is a no-op — the focus and the
    // selection land on the entry's map.
    focusPending = true
    stack.set_visible_child_name(ENTRY)
  }

  entry.connect("map", () => {
    if (!focusPending) return
    focusPending = false
    entry.grab_focus()
    // select_region selects the whole path AND leaves the cursor at the end of
    // the selection: typing replaces the path, Left/Right collapse onto it.
    entry.select_region(0, -1)
  })

  // The entry's keys are taken at the CAPTURE phase: GtkEntry consumes Return
  // for its own activate, so the commit and the exit have to happen before the
  // entry sees the press. Every other key falls through to the entry's editing
  // behaviour, which is also what leaves the window's key table as it was —
  // Escape means "leave the entry" only while the entry is on screen.
  const keys = new Gtk.EventControllerKey()
  keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  keys.connect("key-pressed", (_c, keyval) => {
    if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
      // A rejected path keeps the entry open on the text.
      if (opts.onCommit(entry.get_text())) endEdit()
      return true
    }
    if (keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab) {
      // Tab cycles the path completion (Shift+Tab backwards). No candidate —
      // or a text that is not path-shaped — falls through to GTK's focus move.
      const r = pathAutofill.onTab(entry.get_text(), keyval === Gdk.KEY_ISO_Left_Tab)
      if (r !== null) {
        entry.set_text(r.text)
        entry.select_region(r.committedLen, r.text.length)
        return true
      }
    }
    if (keyval === Gdk.KEY_Escape) {
      endEdit()
      return true
    }
    return false
  })
  entry.add_controller(keys)

  /** Where the bar's empty tail starts: the right edge of the last segment, in
   *  bar coordinates. A bounds query that fails reports past the bar's width,
   *  so no click enters edit mode off it. */
  function tailStart(): number {
    const last = segments.get_last_child()
    if (!last) return 0
    try {
      const [ok, rect] = last.compute_bounds(scroller)
      return ok && rect ? rect.origin.x + rect.size.width : Number.POSITIVE_INFINITY
    } catch (e) {
      ignore("path bar tail bounds", e)
      return Number.POSITIVE_INFINITY
    }
  }

  // The segment buttons claim their own presses, so a press that reaches the
  // bar is on a separator or on the empty tail; the tail is the region right of
  // the last segment, and a click there opens the entry.
  const tailClick = new Gtk.GestureClick()
  tailClick.set_button(Gdk.BUTTON_PRIMARY)
  tailClick.connect("pressed", (_g, _n, x: number) => {
    if (!editing && x >= tailStart()) beginEdit()
  })
  scroller.add_controller(tailClick)

  return { widget: stack, setPath, beginEdit, endEdit }
}
