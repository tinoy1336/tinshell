/**
 * AstalNotifd wiring — daemon ownership + the app's reactive state.
 *
 * The FIRST AstalNotifd.Notifd instantiation claims org.freedesktop.Notifications
 * (one-owner rule — swaync must not be running). This module:
 *
 *   - claims the daemon and sets ignore-timeout=true: WE drive expiry from
 *     config popup.timeout/timeoutLow/timeoutCritical (urgency-tiered;
 *     critical 0 = sticky) — swaync's model, not the clients' timeouts;
 *   - mirrors dont-disturb from config dnd.enabled (AstalNotifd's shared
 *     daemon DND value — the TINSHELL-idiomatic DND, persisted in config.json);
 *   - keeps the reactive state consumed by Popups/Centre: notifications
 *     (unresolved, newest first), popup ids, inhibitors, centre visibility;
 *   - arms per-notification expiry timers ONLY when a popup is shown (swaync
 *     semantics: DND'd/inhibited notifications stay in the centre until
 *     dismissed — the timeout timer lives in the popup window, not the daemon);
 *   - exports the swaync-compat inhibitors DBus interface
 *     (org.erikreider.swaync.cc at /org/erikreider/swaync/cc — AddInhibitor /
 *     RemoveInhibitor / ClearInhibitors / NumberOfInhibitors / IsInhibited) so
 *     xdg-desktop-portal-wlr's `swaync-client --inhibitor-add/remove` keeps
 *     working (screen-sharing still inhibits notifications).
 */
import AstalNotifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createState } from "ags"
import { get, set as setConfig, store } from "./config"
import { ignore, log } from "./log"

// LAZY daemon: get_default() CLAIMS org.freedesktop.Notifications — module-
// scope construction would claim the name on mere import (the dock island
// imports Notifd.ts for notifyWithAction in the screengrab menu). The daemon
// is created on first use; the notifications mount calls initNotifd() eagerly
// so the name is owned at startup in the shell/the notifications island.
let notifd: AstalNotifd.Notifd | null = null
function getNotifd(): AstalNotifd.Notifd {
  if (!notifd) notifd = AstalNotifd.Notifd.get_default()
  return notifd
}

// ── In-process action handlers ──
//
// AstalNotifd gir 0.1 has NO notify() on the daemon and the gir Action
// doc says invoking only "notifies the client" — for a notification WE
// created in-process (send_notification), n.invoke() round-trips to our
// own bus and nothing consumes it. So actions created in-process are
// intercepted here, before n.invoke(): registerActionHandler(actionId, cb)
// routes NotificationCard button presses (all of them go through
// invokeAction) to an in-process callback instead of the dead DBus hop.
const actionHandlers = new Map<string, (n: AstalNotifd.Notification) => void>()

/** Register an in-process handler for an action id (overrides n.invoke). */
export function registerActionHandler(
  actionId: string,
  cb: (n: AstalNotifd.Notification) => void,
): void {
  actionHandlers.set(actionId, cb)
}

/**
 * Send an in-process notification with one action. The action press runs
 * `onInvoke(body)` in-process (via registerActionHandler + invokeAction),
 * then the normal hide/dismiss behaviour applies. The daemon assigns the id
 * and emits "notified" — popup + centre render like any other notification.
 */
export function notifyWithAction(opts: {
  summary: string
  body?: string
  appName?: string
  actionId: string
  actionLabel: string
  onInvoke: (body: string) => void
}): void {
  try {
    const n = new AstalNotifd.Notification()
    n.app_name = opts.appName ?? "ScreenGrab"
    n.summary = opts.summary
    if (opts.body) n.body = opts.body
    // gjs GObject constructors take a PROPERTIES OBJECT — positional args
    // throw "Argument to the constructor of Action should be a plain JS
    // object with properties to set" and kill the whole notification.
    n.add_action(new AstalNotifd.Action({ id: opts.actionId, label: opts.actionLabel }))
    registerActionHandler(opts.actionId, (noti) => {
      try {
        opts.onInvoke(noti.body ?? "")
      } catch (e) {
        log(`in-process action '${opts.actionId}' handler failed: ${e}`)
      }
    })
    // Gio-style async — callback form (the @girs Promise overload lies).
    AstalNotifd.send_notification(n, (_src: unknown, res: Gio.AsyncResult) => {
      try {
        AstalNotifd.send_notification_finish(res)
      } catch (e) {
        log(`send_notification_finish failed: ${e}`)
      }
    })
  } catch (e) {
    log(`notifyWithAction failed: ${e}`)
  }
}

