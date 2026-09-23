/**
 * portal dbus — the xdg-desktop-portal FileChooser backend.
 *
 * Owns the impl-side session-bus name org.freedesktop.impl.portal.desktop.tinshell-portal
 * (SEPARATE from Astal's io.Astal.portal, which app.ts owns) and exports
 * org.freedesktop.impl.portal.FileChooser at /org/freedesktop/portal/desktop
 * (reference-backend convention; export path + method signatures verified
 * live against xdg-desktop-portal-gtk via busctl introspection, and the
 * Request interface against /usr/share/dbus-1/interfaces/*.xml).
 *
 * Protocol facts:
 *  - OpenFile/SaveFile/SaveFiles: in `osssa{sv}` (handle o, app_id s,
 *    parent_window s, title s, options a{sv}), out `ua{sv}` (response u,
 *    results a{sv}). The METHOD REPLY carries the result INLINE — the
 *    backend has NO Response signal. The reply must be DEFERRED until the
 *    user finishes the dialog and sent EXACTLY ONCE on every path
 *    (accept/cancel/window closed). A leaked invocation or a double reply
 *    hangs or crashes the calling app.
 *  - A org.freedesktop.impl.portal.Request object (method Close, no args,
 *    no return — verified) is exported at the exact `handle` object path.
 *    Close() = the app aborted: close the dialog (which replies code 1 via
 *    the response path) and unregister the object.
 *  - Response codes: 0 success, 1 cancelled, 2 ended some other way.
 *  - results a{sv}: `uris as` (file:// URIs) is the only strictly required
 *    key for v1. Nested variants must be explicit GLib.Variant objects.
 *
 * Lifecycle: RESIDENT (WantedBy=default.target) — the
 * xdg-desktop-portal frontend probes this backend at ITS startup via
 * StartServiceByName, and dbus-broker fails to complete that activation
 * when it races the frontend's start (25s GDBus timeout, boot-deadlock;
 * ownName below breaks the Gtk-side half of the cycle). Resident = the
 * name is always owned before the frontend probes, so the probe is
 * instant. Self-quit is absent for the same reason: a stopped unit
 * re-creates the race on later frontend restarts.
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { log } from "@common/log/logger"
import { type ChooserHandle, type ChooserKind, openChooser, parseOptions } from "./chooser"

const BUS_NAME = "org.freedesktop.impl.portal.desktop.tinshell-portal"
const OBJECT_PATH = "/org/freedesktop/portal/desktop"

// Introspection is the least error-prone way to get the exact method/arg
// types onto the bus. Arg names match the installed spec XML.
const fileChooserXml = `
<node>
  <interface name="org.freedesktop.impl.portal.FileChooser">
    <method name="OpenFile">
      <arg type="o" name="handle" direction="in"/>
      <arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/>
      <arg type="a{sv}" name="results" direction="out"/>
    </method>
    <method name="SaveFile">
      <arg type="o" name="handle" direction="in"/>
      <arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/>
      <arg type="a{sv}" name="results" direction="out"/>
    </method>
    <method name="SaveFiles">
      <arg type="o" name="handle" direction="in"/>
      <arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/>
      <arg type="a{sv}" name="results" direction="out"/>
    </method>
  </interface>
</node>`

const requestXml = `
<node>
  <interface name="org.freedesktop.impl.portal.Request">
    <method name="Close"/>
  </interface>
</node>`

const fileChooserIface = Gio.DBusNodeInfo.new_for_xml(fileChooserXml).interfaces[0]
const requestIface = Gio.DBusNodeInfo.new_for_xml(requestXml).interfaces[0]

interface ActiveRequest {
  conn: Gio.DBusConnection
  invocation: Gio.DBusMethodInvocation
  chooser: ChooserHandle
  requestRegId: number
  replied: boolean
}

/** Requests keyed by their handle object path. */
const active = new Map<string, ActiveRequest>()

/**
 * Own the impl-side name BEFORE Gtk init (boot-deadlock fix).
 *
 * xdg-desktop-portal synchronously probes every FileChooser backend at
 * startup via StartServiceByName. Requesting the name only from main() —
 * i.e. AFTER Gtk init — is the bug: Gtk init itself blocks on the portal
 * Settings interface (color-scheme handshake). At boot the two processes
 * race: portal waits for our name, we wait for portal → both stuck until
 * the 25s D-Bus activation timeout breaks the cycle (the shell pays the
 * same 25s penalty on its own GtkSettings portal call).
 *
 * Claiming the name up front (with a short main-context pump so the async
 * connect completes before Gtk starts) lets portal's probe return in
 * milliseconds and keeps the Settings interface responsive.
 */
