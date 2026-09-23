/**
 * notifications app — the notifications surface as a REAL standalone app
 * (bus io.Astal.notifications). Sources live here (Centre, Popups, Notifd,
 * NotificationCard). ONE-OWNER RULE: mounts org.freedesktop.Notifications
 * (AstalNotifd daemon) — never run two instances that both call
 * notificationsMount() (the shell OR this island, not both).
 *
 * Production runs inside the shell; this island is the DEV shape.
 * Config: the notifications app's OWN store + facade (apps/notifications/
 * config.ts owns the createConfigStore instance; generic facade from
 * common/config/facade.ts).
 *
 * The sheet is theme + this app's static style + the shared label-button row
 * rule (common/css/card-chrome) + the config-driven block: the popups'
 * action row is a FlowBox, and the row rule is what keeps its child wrappers
 * from painting a second box behind a button.
 */
import "./commands"
import "@common/log/debug-log" // sets the ONE sink (file /tmp/tinshell-debug.log)
import { labelButtonRowCss } from "@common/css/card-chrome"
import theme from "@common/shell/theme.css"
import Centre, { centreControl } from "./Centre"
import { setControl } from "./commands"
import { log } from "./log"
import { initNotifd } from "./Notifd"
import Popups from "./Popups"
import { buildDynamicCss } from "./style"
import style from "./style.css"

export const notificationsCss = `${theme}\n${style}\n${labelButtonRowCss}\n${buildDynamicCss()}`

/** Notifications: daemon wiring (one-owner), popups overlay, control centre. */
export function notificationsMount(): void {
  // Daemon wiring (claims org.freedesktop.Notifications — one-owner rule),
  // popups overlay, control centre + dispatcher control surface.
  initNotifd()
  Popups()
  Centre()
  setControl(centreControl())
  log("notifications up")
}