/**
 * Send one in-process notification with NO action — `notifyWithAction` above
 * without the press. The daemon assigns the id and emits "notified", so the
 * popup and the centre render it like any other notification, and no action
 * handler is registered.
 *
 * Callers never pass a timeout: this surface discards the client's, so the
 * urgency tier alone decides how a popup leaves the screen (`timeoutFor` below).
 * `urgency` therefore defaults to NORMAL — CRITICAL is a zero-second timeout
 * here (sticky until dismissed by hand), which a routine notice is not.
 *
 * A process with no notification server to answer (the pre-login greeter) fails
 * in the send's callback: that is logged, never thrown.
 */
export function notify(opts: {
  summary: string
  body?: string
  appName?: string
  urgency?: AstalNotifd.Urgency
}): void {
  try {
    const n = new AstalNotifd.Notification()
    n.app_name = opts.appName ?? "TINSHELL"
    n.summary = opts.summary
    if (opts.body) n.body = opts.body
    n.urgency = opts.urgency ?? AstalNotifd.Urgency.NORMAL
    // Gio-style async — callback form (the @girs Promise overload lies).
    AstalNotifd.send_notification(n, (_src: unknown, res: Gio.AsyncResult) => {
      try {
        AstalNotifd.send_notification_finish(res)
      } catch (e) {
        log(`send_notification_finish failed: ${e}`)
      }
    })
  } catch (e) {
    log(`notify failed: ${e}`)
  }
}

// ── Reactive state (consumed by Popups.tsx / Centre.tsx) ──

/** All unresolved notifications, newest first (mirrors notifd's list). */
export const [notifications, setNotifications] = createState<AstalNotifd.Notification[]>([])
/** Ids currently shown as popups (newest first, capped at popup.maxVisible). */
export const [popupIds, setPopupIds] = createState<number[]>([])
/** Inhibiting app ids (swaync-compat). Any entry suppresses popups. */
export const [inhibitors, setInhibitors] = createState<string[]>([])
/** Whether the control centre is visible (open centre suppresses popups). */
const [centreVisible, setCentreVisible] = createState(false)
/** DND state (mirrors config dnd.enabled + getNotifd().dont_disturb). */
const [dndEnabled, setDndEnabledState] = createState<boolean>(get("dnd.enabled", false))

export { dndEnabled, setCentreVisible }

// ── Expiry timers ──

const timers = new Map<number, number>()

function timeoutFor(n: AstalNotifd.Notification): number {
  const u = n.urgency
  if (u === AstalNotifd.Urgency.CRITICAL) return get("popup.timeoutCritical", 0)
  if (u === AstalNotifd.Urgency.LOW) return get("popup.timeoutLow", 5)
  return get("popup.timeout", 10)
}

function armExpiry(n: AstalNotifd.Notification): void {
  clearExpiry(n.id)
  const timeout = timeoutFor(n)
  if (timeout > 0) {
    const src = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout * 1000, () => {
      timers.delete(n.id)
      try {
        n.expire()
      } catch (e) {
        log(`expire(${n.id}) failed: ${e}`)
      }
      return GLib.SOURCE_REMOVE
    })
    timers.set(n.id, src)
  }
}

function clearExpiry(id: number): void {
  const src = timers.get(id)
  if (src !== undefined) {
    try {
      GLib.source_remove(src)
    } catch (e) {
      // The source already fired (removal races the expiry callback).
      ignore("notification expiry timer remove", e)
    }
    timers.delete(id)
  }
}

// ── Popup gate (swaync parity) ──

function bypassDnd(n: AstalNotifd.Notification): boolean {
  try {
    const v = n.hints?.lookup_value("swaync:bypass-dnd", null)
    return v !== null && v.unpack() === true
  } catch (e) {
    // No (or malformed) bypass-dnd hint → not a bypass notification.
    ignore("bypass-dnd hint read", e)
    return false
  }
}

function shouldShowPopup(n: AstalNotifd.Notification): boolean {
  if (centreVisible()) return false
  const blocked = dndEnabled() || inhibitors().length > 0
  if (blocked && n.urgency !== AstalNotifd.Urgency.CRITICAL && !bypassDnd(n)) return false
  return true
}

function showPopup(id: number): void {
  setPopupIds((prev) => {
    if (prev.includes(id)) return prev
    const max = get("popup.maxVisible", 5)
    return [id, ...prev.filter((x) => x !== id)].slice(0, max)
  })
}

// ── Public actions (commands / centre / cards) ──