export function ownName(timeoutMs = 2000): void {
  const t0 = GLib.get_monotonic_time()
  const stamp = () => `t+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(0)}ms`
  log(`[ownName] enter ${stamp()}`)
  let acquired = false
  Gio.bus_own_name(
    Gio.BusType.SESSION,
    BUS_NAME,
    Gio.BusNameOwnerFlags.NONE,
    (conn: Gio.DBusConnection) => {
      // Bus acquired → the connection is usable: export the backend.
      log(`[ownName] bus acquired ${stamp()}`)
      try {
        // 5-arg form: method closure + nullable get/set property closures.
        conn.register_object(OBJECT_PATH, fileChooserIface, onMethodCall, null, null)
        log(`FileChooser registered at ${OBJECT_PATH} ${stamp()}`)
      } catch (e) {
        log(`register_object failed: ${e}`)
      }
    },
    (_conn: Gio.DBusConnection, _name: string) => {
      acquired = true
      log(`[ownName] name acquired ${stamp()}`)
    },
    (_conn: Gio.DBusConnection, _name: string, error?: Error | null) => {
      if (error) log(`name lost: ${error.message} — portal backend unavailable`)
    },
  )

  // Pump the default main context until the name is owned (or we give up).
  // Without this the async connect would only complete once the Gtk main
  // loop starts — after Gtk init, i.e. exactly the race we're breaking.
  const ctx = GLib.MainContext.default()
  const deadline = GLib.get_monotonic_time() + timeoutMs * 1000
  let iters = 0
  while (!acquired && GLib.get_monotonic_time() < deadline) {
    ctx.iteration(false)
    iters++
  }
  log(`[ownName] pump done ${stamp()} iters=${iters} acquired=${acquired}`)
  if (!acquired) log(`name not owned within ${timeoutMs}ms — portal probe will time out`)
}

/** One dispatcher for both the FileChooser object and per-request Request objects. */
function onMethodCall(
  conn: Gio.DBusConnection,
  _sender: string,
  objectPath: string,
  _ifaceName: string,
  methodName: string,
  parameters: GLib.Variant,
  invocation: Gio.DBusMethodInvocation,
): void {
  if (objectPath === OBJECT_PATH) {
    if (methodName === "OpenFile" || methodName === "SaveFile" || methodName === "SaveFiles") {
      handleRequest(conn, methodName, parameters, invocation)
    } else {
      invocation.return_dbus_error(
        "org.freedesktop.DBus.Error.UnknownMethod",
        `Unknown method ${methodName}`,
      )
    }
    return
  }
  // Request object at a handle path.
  if (methodName === "Close") {
    const req = active.get(objectPath)
    if (req && !req.replied) req.chooser.close() // responds code 1 → finish() replies
    invocation.return_value(null)
    return
  }
  invocation.return_dbus_error(
    "org.freedesktop.DBus.Error.UnknownMethod",
    `Unknown method ${methodName}`,
  )
}

function handleRequest(
  conn: Gio.DBusConnection,
  methodName: string,
  parameters: GLib.Variant,
  invocation: Gio.DBusMethodInvocation,
): void {
  // (osssa{sv}) — deep_unpack gives the a{sv} container as a JS object, but
  // each `v` value stays a GLib.Variant; chooser.ts unwraps that layer.
  const [handle, , , title, options] = parameters.deep_unpack() as [
    string,
    string,
    string,
    string,
    Record<string, unknown>,
  ]

  const kind: ChooserKind =
    methodName === "OpenFile" ? "open" : methodName === "SaveFile" ? "save" : "save-many"
  const parsed = parseOptions(kind, options)
  if (title) parsed.title = title // the method arg, not options.title (zenity etc. send it here)
  const chooser = openChooser(kind, parsed)

  // Export the Request object at the exact handle path BEFORE showing the
  // dialog, so Close() can always find it.
  let requestRegId: number
  try {
    requestRegId = conn.register_object(handle, requestIface, onMethodCall, null, null)
  } catch (e) {
    log(`request object register failed at ${handle}: ${e}`)
    chooser.destroy()
    // girs types tuple a{sv} as a JS object map (explicit nested Variants).
    invocation.return_value(new GLib.Variant("(ua{sv})", [2, {}]))
    return
  }

  const req: ActiveRequest = { conn, invocation, chooser, requestRegId, replied: false }
  active.set(handle, req)

  // Deferred reply: the method does NOT reply here — the custom window's
  // response callback fires exactly once when the user finishes (Accept →
  // code 0 + uris; Cancel/Close/window-closed → code 1).
  chooser.onResponse = (code: number, uris: string[]) => {
    let results: Record<string, GLib.Variant> = {}
    if (code === 0) results = { uris: new GLib.Variant("as", uris) }
    finish(handle, code, results)
  }

  chooser.present()
}

/** Reply exactly once + unregister the Request object + free the dialog. */
function finish(handle: string, code: number, results: Record<string, GLib.Variant>): void {
  const req = active.get(handle)
  if (!req || req.replied) return
  req.replied = true
  active.delete(handle)
  try {
    req.invocation.return_value(new GLib.Variant("(ua{sv})", [code, results]))
  } catch (e) {
    log(`reply failed for ${handle}: ${e}`)
  }
  try {
    req.conn.unregister_object(req.requestRegId)
  } catch (e) {
    log(`unregister failed for ${handle}: ${e}`)
  }
  if (req.chooser) req.chooser.destroy()
}
