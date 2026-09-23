/**
 * power-logind — the greeter's power actions, called straight on logind.
 *
 * The greeter's applet DATA comes from the session's applets backend over the
 * shared socket (strip/Strip.tsx), but a peer in the greeter's uid
 * may not drive the session's power state — the socket surface refuses power
 * actions and every other mutator for non-owner peers on purpose. Shutdown and
 * reboot must still work on the login screen, and they must work PRE-LOGIN,
 * where no session, no backend and therefore no socket exist — so the greeter
 * keeps its own logind calls: org.freedesktop.login1.Manager on the system bus,
 * one fire-and-forget call per action.
 *
 * This is the greeter's implementation of `backend.power` (the same interface
 * the applet already calls), NOT a second applet backend: the Power applet's
 * call sites are unchanged.
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import type { AppletBackend } from "@common/applets/backend"
import type { PowerAction } from "@common/applets/types"
import { log } from "@common/log/logger"

const LOGIND_DEST = "org.freedesktop.login1"
const LOGIND_PATH = "/org/freedesktop/login1"
const LOGIND_IFACE = "org.freedesktop.login1.Manager"

/** The call itself is answered immediately by logind (the action proceeds
 *  afterwards), so this only bounds a stuck system bus. */
const CALL_TIMEOUT_MS = 10_000

/** logind method per action. `interactive: true` lets logind run its own
 *  polkit check for the active seat — the same policy `systemctl reboot`
 *  applies, so the login screen keeps the access it has today. */
const LOGIND_METHOD: Partial<Record<PowerAction, string>> = {
  sleep: "Suspend",
  hibernate: "Hibernate",
  reboot: "Reboot",
  shutdown: "PowerOff",
}

function call(method: string): void {
  Gio.DBus.system.call(
    LOGIND_DEST,
    LOGIND_PATH,
    LOGIND_IFACE,
    method,
    new GLib.Variant("(b)", [true]),
    null,
    Gio.DBusCallFlags.NONE,
    CALL_TIMEOUT_MS,
    null,
    (_conn, res) => {
      try {
        Gio.DBus.system.call_finish(res)
      } catch (e) {
        log(`[greeter-power] logind ${method} failed: ${String(e)}`)
      }
    },
  )
}

/** The greeter's `backend.power`: the same interface, logind directly. */
export const greeterPower: AppletBackend["power"] = {
  async executePowerAction(action: PowerAction): Promise<void> {
    const method = LOGIND_METHOD[action]
    if (!method) {
      // `lock`/`logout`/`inhibit` are actions on a SESSION: the greeter has no
      // session of its own to lock or end, and the sleep inhibit is the
      // backend's logind fd (the LockSession applet, which the greeter does not
      // host, is its only caller).
      log(`[greeter-power] '${action}' is a session action — not available on the greeter`)
      return
    }
    call(method)
  },
  isInhibitActive: (): boolean => false,
  restoreInhibitState: async (): Promise<void> => {},
}