/** Dismiss a notification (DISMISSED_BY_USER — leaves popup AND centre). */
export function dismiss(id: number): void {
  const n = getNotifd().get_notification(id)
  if (!n) return
  try {
    n.dismiss()
  } catch (e) {
    log(`dismiss(${id}) failed: ${e}`)
  }
}

/** Look up a notification by id (for the request API). */
export function getNotification(id: number): AstalNotifd.Notification | null {
  return getNotifd().get_notification(id)
}

/** Close every unresolved notification (Clear All / Shift+C). */
export function closeAll(): void {
  for (const n of notifications()) {
    try {
      n.dismiss()
    } catch (e) {
      log(`closeAll dismiss(${n.id}) failed: ${e}`)
    }
  }
}

/** Invoke an action by id; hide-on-action closes the popup; non-resident dismisses. */
export function invokeAction(n: AstalNotifd.Notification, actionId: string): void {
  // In-process actions (notifyWithAction) are handled here, not via
  // n.invoke() — the DBus round-trip would go nowhere for our own
  // notifications (the gir Action doc: "only notifies the client").
  const handler = actionHandlers.get(actionId)
  if (handler) {
    try {
      handler(n)
    } catch (e) {
      log(`in-process action '${actionId}' handler failed: ${e}`)
    }
  } else {
    try {
      n.invoke(actionId)
    } catch (e) {
      log(`invoke(${n.id}, ${actionId}) failed: ${e}`)
    }
  }
  if (get("behaviour.hideOnAction", true)) setPopupIds((prev) => prev.filter((x) => x !== n.id))
  if (!n.resident) dismiss(n.id)
}

/** Clicked the card's default area: "default" action if present, else dismiss. */
export function invokeDefault(n: AstalNotifd.Notification): void {
  const def = n.actions?.find((a: AstalNotifd.Action) => (a.id || "").toLowerCase() === "default")
  if (def) invokeAction(n, def.id)
  else dismiss(n.id)
}

// ── DND ──

export function setDndEnabled(v: boolean): void {
  if (v === dndEnabled()) return
  setDndEnabledState(v)
  try {
    getNotifd().dont_disturb = v
  } catch (e) {
    log(`dont_disturb=${v} failed: ${e}`)
  }
  setConfig("dnd.enabled", v)
}

// ── Inhibitors (swaync-compat) ──

export function addInhibitor(appId: string): boolean {
  if (inhibitors().includes(appId)) return false
  setInhibitors((prev) => [...prev, appId])
  return true
}

export function removeInhibitor(appId: string): boolean {
  if (!inhibitors().includes(appId)) return false
  setInhibitors((prev) => prev.filter((x) => x !== appId))
  return true
}

export function clearInhibitors(): boolean {
  if (inhibitors().length === 0) return false
  setInhibitors([])
  return true
}

// ── Daemon wiring (called once from app.ts main) ──

export function initNotifd(): void {
  // We drive expiry (config popup.timeout*) — never let clients' timeouts resolve.
  try {
    getNotifd().ignore_timeout = true
  } catch (e) {
    log(`ignore_timeout failed: ${e}`)
  }
  // Apply persisted DND to the daemon's shared value.
  setDndEnabledState(get("dnd.enabled", false))
  try {
    getNotifd().dont_disturb = get("dnd.enabled", false)
  } catch (e) {
    log(`initial dont_disturb failed: ${e}`)
  }

  getNotifd().connect("notified", (_n: unknown, id: number, replaced: boolean) => {
    const noti = getNotifd().get_notification(id)
    if (!noti) {
      log(`notified id=${id} but get_notification returned null`)
      return
    }
    if (replaced) {
      // Update in place (same id, fresh card) + restart the clock.
      setNotifications((prev) => prev.map((x) => (x.id === id ? noti : x)))
      if (popupIds().includes(id)) armExpiry(noti)
      return
    }
    setNotifications((prev) => [noti, ...prev])
    if (shouldShowPopup(noti)) {
      showPopup(id)
      armExpiry(noti)
    } else {
      log(`popup suppressed for id=${id} (dnd/inhibited/centre-open or non-popup context)`)
    }
  })

  getNotifd().connect("resolved", (_n: unknown, id: number, _reason: number) => {
    clearExpiry(id)
    setNotifications((prev) => prev.filter((x) => x.id !== id))
    setPopupIds((prev) => prev.filter((x) => x !== id))
  })

  // The daemon PERSISTS unresolved notifications in gsettings (io.astal.notifd
  // → "notifications") and restores them at startup — but restore calls
  // add_notification directly, which does NOT emit "notified", so our reactive
  // state would miss them. Seed the centre from the daemon's list (no popups;
  // expiry timers are re-armed below so the pile self-cleans).
  try {
    const existing = (getNotifd().get_notifications() ?? []) as AstalNotifd.Notification[]
    if (existing.length > 0) {
      setNotifications([...existing].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)))
      // Re-arm per-urgency expiry so a restored pile self-cleans instead of
      // accumulating across restarts (restored notifications have no popup;
      // the timer still applies — critical stays sticky).
      for (const n of existing) armExpiry(n)
      log(`seeded ${existing.length} restored notification(s) into the centre`)
    }
  } catch (e) {
    log(`seed restored notifications failed: ${e}`)
  }

  // External config changes (config set/reload via request) re-apply DND.
  store.onConfigChanged(() => {
    const v = get("dnd.enabled", false)
    if (v !== dndEnabled()) setDndEnabledState(v)
    try {
      getNotifd().dont_disturb = v
    } catch (e) {
      log(`dont_disturb sync failed: ${e}`)
    }
  })

  // Relative-timestamp refresh clock (60s).
  startClock()

  exportSwayncCompat()
}

