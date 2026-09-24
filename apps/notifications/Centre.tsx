/**
 * Centre — the control centre.
 *
 * A layer surface (namespace "notifications-centre", layer TOP, anchored
 * top-centre, keymode EXCLUSIVE while open) whose HEIGHT follows its content
 * between `centre.minHeight` and `centre.maxHeight`: a couple of short entries
 * make a short panel, a long history caps at the maximum and scrolls inside it.
 * The width is fixed at `centre.width`. Widgets: inhibitors
 * ("Inhibitors" + the clear glyph, shown only while something inhibits),
 * title ("Notifications" + the DND glyph toggle + the clear-all glyph), then
 * the history list (vexpand). Empty state reads "No Notifications".
 *
 * THE LIST IS THE HISTORY — an entry stays listed after its notification leaves
 * the screen (expiry, the popup's ✕, a swipe): the popup is transient, the list
 * is what the user reads back. A resolved entry loses its sender actions and
 * nothing else — it stays at FULL contrast, because a dimmed entry is an entry
 * the user cannot read; `forget` (a centre card's ✕, Delete) removes one entry
 * from the list, and Clear All (the clear glyph, Shift+C) wipes the stack and
 * the history.
 *
 * Grouping: notifications grouped by app; a group of ONE entry
 * renders its card directly — the header exists to stand for several entries,
 * and a collapsed header with a card inside its revealer lists nothing. Multi-
 * item groups get ONE header ROW (28px app icon + name + count + chevron + the
 * group's clear glyph) with a slide-down revealer (timing.collapseMs) — ONE
 * group expanded at a time, and a new notification expanding a collapsed group
 * auto-expands it. The row is a box with its own click gesture, not a
 * `Gtk.Button`: a Button claims every press inside its box, so a glyph child
 * would never see its own click.
 *
 * Every control here is the project's own glyph — `hoverGlyph` (common/glyph/
 * hover-glyph): Cairo ink in muted colour at rest, brightened to the ink colour
 * under an accent halo on hover. NOT the card family's `glyphButton`, whose
 * flat button chrome the centre does not wear.
 *
 * Scrolling: the list is a plain `Gtk.ScrolledWindow` — GTK's own scroll path
 * carries the wheel, a trackpad's delta and the momentum after a flick
 * (`GtkKineticScrolling`), and this app installs no scroll controller of its own.
 * The scroller is capped at the height the window gives it (`max-content-height`,
 * `applyViewport`), so a long history scrolls inside the panel instead of
 * growing the layer surface past `centre.height` — the house pattern (clipboard
 * picker, promptd, menus).
 *
 * The surface has exactly TWO ways off the screen: the key backstop below
 * (Escape / Caps_Lock) and the toggle the keybind and the request surface drive.
 * Both log their reason (`centre shown (…)` / `centre hidden (…)`), so a centre
 * that left the screen names the path that took it; no click, dismissal or
 * history change moves this window.
 *
 * Keyboard: Up/Down navigate, Home/End,
 * Escape/Caps_Lock close, Return = default action, Delete/BackSpace remove the
 * selected entry from the list, Shift+C clear all, Shift+D toggle DND, 1-9
 * invoke alternative actions.
 */

import GLib from "gi://GLib"
import { ACCENT, FONT_FAMILY, INK, INK_MUTED } from "@common/css/tokens"
import { hoverGlyph } from "@common/glyph/hover-glyph"
import { createEffect, createState, For } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { get, store } from "./config"
import { ignore, log } from "./log"
import {
  clearInhibitors,
  closeAll,
  dismiss,
  dndEnabled,
  forget,
  type HistoryEntry,
  history,
  inhibitors,
  invokeAction,
  invokeDefault,
  setCentreVisible,
  setDndEnabled,
} from "./Notifd"
import NotificationCard from "./NotificationCard"

