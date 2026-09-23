/**
 * notifications entry point — the notifications surface standalone
 * (bus io.Astal.notifications).
 *
 * Production runs inside the shell; this island is the DEV shape.
 * ONE-OWNER RULE: claims org.freedesktop.Notifications — never run shell and
 * this island at the same time. The router (tinshell-route.sh + route-map.conf:
 * notifications=shell,notifications) picks the live instance.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createApp } from "@common/app/start"
import { notificationsCss, notificationsMount } from "./mount"

// ONE-OWNER DIAGNOSTIC (island only): if another process already owns
// org.freedesktop.Notifications (e.g. the production shell is live), this
// island will run WITHOUT the daemon — popups/centre still work but the
// daemon lives elsewhere. AstalNotifd fails SILENTLY in that case, so probe
// the bus BEFORE claiming and shout loudly when the one-owner rule is about
// to be violated.
try {
  // call_sync returns the reply Variant — (s) tuple — or null/throws when the
  // name has NO owner (the happy path: this island becomes the daemon).
  const reply = Gio.DBus.session.call_sync(
    "org.freedesktop.DBus",
    "/org/freedesktop/DBus",
    "org.freedesktop.DBus",
    "GetNameOwner",
    GLib.Variant.new("(s)", ["org.freedesktop.Notifications"]),
    GLib.VariantType.new("(s)"),
    Gio.DBusCallFlags.NONE,
    2000,
    null,
  )
  if (reply) {
    const who = (reply.deepUnpack() as [string])[0] ?? "unknown"
    console.error(
      `[notifications] WARNING: org.freedesktop.Notifications already owned by ${who} ` +
        `(production shell live?). This island runs WITHOUT the notification daemon ` +
        `(one-owner rule: notifications=shell,notifications — stop one of them).`,
    )
  }
} catch (e) {
  // no owner on the bus — this island becomes the daemon (expected).
  console.error(`[notifications] one-owner probe: no owner (island claims the daemon) — ${e}`)
}

createApp({
  instanceName: "notifications",
  css: notificationsCss,
  main() {
    notificationsMount()
  },
})