// ── swaync-compat inhibitors DBus (org.erikreider.swaync.cc) ──

const SWAYNC_CC_NAME = "org.erikreider.swaync.cc"
const SWAYNC_CC_PATH = "/org/erikreider/swaync/cc"

const CC_XML = `<node>
  <interface name="org.erikreider.swaync.cc">
    <method name="AddInhibitor">
      <arg type="s" name="application_id" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
    <method name="RemoveInhibitor">
      <arg type="s" name="application_id" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
    <method name="ClearInhibitors">
      <arg type="b" direction="out"/>
    </method>
    <method name="NumberOfInhibitors">
      <arg type="u" direction="out"/>
    </method>
    <method name="IsInhibited">
      <arg type="b" direction="out"/>
    </method>
  </interface>
</node>`

// The bus_own_name id MUST be kept in a module-level variable — gjs finalizes
// the ownership wrapper on GC, releasing the name ("name owned" then
// "name lost" ~3s later — one GC cycle).
let swayncOwnerId = 0

function exportSwayncCompat(): void {
  try {
    const node = Gio.DBusNodeInfo.new_for_xml(CC_XML)
    Gio.DBus.session.register_object(
      SWAYNC_CC_PATH,
      node.interfaces[0],
      (
        _conn: unknown,
        _sender: string,
        _path: string,
        _iface: string,
        method: string,
        _params: unknown,
        invocation: any,
      ) => {
        switch (method) {
          case "AddInhibitor": {
            // @ts-expect-error runtime-correct; TS TS2571 is a @girs typing gap
            const appId = (_params as GLib.Variant).deepUnpack()[0] as string
            invocation.return_value(new GLib.Variant("(b)", [addInhibitor(appId)]))
            break
          }
          case "RemoveInhibitor": {
            // @ts-expect-error runtime-correct; TS TS2571 is a @girs typing gap
            const appId = (_params as GLib.Variant).deepUnpack()[0] as string
            invocation.return_value(new GLib.Variant("(b)", [removeInhibitor(appId)]))
            break
          }
          case "ClearInhibitors":
            invocation.return_value(new GLib.Variant("(b)", [clearInhibitors()]))
            break
          case "NumberOfInhibitors":
            invocation.return_value(new GLib.Variant("(u)", [inhibitors().length]))
            break
          case "IsInhibited":
            invocation.return_value(new GLib.Variant("(b)", [inhibitors().length > 0]))
            break
          default:
            invocation.return_dbus_error(
              "org.freedesktop.DBus.Error.UnknownMethod",
              `unknown method ${method}`,
            )
        }
      },
      null,
      null,
    )
    swayncOwnerId = Gio.bus_own_name(
      Gio.BusType.SESSION,
      SWAYNC_CC_NAME,
      Gio.BusNameOwnerFlags.NONE,
      () => log("swaync-compat name owned (org.erikreider.swaync.cc)"),
      () => log("swaync-compat name lost"),
      null,
    )
    void swayncOwnerId
  } catch (e) {
    log(`swaync-compat export failed (inhibitors still work over the request API): ${e}`)
  }
}

/** Relative-timestamp refresh — cards register a callback; the 60s clock drives them. */
const tickSubs = new Set<() => void>()
export function onClockTick(cb: () => void): () => void {
  tickSubs.add(cb)
  return () => tickSubs.delete(cb)
}

function startClock(): void {
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => {
    for (const cb of [...tickSubs]) {
      try {
        cb()
      } catch (e) {
        log(`clock tick failed: ${e}`)
      }
    }
    return GLib.SOURCE_CONTINUE
  })
}