// Astal's WindowAnchor carries no HORIZONTAL member (NONE / TOP / RIGHT / LEFT /
// BOTTOM): layer-shell centres the surface on an axis it holds no anchor bit for,
// so TOP alone is the top-centre placement this surface wants.
const { TOP } = Astal.WindowAnchor

/** MDI codepoints sit above the BMP, so every escape carries braces
 *  ("\u{f009b}"); the unbraced form parses as U+F009 followed by a literal "b".
 *  `nf search` resolves each name, `nf sheet` renders it. */
const GLYPH = {
  // A crossed-out bell reads as "notifications are silenced"; the plain bell is
  // the state the button toggles AWAY from, so it is the resting face.
  dndOn: "\u{f009b}", // md-bell_off
  dndOff: "\u{f009c}", // md-bell_outline
  clearAll: "\u{f039f}", // md-notification_clear_all
} as const

/** Vertical space the list's scroller must leave below itself: the
 *  `.centre-list` bottom margin (8) plus the `.centre` padding (8). */
const LIST_BOTTOM_PAD = 16

interface Group {
  key: string
  name: string
  items: HistoryEntry[]
}

/** Group `list` by application (grouping ON) or emit one single-item group
 *  per entry (grouping OFF). The flattened form is what makes the toggle
 *  honest: every card then renders directly, with no app header and no
 *  chevron, regardless of how many notifications one app sent. */
function computeGroups(list: HistoryEntry[], grouped: boolean): Group[] {
  const nameOf = (e: HistoryEntry) => e.noti?.app_name || e.noti?.desktop_entry || "Unknown"
  if (!grouped) {
    return list
      .map((e) => ({ key: `n:${e.noti?.id}`, name: nameOf(e), items: [e] }))
      .sort((a, b) => (b.items[0]?.noti?.time ?? 0) - (a.items[0]?.noti?.time ?? 0))
  }
  const map = new Map<string, Group>()
  for (const e of list) {
    const name = nameOf(e)
    const key = name.toLowerCase()
    let g = map.get(key)
    if (!g) {
      g = { key, name, items: [] }
      map.set(key, g)
    }
    g.items.push(e)
  }
  return [...map.values()].sort(
    (a, b) => (b.items[0]?.noti?.time ?? 0) - (a.items[0]?.noti?.time ?? 0),
  )
}

/** 28px group-header app icon (Gtk.IconPaintable in a clipping Gtk.Picture). */
function groupIcon(name: string | null | undefined): Gtk.Picture {
  const pic = new Gtk.Picture()
  pic.add_css_class("group-icon")
  pic.set_size_request(28, 28)
  pic.content_fit = Gtk.ContentFit.COVER
  try {
    // @ts-expect-error runtime accepts this argument shape (type-only gap, msg: Argument of type 'Display | null' is not)
    const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
    const p = theme.lookup_icon(
      name || "application-x-executable-symbolic",
      null,
      28,
      1,
      Gtk.TextDirection.NONE,
      // USE_BUILTIN was dropped from GTK4's flag set (NONE / FORCE_REGULAR /
      // FORCE_SYMBOLIC / PRELOAD) — the constant this read resolves to
      // undefined and reached the call as 0.
      Gtk.IconLookupFlags.NONE,
    )
    if (p) pic.paintable = p
  } catch (e) {
    // No usable icon for this app — the card renders without one.
    ignore("notification icon lookup", e)
  }
  return pic
}

/** Square box and font size every centre control glyph draws in (the hover
 *  halo's radius is box/2, so the glow scales with the control). */
const CONTROL_BOX = 28
const CONTROL_FS = 16

/** Hover halo core alpha: low enough that the accent reads as a tint spreading
 *  under the glyph rather than a drawn disc. */
const GLOW_ALPHA = 0.22

/** Config colours are hex strings, `hoverGlyph` takes [r, g, b, a] tuples at
 *  0..1, and `hexToRgba` (@common/colour) emits a CSS string — so the tuple
 *  form is spelled here. An unparsable colour falls back to full ink, which
 *  keeps the control visible instead of painting it invisible. */
