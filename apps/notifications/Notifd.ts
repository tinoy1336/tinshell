/**
 * AstalNotifd wiring — daemon ownership + the app's reactive state.
 *
 * The FIRST AstalNotifd.Notifd instantiation claims org.freedesktop.Notifications
 * (one-owner rule — that name has exactly one daemon). This module:
 *
 *   - claims the daemon and sets ignore-timeout=true: WE drive expiry from
 *     config popup.timeout/timeoutLow/timeoutCritical (urgency-tiered;
 *     critical 0 = sticky) — the urgency tier decides the clock, not the
 *     clients' timeouts;
 *   - owns DND end to end: the reactive mirror, the daemon's shared
 *     dont-disturb value, and the durable copy in the app's state store
 *     (`~/.local/state/tinshell/apps/notifications/state.json`). DND is the
 *     running mode of the popup gate, not configuration — the surface flips it
 *     — so a toggle never rewrites the config file;
 *   - keeps the reactive state consumed by Popups/Centre: notifications
 *     (unresolved, newest first — what the popups render), history (EVERY
 *     notification seen this session, newest first, each flagged live while the
 *     daemon still holds it — what the centre lists), popup ids, inhibitors,
 *     centre visibility;
 *   - separates the two kinds of removal: a DISMISS takes a notification off
 *     the screen and leaves its history entry standing (the popup is transient,
 *     the centre is what the user reads back), while `forget` removes the entry
 *     from the history and `closeAll` wipes both;
 *   - arms per-notification expiry timers ONLY when a popup is shown (a DND'd
 *     or inhibited notification stays in the centre until dismissed — the
 *     timeout timer lives in the popup window, not the daemon).
 */
import AstalNotifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createStateStore } from "@common/state"
import { createState } from "ags"
import { get, store } from "./config"
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

/** One button of an in-process notification: the label the card renders and
 *  the handler its press runs. */
export interface NotificationAction {
  id: string
  label: string
  onInvoke: (body: string) => void
}

/**
 * Send an in-process notification with one or more actions. The buttons render
 * in the order given, and each action's press runs its own `onInvoke(body)`
 * in-process (via registerActionHandler + invokeAction), then the normal
 * hide/dismiss behaviour applies. The daemon assigns the id and emits
 * "notified" — popup + centre render like any other notification.
 */
