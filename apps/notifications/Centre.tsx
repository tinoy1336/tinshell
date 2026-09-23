/**
 * Centre — the control centre (swaync's control-centre window).
 *
 * A 500×600 layer surface (namespace "notifications-centre", layer TOP,
 * anchored top-centre, keymode EXCLUSIVE while open). Widgets in swaync's
 * order: inhibitors ("Inhibitors" + Clear All), title ("Notifications" +
 * Clear All), dnd ("Do Not Disturb" switch), notifications (the history list,
 * vexpand). Empty state reads "No Notifications".
 *
 * Grouping (swaync parity): notifications grouped by app; single-item groups
 * render their card directly, multi-item groups get a header (28px app icon +
 * name + count + chevron + per-group close-all) with a slide-down revealer
 * (timing.collapseMs) — ONE group expanded at a time, other groups get the
 * not-expanded (0.4 opacity) treatment; a new notification expanding a
 * collapsed group auto-expands it.
 *
 * Keyboard (swaync's Control Centre Shortcuts): Up/Down navigate, Home/End,
 * Escape/Caps_Lock close, Return = default action, Delete/BackSpace dismiss,
 * Shift+C close all, Shift+D toggle DND, 1-9 invoke alternative actions.
 */

import GLib from "gi://GLib"
import { createEffect, createState, For } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { get, store } from "./config"
import { ignore, log } from "./log"
import {
  clearInhibitors,
  closeAll,
  dismiss,
  dndEnabled,
  inhibitors,
  invokeAction,
  invokeDefault,
  notifications,
  setCentreVisible,
  setDndEnabled,
} from "./Notifd"
import NotificationCard from "./NotificationCard"

// Astal's WindowAnchor carries no HORIZONTAL member (NONE / TOP / RIGHT / LEFT /
// BOTTOM): layer-shell centres the surface on an axis it holds no anchor bit for,
// so TOP alone is the top-centre placement this surface wants.
const { TOP } = Astal.WindowAnchor

interface Group {
  key: string
  name: string
  items: any[] // AstalNotifd.Notification[]
}

/** Group `list` by application (grouping ON) or emit one single-item group
 *  per notification (grouping OFF). The flattened form is what makes the
 *  toggle honest: every card then renders directly, with no app header and no
 *  chevron, regardless of how many notifications one app sent. */