function tuple(hex: string, alpha = 1): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [1, 1, 1, alpha]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, alpha]
}

const mutedTuple = (): [number, number, number, number] =>
  tuple(get<string>("appearance.muted", INK_MUTED))
const inkTuple = (): [number, number, number, number] => tuple(get<string>("appearance.ink", INK))
const accentTuple = (): [number, number, number, number] =>
  tuple(get<string>("appearance.accent", ACCENT))

/** A standalone centre control: the shared glyph primitive with this app's
 *  palette — muted at rest, the ink colour under an accent halo on hover — and
 *  its tooltip, where the words live (a hover hint, never text on the surface). */
function controlGlyph(
  emoji: string | (() => string),
  tooltip: string,
  onClick: () => void,
): Gtk.DrawingArea {
  const g = hoverGlyph({
    emoji,
    box: CONTROL_BOX,
    fontSize: CONTROL_FS,
    rest: mutedTuple(),
    fontFamily: FONT_FAMILY,
    hover: { colour: inkTuple(), glow: accentTuple(), glowAlpha: GLOW_ALPHA },
    ownHover: true,
    onClick,
  })
  g.widget.set_tooltip_text(tooltip)
  return g.widget
}

/** The DND toggle carries BOTH faces of the state in one glyph: the plain bell
 *  in muted ink while Do Not Disturb is off, the slashed bell in the accent
 *  while it is on. `hoverGlyph` re-reads its `rest` tuple on every draw, so the
 *  state is ONE mutated tuple plus a repaint — which is also how an external
 *  `notifications dnd set` gets its repaint. */
function dndGlyph(): Gtk.DrawingArea {
  const rest = mutedTuple()
  const g = hoverGlyph({
    emoji: () => (dndEnabled() ? GLYPH.dndOn : GLYPH.dndOff),
    box: CONTROL_BOX,
    fontSize: CONTROL_FS,
    rest,
    fontFamily: FONT_FAMILY,
    hover: { colour: inkTuple(), glow: accentTuple(), glowAlpha: GLOW_ALPHA },
    ownHover: true,
    onClick: () => setDndEnabled(!dndEnabled()),
  })
  g.widget.set_tooltip_text("Do Not Disturb")
  createEffect(() => {
    const c = dndEnabled() ? accentTuple() : mutedTuple()
    rest[0] = c[0]
    rest[1] = c[1]
    rest[2] = c[2]
    rest[3] = c[3]
    g.widget.queue_draw()
  })
  return g.widget
}

/** Does a press at `x` (in `row`'s own coordinate space) land inside `child`?
 *  The group row's click gesture asks this about its trailing clear glyph; a
 *  widget that was never allocated answers false, and no press can land on one
 *  that is not on screen. */
function pressOver(child: Gtk.Widget, row: Gtk.Widget, x: number): boolean {
  try {
    const t = child.translate_coordinates(row, 0, 0)
    if (t?.[0]) return x >= t[1]
  } catch (e) {
    ignore("group row press coordinate read", e)
  }
  return false
}

/** Centre control surface (the request dispatcher's NotificationsControl). */
interface CentreControl {
  toggleCentre(): void
  showCentre(): void
  hideCentre(): void
  closeAll(): void
  dismiss(id: number): void
  forget(id: number): void
  history(): string[]
  centreDebug(): string
}

/** The control surface, set while Centre() builds its window; mount.ts hands
 *  it to the request dispatcher (null before Centre() ran). */
let controlHandle: CentreControl | null = null

export function centreControl(): CentreControl | null {
  return controlHandle
}

/** Centre-row widget → notification id, filled as each row is built;
 *  findInTree reads it for scroll-to-row. */
const rowNotiIds = new WeakMap<Gtk.Widget, number>()