export function notifyWithAction(opts: {
  summary: string
  body?: string
  appName?: string
  actions: NotificationAction[]
}): void {
  try {
    const n = new AstalNotifd.Notification()
    n.app_name = opts.appName ?? "ScreenGrab"
    n.summary = opts.summary
    if (opts.body) n.body = opts.body
    for (const action of opts.actions) {
      // gjs GObject constructors take a PROPERTIES OBJECT — positional args
      // throw "Argument to the constructor of Action should be a plain JS
      // object with properties to set" and kill the whole notification.
      n.add_action(new AstalNotifd.Action({ id: action.id, label: action.label }))
      registerActionHandler(action.id, (noti) => {
        try {
          action.onInvoke(noti.body ?? "")
        } catch (e) {
          log(`in-process action '${action.id}' handler failed: ${e}`)
        }
      })
    }
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

/** One entry of the notification history. */
export interface HistoryEntry {
  noti: AstalNotifd.Notification
  /** The daemon still holds it: it is on screen (or held back by DND/inhibitors)
   *  and its sender actions are live. False once the daemon resolved it — the
   *  entry stays listed, at the same contrast, as history. */
  live: boolean
}

/** Every notification seen this session, newest first — the centre's list. A
 *  resolved notification keeps its entry (see `HistoryEntry.live`), so leaving
 *  the screen never erases what the user read. */
export const [history, setHistory] = createState<HistoryEntry[]>([])

/** Ids currently shown as popups (newest first, capped at popup.maxVisible). */
export const [popupIds, setPopupIds] = createState<number[]>([])
/** Inhibiting app ids. Any entry suppresses popups. */
export const [inhibitors, setInhibitors] = createState<string[]>([])
/** Whether the control centre is visible (open centre suppresses popups). */
const [centreVisible, setCentreVisible] = createState(false)

/**
 * DND is a runtime mode, not configuration: the surface flips it (the centre's
 * bell glyph, Shift+D, `notifications dnd set`), and the value IS the state of
 * the popup gate below. Its durable copy therefore lives in the app's state
 * store — `~/.local/state/tinshell/apps/notifications/state.json` — beside the
 * owner instead of in the config file.
 */
const dndState = createStateStore({
  app: "notifications",
  version: 1,
  keys: { dndEnabled: (v) => typeof v === "boolean" },
})

/**
 * The DND value a boot starts from: the state store's own value when it holds
 * one, otherwise the `dnd.enabled` config key a pre-store build persisted it
 * in — still readable after the schema drop, because the loader's initial load
 * merges the live file without schema filtering — otherwise off. A real value
 * therefore always beats the default.
 */
function storedDnd(): boolean {
  const stored = dndState.get("dndEnabled")
  if (typeof stored === "boolean") return stored
  const legacy = get<boolean | undefined>("dnd.enabled")
  return typeof legacy === "boolean" ? legacy : false
}

/** DND state (the store's value, mirrored into the daemon's `dont_disturb`). */
const [dndEnabled, setDndEnabledState] = createState<boolean>(storedDnd())

/**
 * Carry DND across from the config file it used to be persisted in.
 *
 * The store's own value wins when it has one; otherwise the `dnd.enabled` key a
 * pre-store build wrote is copied across, so the mode the desktop is in does
 * not change at the switch. A store and a key that are both absent are simply
 * off — which is what the dropped config default said — and nothing is written
 * for them, so the default never overrides a real value.
 *
 * The key is then PRUNED from the live config, which is required rather than
 * cosmetic: the root schema is closed, so a leftover `dnd` group makes the next
 * `notifications config reload` refuse the file ("additional property not
 * allowed"). Written through the facade's own two primitives — the in-place
 * live swap and the serialized write chain — so the file and the running tree
 * carry the same key set. Idempotent: a second mount finds nothing to drop.
 *
 * Called from `initNotifd`, the notifications app's own mount, so a process
 * that merely imports a function from this module (the dock's screengrab and
 * battery applets) never writes another app's config.
 */
function migrateDndFromConfig(): void {
  if (typeof dndState.get("dndEnabled") !== "boolean") {
    const legacy = get<boolean | undefined>("dnd.enabled")
    if (typeof legacy === "boolean") dndState.set("dndEnabled", legacy)
  }
  const live = store.all()
  if (!("dnd" in live)) return
  const clone = JSON.parse(JSON.stringify(live))
  delete clone.dnd
  store.applyToLive(clone)
  void store.queueWrite(clone)
}

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

// ── Popup gate ──

/**
 * The gate that decides whether a notification reaches the screen: the centre
 * being open, DND and any inhibitor suppress it, and `critical` urgency is the
 * one class that overrides them.
 */
function shouldShowPopup(n: AstalNotifd.Notification): boolean {
  if (centreVisible()) return false
  const blocked = dndEnabled() || inhibitors().length > 0
  if (blocked && n.urgency !== AstalNotifd.Urgency.CRITICAL) return false
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

/** Dismiss a notification: it leaves the screen (popup and, if it was the
 *  popup's own id, the popup stack) and its HISTORY ENTRY STAYS — the centre
 *  keeps listing it at full contrast. `forget` is the call that removes an entry. */
export function dismiss(id: number): void {
  const n = getNotifd().get_notification(id)
  if (!n) return
  try {
    n.dismiss()
  } catch (e) {
    log(`dismiss(${id}) failed: ${e}`)
  }
}

/** Remove one notification from the history (the centre row's ✕ / Delete):
 *  dismissed from the screen if the daemon still holds it, and dropped from the
 *  list either way. */
export function forget(id: number): void {
  const n = getNotifd().get_notification(id)
  if (n) {
    try {
      n.dismiss()
    } catch (e) {
      log(`forget(${id}) dismiss failed: ${e}`)
    }
  }
  setHistory((prev) => prev.filter((e) => e.noti.id !== id))
}

/** Look up a notification by id (for the request API). */
export function getNotification(id: number): AstalNotifd.Notification | null {
  return getNotifd().get_notification(id)
}

/** Clear All / Shift+C: every unresolved notification is dismissed AND the
 *  history is wiped — the one action that empties the centre's list. */
export function closeAll(): void {
  for (const entry of history()) {
    if (!entry.live) continue
    try {
      entry.noti.dismiss()
    } catch (e) {
      log(`closeAll dismiss(${entry.noti.id}) failed: ${e}`)
    }
  }
  setHistory([])
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
  dndState.set("dndEnabled", v)
}

// ── Inhibitors ──

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
  // Carry DND across from the config key a pre-store build persisted it in,
  // then apply the stored value to the daemon's shared one.
  migrateDndFromConfig()
  setDndEnabledState(storedDnd())
  try {
    getNotifd().dont_disturb = storedDnd()
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
      // Update in place (same id, fresh card) + restart the clock. The history
      // entry goes back to live: the sender re-sent the notification.
      setNotifications((prev) => prev.map((x) => (x.id === id ? noti : x)))
      setHistory((prev) => prev.map((e) => (e.noti.id === id ? { noti, live: true } : e)))
      if (popupIds().includes(id)) armExpiry(noti)
      return
    }
    setNotifications((prev) => [noti, ...prev])
    setHistory((prev) => [{ noti, live: true }, ...prev])
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
    // The entry stays listed: resolution is what takes a notification off the
    // screen, not what erases it from the centre.
    setHistory((prev) => prev.map((e) => (e.noti.id === id ? { noti: e.noti, live: false } : e)))
  })

  // The daemon PERSISTS unresolved notifications in gsettings (io.astal.notifd
  // → "notifications") and restores them at startup — but restore calls
  // add_notification directly, which does NOT emit "notified", so our reactive
  // state would miss them. Seed the centre from the daemon's list (no popups;
  // expiry timers are re-armed below so the pile self-cleans).
  try {
    const existing = (getNotifd().get_notifications() ?? []) as AstalNotifd.Notification[]
    if (existing.length > 0) {
      const ordered = [...existing].sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
      setNotifications(ordered)
      setHistory(ordered.map((n) => ({ noti: n, live: true })))
      // Re-arm per-urgency expiry so a restored pile self-cleans instead of
      // accumulating across restarts (restored notifications have no popup;
      // the timer still applies — critical stays sticky).
      for (const n of existing) armExpiry(n)
      log(`seeded ${existing.length} restored notification(s) into the centre`)
    }
  } catch (e) {
    log(`seed restored notifications failed: ${e}`)
  }

  // Relative-timestamp refresh clock (60s).
  startClock()
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