function computeGroups(list: any[], grouped: boolean): Group[] {
  if (!grouped) {
    return list
      .map((n) => ({
        key: `n:${n?.id}`,
        name: n?.app_name || n?.desktop_entry || "Unknown",
        items: [n],
      }))
      .sort((a, b) => (b.items[0]?.time ?? 0) - (a.items[0]?.time ?? 0))
  }
  const map = new Map<string, Group>()
  for (const n of list) {
    const name = n?.app_name || n?.desktop_entry || "Unknown"
    const key = name.toLowerCase()
    let g = map.get(key)
    if (!g) {
      g = { key, name, items: [] }
      map.set(key, g)
    }
    g.items.push(n)
  }
  return [...map.values()].sort((a, b) => (b.items[0]?.time ?? 0) - (a.items[0]?.time ?? 0))
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

/** Centre control surface (the request dispatcher's NotificationsControl). */
interface CentreControl {
  toggleCentre(): void
  showCentre(): void
  hideCentre(): void
  closeAll(): void
  dismiss(id: number): void
  history(): string[]
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
  let dndSwitch: Gtk.Switch | null = null

  const [groups, setGroups] = createState<Group[]>([])
  const [expandedKey, setExpandedKey] = createState<string | null>(null)
  const [selectedId, setSelectedId] = createState<number | null>(null)
  const [groupingOn, setGroupingOn] = createState<boolean>(get("grouping.enabled", true))

  let inhibitorsLabel: Gtk.Label | null = null

  // Recompute groups when notifications change; auto-expand a group that grew.
  // `lastGroups` is UNTRACKED (a plain variable, not a state read) — reading
  // groups() inside the effect would make it depend on its own output and
  // loop forever (setGroups always writes a fresh array reference).
  let lastGroups: Group[] = []
  createEffect(() => {
    const cur = notifications()
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
  })

  // DND switch external sync.
  createEffect(() => {
    if (dndSwitch) dndSwitch.active = dndEnabled()
  })

  // External config changes (config set/reload via request).
  store.onConfigChanged(() => {
    setGroupingOn(get("grouping.enabled", true))
  })

  function moveSelection(delta: number): void {
    const l = notifications()
    if (l.length === 0) return
    const cur = l.findIndex((n) => n.id === selectedId())
    let next = cur < 0 ? 0 : cur + delta
    next = ((next % l.length) + l.length) % l.length
    setSelectedId(l[next].id)
    scrollTo(l[next].id)
  }

  function jumpTo(delta: number): void {
    const l = notifications()
    if (l.length === 0) return
    const idx = delta < 0 ? 0 : l.length - 1
    setSelectedId(l[idx].id)
    scrollTo(l[idx].id)
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
    const sel = notifications().find((n) => n.id === selectedId())
    switch (keyval) {
      case Gdk.KEY_Escape:
      case Gdk.KEY_Caps_Lock:
        hide()
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
        if (sel) invokeDefault(sel)
        return true
      case Gdk.KEY_Delete:
      case Gdk.KEY_BackSpace:
        if (sel) dismiss(sel.id)
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
          const actions = sel.actions ?? []
          const a = actions[keyval - Gdk.KEY_1]
          if (a?.id) {
            invokeAction(sel, a.id)
            return true
          }
        }
        return false
    }
  }

  function show(): void {
    win.visible = true
    setCentreVisible(true)
  }

  function hide(): void {
    win.visible = false
    setCentreVisible(false)
  }

  function toggle(): void {
    if (win.visible) hide()
    else show()
  }

  function closeGroup(g: Group): void {
    for (const n of g.items) dismiss(n.id)
  }

  function toggleGroup(key: string): void {
    setExpandedKey((cur) => (cur === key ? null : key))
  }

  const collapseMs = get<number>("timing.collapseMs", 400)

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
        self.set_default_size(get<number>("centre.width", 500), get<number>("centre.height", 600))
        self.get_surface?.()?.set_opaque_region?.(null)
        // Control surface for the request dispatcher (mount.ts → setControl).
        controlHandle = {
          toggleCentre: toggle,
          showCentre: show,
          hideCentre: hide,
          closeAll,
          dismiss,
          history: () =>
            notifications().map((n) => `[${n.id}] ${n.summary ?? ""} — ${n.app_name ?? ""}`),
        }
        const key = new Gtk.EventControllerKey()
        key.connect("key-pressed", onKey)
        self.add_controller(key)
      }}
    >
      <box class="centre" orientation={Gtk.Orientation.VERTICAL}>
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
          {/* biome-ignore lint/a11y/useButtonType: TINSHELL GTK4 Button widget (no HTML type prop) */}
          <button
            label="Clear All"
            class="clear-button"
            can_focus={false}
            onClicked={() => clearInhibitors()}
          />
        </box>

        {/* title */}
        <box class="widget widget-title">
          <label label="Notifications" hexpand halign={Gtk.Align.START} />
          {/* biome-ignore lint/a11y/useButtonType: TINSHELL GTK4 Button widget (no HTML type prop) */}
          <button
            label="Clear All"
            class="clear-button"
            can_focus={false}
            onClicked={() => closeAll()}
          />
        </box>

        {/* dnd */}
        <box class="widget widget-dnd">
          <label label="Do Not Disturb" hexpand halign={Gtk.Align.START} />
          <switch
            $={(s) => {
              dndSwitch = s
              s.add_css_class("dnd-switch")
              s.set_valign(Gtk.Align.CENTER)
              s.connect("notify::active", () => setDndEnabled(s.active))
            }}
          />
        </box>

        {/* notifications list */}
        <scrolledwindow
          $={(ref) => {
            scrolled = ref
            ref.set_vexpand(true)
            ref.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            ref.set_propagate_natural_height(true)
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
                  ref.visible = notifications().length === 0
                })
              }}
            />
            <For each={groups}>
              {(g) => {
                // With grouping OFF computeGroups emits single-item groups; with
                // grouping ON every app keeps its header, single notification or
                // not.
                if (g.items.length === 1 && !groupingOn()) {
                  return <CentreRow noti={g.items[0]} />
                }
                const isExpanded = expandedKey((k) => k === g.key)
                return (
                  <box
                    class={expandedKey((k) =>
                      k !== null && k !== g.key ? "centre-group not-expanded" : "centre-group",
                    )}
                    orientation={Gtk.Orientation.VERTICAL}
                  >
                    {/* biome-ignore lint/a11y/useButtonType: TINSHELL GTK4 Button widget (no HTML type prop) */}
                    <button
                      class="group-header"
                      can_focus={false}
                      onClicked={() => toggleGroup(g.key)}
                    >
                      {groupIcon(g.name)}
                      <label label={g.name} hexpand halign={Gtk.Align.START} ellipsize={3} />
                      <label
                        label={String(g.items.length)}
                        class="group-count"
                        halign={Gtk.Align.END}
                      />
                      <label label={isExpanded() ? "▾" : "▸"} class="group-chevron" />
                    </button>
                    <revealer
                      reveal_child={isExpanded}
                      transition_type={Gtk.RevealerTransitionType.SLIDE_DOWN}
                      transition_duration={collapseMs}
                    >
                      <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                        <For each={(() => g.items) as any}>{(n) => <CentreRow noti={n} />}</For>
                      </box>
                    </revealer>
                    {/* biome-ignore lint/a11y/useButtonType: TINSHELL GTK4 Button widget (no HTML type prop) */}
                    <button
                      label="✕"
                      class="group-close"
                      can_focus={false}
                      onClicked={() => closeGroup(g)}
                    />
                  </box>
                )
              }}
            </For>
          </box>
        </scrolledwindow>
      </box>
    </window>
  )

  // A row wrapper: selection highlight + click = default action (swaync parity).
  function CentreRow({ noti }: { noti: any }) {
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
        <NotificationCard noti={noti} variant="centre" onActivate={(n) => invokeDefault(n)} />
      </box>
    )
  }

  return winJsx
}