/** Bring one card into view inside the centre's scroller. GTK4's ScrolledWindow
 *  has no scroll-to-child method (gtk4-gir lists none, and the call this
 *  replaced threw `TypeError: scrolled.scroll_to_child is not a function`), so
 *  the target's bound is read in the scroller's own coordinate space and the
 *  vertical adjustment moved by the difference: a bound above the viewport
 *  scrolls up by its own offset, one below scrolls down until its bottom edge
 *  reaches the viewport's. An unallocated target (bound zero) or a viewport the
 *  scroller has not sized yet (page size zero) leaves the position alone. */
export function revealChild(scroller: Gtk.ScrolledWindow, target: Gtk.Widget): void {
  const [ok, bounds] = target.compute_bounds(scroller)
  if (!ok) return
  const adj = scroller.get_vadjustment()
  const page = adj.get_page_size()
  if (page <= 0) return
  const top = bounds.get_y()
  const bottom = top + bounds.get_height()
  let value = adj.get_value()
  if (top < 0) value += top
  else if (bottom > page) value += bottom - page
  else return
  const upper = Math.max(adj.get_lower(), adj.get_upper() - page)
  adj.set_value(Math.min(Math.max(value, adj.get_lower()), upper))
}

export default function Centre() {
  let win: Astal.Window
  let scrolled: Gtk.ScrolledWindow
  let list: Gtk.Box
  let root: Gtk.Box

  const [groups, setGroups] = createState<Group[]>([])
  const [expandedKey, setExpandedKey] = createState<string | null>(null)
  const [selectedId, setSelectedId] = createState<number | null>(null)
  const [groupingOn, setGroupingOn] = createState<boolean>(get("grouping.enabled", true))

  let inhibitorsLabel: Gtk.Label | null = null

  // Recompute groups when the history changes; auto-expand a group that grew.
  // `lastGroups` is UNTRACKED (a plain variable, not a state read) — reading
  // groups() inside the effect would make it depend on its own output and
  // loop forever (setGroups always writes a fresh array reference).
  let lastGroups: Group[] = []
  createEffect(() => {
    const cur = history()
    const next = computeGroups(cur, groupingOn())
    for (const g of next) {
      if (g.items.length <= 1) continue
      const old = lastGroups.find((p) => p.key === g.key)
      if (!old || g.items.length > old.items.length) {
        setExpandedKey(g.key)
        break
      }
    }
    lastGroups = next
    setGroups(next)
    // The list's length drives the scroller's content height AND the panel's
    // own height: re-apply both once the new rows have been allocated.
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      applyViewport()
      applySize()
      return GLib.SOURCE_REMOVE
    })
  })

  // External config changes (config set/reload via request).
  store.onConfigChanged(() => {
    setGroupingOn(get("grouping.enabled", true))
  })

  /** Cap the list's scroller at the space the panel's MAXIMUM gives it, so a
   *  long history scrolls inside the panel instead of growing the layer surface
   *  past `centre.maxHeight`. A `Gtk.ScrolledWindow` whose vertical policy is
   *  AUTOMATIC keeps reporting its child's full natural height until
   *  `max-content-height` bounds it, which is what let a 13-entry history
   *  stretch the surface to the whole screen and clip the list instead of
   *  scrolling it. The cap comes from the CONFIGURED maximum minus the list's
   *  own bottom padding — never from a measured height: the scroller reports 0
   *  until it has been laid out, and the passes that can react to a size change
   *  (map, show, a history change) all run before the first frame. What the cap
   *  has to be is small enough that the list never asks the surface to grow,
   *  and the configured maximum is exactly that bound. */
  function applyViewport(): void {
    if (!scrolled || !win) return
    try {
      const cap = Math.max(120, Math.round(get<number>("centre.maxHeight", 600) - LIST_BOTTOM_PAD))
      scrolled.set_max_content_height(cap)
    } catch (e) {
      log(`applyViewport failed: ${e}`)
    }
  }

  /** Size the panel from its CONTENT, held between the configured minimum and
   *  maximum. The centre used to open at one fixed size, which meant a two-entry
   *  list sat in a 600px box with several hundred pixels of slack — slack the
   *  list hands to its rows, so the rows stretched and the cards rendered a void
   *  under their text. The height here is the ROOT box's own natural height: the
   *  scroller propagates the list's natural height (`propagate_natural_height`)
   *  and `max_content_height` caps it, so this adds the chrome to the content and
   *  needs no measured allocation — the scroller reports 0 until it has been laid
   *  out, and every pass that could react to a size change runs before the first
   *  frame. A panel whose content is shorter than the minimum keeps the minimum
   *  (the empty state), and one longer than the maximum keeps the maximum and
   *  scrolls. */
  let lastHeight = 0
  function applySize(): void {
    if (!win || !root) return
    try {
      const width = Math.round(get<number>("centre.width", 500))
      const min = Math.round(get<number>("centre.minHeight", 220))
      const max = Math.round(get<number>("centre.maxHeight", 600))
      const [, natural] = root.measure(Gtk.Orientation.VERTICAL, width)
      const want = Math.round(Math.min(Math.max(natural, Math.min(min, max)), max))
      if (want === lastHeight) return
      lastHeight = want
      win.set_default_size(width, want)
    } catch (e) {
      log(`applySize failed: ${e}`)
    }
  }

  /** The entries the list actually RENDERS, in the order it renders them: a
   *  single-entry group is its card, a multi-entry group shows its entries only
   *  while it is the expanded one, and a group of one entry is always visible.
   *  Keyboard navigation steps THIS list — a selection the user cannot see is a
   *  selection the user cannot act on. */
  function visibleEntries(): HistoryEntry[] {
    return groups().flatMap((g) => (g.items.length === 1 || expandedKey() === g.key ? g.items : []))
  }

  function moveSelection(delta: number): void {
    const l = visibleEntries()
    if (l.length === 0) return
    const cur = l.findIndex((e) => e.noti.id === selectedId())
    let next = cur < 0 ? (delta > 0 ? 0 : l.length - 1) : cur + delta
    next = ((next % l.length) + l.length) % l.length
    setSelectedId(l[next].noti.id)
    scrollTo(l[next].noti.id)
  }

  function jumpTo(delta: number): void {
    const l = visibleEntries()
    if (l.length === 0) return
    const idx = delta < 0 ? 0 : l.length - 1
    setSelectedId(l[idx].noti.id)
    scrollTo(l[idx].noti.id)
  }

  function scrollTo(id: number): void {
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      try {
        const target = findInTree(list, id)
        if (target) revealChild(scrolled, target)
      } catch (e) {
        log(`scrollTo failed: ${e}`)
      }
      return GLib.SOURCE_REMOVE
    })
  }

  /** The list's own natural height — what its rows measure to, independent of
   *  whatever the scroller hands it. The debug surface reports it against the
   *  allocation, because a list taller than its content is exactly the slack
   *  that used to stretch a card. */
  function listNatural(): number {
    if (!list) return 0
    try {
      const [, natural] = list.measure(Gtk.Orientation.VERTICAL, -1)
      return natural
    } catch (e) {
      log(`list measure failed: ${e}`)
      return 0
    }
  }

  /** The list's first `n` visible children by allocated height, in order (the
   *  group rows and entry rows the panel is made of). */
  function childHeights(n: number): string {
    if (!list) return "n/a"
    const out: string[] = []
    let child = list.get_first_child()
    while (child && out.length < n) {
      if (child.get_visible()) out.push(String(child.get_height()))
      child = child.get_next_sibling()
    }
    return out.join(",")
  }

  function findInTree(w: Gtk.Widget, id: number): Gtk.Widget | null {
    if (rowNotiIds.get(w) === id) return w
    const box = w as Gtk.Box
    let child = box.get_first_child?.()
    while (child) {
      const hit = findInTree(child, id)
      if (hit) return hit
      child = child.get_next_sibling?.()
    }
    return null
  }

  function onKey(_c: unknown, keyval: number, _keycode: number, state: number): boolean {
    const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0
    const sel = history().find((e) => e.noti.id === selectedId())
    switch (keyval) {
      case Gdk.KEY_Escape:
      case Gdk.KEY_Caps_Lock:
        hide("key")
        return true
      case Gdk.KEY_Down:
      case Gdk.KEY_Tab:
        moveSelection(1)
        return true
      case Gdk.KEY_Up:
      case Gdk.KEY_ISO_Left_Tab:
        moveSelection(-1)
        return true
      case Gdk.KEY_Home:
        jumpTo(-1)
        return true
      case Gdk.KEY_End:
        jumpTo(1)
        return true
      case Gdk.KEY_Return:
      case Gdk.KEY_KP_Enter:
        if (sel) invokeDefault(sel.noti)
        return true
      case Gdk.KEY_Delete:
      case Gdk.KEY_BackSpace:
        if (sel) forget(sel.noti.id)
        return true
      case Gdk.KEY_C:
        if (shift) {
          closeAll()
          return true
        }
        return false
      case Gdk.KEY_D:
        if (shift) {
          setDndEnabled(!dndEnabled())
          return true
        }
        return false
      default:
        if (keyval >= Gdk.KEY_1 && keyval <= Gdk.KEY_9 && sel) {
          const actions = sel.noti.actions ?? []
          const a = actions[keyval - Gdk.KEY_1]
          if (a?.id) {
            invokeAction(sel.noti, a.id)
            return true
          }
        }
        return false
    }
  }

  /** The surface's ONLY two hide paths are this pair (`hide` from the key
   *  backstop above and from the request surface) and the toggle; each logs the
   *  reason, so a centre that left the screen says which path took it. */
  function show(reason: string): void {
    win.visible = true
    setCentreVisible(true)
    log(`centre shown (${reason})`)
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      applyViewport()
      applySize()
      return GLib.SOURCE_REMOVE
    })
  }

  function hide(reason: string): void {
    win.visible = false
    setCentreVisible(false)
    log(`centre hidden (${reason})`)
  }

  function toggle(): void {
    if (win.visible) hide("toggle")
    else show("toggle")
  }

  function closeGroup(g: Group): void {
    for (const e of g.items) forget(e.noti.id)
  }

  function toggleGroup(key: string): void {
    setExpandedKey((cur) => (cur === key ? null : key))
  }

  const collapseMs = get<number>("timing.collapseMs", 400)

  // The three glyph controls, built once and placed by the JSX below. The
  // inhibitors' row shows only while something inhibits, but its glyph is the
  // same clear glyph as the title's — the count beside it says which list it
  // empties.
  const clearInhibitorsControl = controlGlyph(GLYPH.clearAll, "Clear inhibitors", clearInhibitors)
  const clearAllControl = controlGlyph(GLYPH.clearAll, "Clear all notifications", closeAll)
  const dndControl = dndGlyph()

  const winJsx = (
    <window
      namespace="notifications-centre"
      class="notifications-centre"
      name="notifications-centre"
      layer={Astal.Layer.TOP}
      keymode={Astal.Keymode.EXCLUSIVE}
      exclusivity={Astal.Exclusivity.IGNORE}
      anchor={TOP}
      visible={false}
      $={(self) => {
        win = self
        // Opened at the MINIMUM and grown from the content by applySize(): the
        // first frame of a short list must not be a tall empty panel.
        self.set_default_size(
          get<number>("centre.width", 500),
          get<number>("centre.minHeight", 220),
        )
        self.get_surface?.()?.set_opaque_region?.(null)
        self.connect("map", () => {
          applyViewport()
          applySize()
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            applyViewport()
            applySize()
            return GLib.SOURCE_REMOVE
          })
        })
        // The cap and the panel height need a post-layout read: the map/show
        // passes run before the first frame, when the scroller still reports
        // height 0. This fires only when the allocation CHANGES, so re-capping
        // here settles instead of re-entering the layout it reacts to.
        self.connect("notify::allocation", () => {
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            applyViewport()
            applySize()
            return GLib.SOURCE_REMOVE
          })
        })
        // Control surface for the request dispatcher (mount.ts → setControl).
        controlHandle = {
          toggleCentre: toggle,
          showCentre: () => show("request"),
          hideCentre: () => hide("request"),
          closeAll,
          dismiss,
          forget,
          history: () =>
            history().map(
              (e) =>
                `[${e.noti.id}] ${e.live ? "live" : "gone"} ${e.noti.summary ?? ""} — ${e.noti.app_name ?? ""}`,
            ),
          centreDebug: () => {
            const adj = scrolled?.get_vadjustment()
            const entries = history()
            return [
              `centre visible=${win?.visible ?? false} size=${win?.get_width() ?? 0}x${win?.get_height() ?? 0}`,
              `panel min=${get<number>("centre.minHeight", 220)} max=${get<number>("centre.maxHeight", 600)} applied=${lastHeight}`,
              `list value=${Math.round(adj?.get_value() ?? 0)} page=${Math.round(adj?.get_page_size() ?? 0)} upper=${Math.round(adj?.get_upper() ?? 0)} maxContent=${scrolled?.get_max_content_height() ?? 0}`,
              `list alloc=${list?.get_height() ?? 0} natural=${listNatural()} childH=${childHeights(4)}`,
              `selected=${selectedId() ?? "none"} visibleIds=${
                visibleEntries()
                  .map((e) => e.noti.id)
                  .join(",") || "none"
              }`,
              `entries=${entries.length} live=${entries.filter((e) => e.live).length} visible=${visibleEntries().length} groups=${groups().length} grouping=${groupingOn()} dnd=${dndEnabled()}`,
            ].join("\n")
          },
        }
        const key = new Gtk.EventControllerKey()
        key.connect("key-pressed", onKey)
        self.add_controller(key)
      }}
    >
      <box
        class="centre"
        orientation={Gtk.Orientation.VERTICAL}
        $={(self) => {
          root = self
        }}
      >
        {/* inhibitors */}
        <box
          class="widget widget-inhibitors"
          visible={false}
          $={(self) => {
            createEffect(() => {
              const n = inhibitors()
              self.visible = n.length > 0
              if (inhibitorsLabel) inhibitorsLabel.set_label(`Inhibitors ${n.length}`)
            })
          }}
        >
          <label
            label="Inhibitors 0"
            hexpand
            halign={Gtk.Align.START}
            $={(ref) => {
              inhibitorsLabel = ref
            }}
          />
          {clearInhibitorsControl}
        </box>

        {/* title — the two controls are glyphs: DND carries its state in the
            bell, clear-all says what it does by the tooltip. */}
        <box class="widget widget-title">
          <label label="Notifications" hexpand halign={Gtk.Align.START} />
          {dndControl}
          {clearAllControl}
        </box>

        {/* history list — GTK's own scroller path, unmodified: the wheel, a
            trackpad's delta and the momentum after it belong to the scroller
            (`GtkKineticScrolling`), and this app installs no
            `Gtk.EventControllerScroll` of its own — a non-gesture controller
            that consumed a continuous delta would latch that path off, which is
            what an app-side momentum costs. */}
        <scrolledwindow
          $={(ref) => {
            scrolled = ref
            ref.set_vexpand(true)
            ref.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            ref.set_propagate_natural_height(true)
            // The panel is sized from its content, so a content change that
            // lands after the first sizing pass must re-run it — a revealer
            // finishing its slide, a wrapped body settling once it has a width.
            // The scroller's `upper` IS the content height.
            ref.get_vadjustment().connect("notify::upper", () => {
              GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                applyViewport()
                applySize()
                return GLib.SOURCE_REMOVE
              })
            })
          }}
          class="centre-scrolled"
        >
          <box
            $={(ref) => {
              list = ref
              ref.set_orientation(Gtk.Orientation.VERTICAL)
              ref.add_css_class("centre-list")
            }}
          >
            <label
              class="empty-state"
              label="No Notifications"
              $={(ref) => {
                ref.set_vexpand(true)
                ref.set_valign(Gtk.Align.CENTER)
                ref.set_halign(Gtk.Align.CENTER)
                createEffect(() => {
                  ref.visible = history().length === 0
                })
              }}
            />
            <For each={groups}>
              {(g) => {
                // A single-entry group IS its card, with or without grouping:
                // the header exists to stand for several entries at once, and an
                // entry the user cannot see is not listed at all. With grouping
                // ON the auto-expand below only fires for a group that GREW, so a
                // lone entry's group would otherwise sit collapsed forever and
                // render as an empty header row.
                if (g.items.length === 1) {
                  return <CentreRow entry={g.items[0]} />
                }
                const isExpanded = expandedKey((k) => k === g.key)
                // The group's own clear glyph — built here so the row's click
                // gesture can hand a press over it to the glyph (pressOver).
                const clearGroupGlyph = controlGlyph(GLYPH.clearAll, `Clear ${g.name}`, () =>
                  closeGroup(g),
                )
                return (
                  <box class="centre-group" orientation={Gtk.Orientation.VERTICAL}>
                    {/* The header is a ROW, not a `Gtk.Button`: the trailing
                        clear glyph is a control of its own, and a Button's
                        gesture would claim the press before the glyph saw it.
                        The row's own gesture bails over the glyph's box. */}
                    <box
                      class="group-header"
                      orientation={Gtk.Orientation.HORIZONTAL}
                      spacing={8}
                      $={(self) => {
                        const click = new Gtk.GestureClick()
                        click.connect("pressed", (_c: unknown, _n: number, x: number) => {
                          if (pressOver(clearGroupGlyph, self, x)) return
                          toggleGroup(g.key)
                        })
                        self.add_controller(click)
                      }}
                    >
                      {groupIcon(g.name)}
                      <label
                        label={g.name}
                        hexpand
                        halign={Gtk.Align.FILL}
                        xalign={0}
                        ellipsize={3}
                      />
                      <label
                        label={String(g.items.length)}
                        class="group-count"
                        halign={Gtk.Align.END}
                      />
                      <label label={isExpanded() ? "▾" : "▸"} class="group-chevron" />
                      {clearGroupGlyph}
                    </box>
                    <revealer
                      reveal_child={isExpanded}
                      transition_type={Gtk.RevealerTransitionType.SLIDE_DOWN}
                      transition_duration={collapseMs}
                    >
                      <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                        <For each={(() => g.items) as any}>
                          {(e: HistoryEntry) => <CentreRow entry={e} />}
                        </For>
                      </box>
                    </revealer>
                  </box>
                )
              }}
            </For>
          </box>
        </scrolledwindow>
      </box>
    </window>
  )

  // A row wrapper: selection highlight + click = default action.
  // An entry the daemon no longer holds stays at the same contrast as a live
  // one — it is told apart by its missing sender actions, never by opacity.
  function CentreRow({ entry }: { entry: HistoryEntry }) {
    const noti = entry.noti
    return (
      <box
        class="centre-row"
        $={(self) => {
          rowNotiIds.set(self, noti.id)
          const sel = selectedId((s) => s === noti.id)
          const apply = (v: boolean) => {
            if (v) self.add_css_class("selected")
            else self.remove_css_class("selected")
          }
          apply(sel())
          createEffect(() => apply(sel()))
        }}
      >
        <NotificationCard
          noti={noti}
          variant="centre"
          live={entry.live}
          onActivate={(n) => invokeDefault(n)}
        />
      </box>
    )
  }

  return winJsx
}
