import Gio from "gi://Gio"
import GLib from "gi://GLib"
import type { PowerAction } from "@common/applets/types"
import { runSessionTransition } from "@common/session"
import { createStateStore } from "@common/state"
import { run } from "@common/subprocess/run"

// The persisted inhibit intent (`sleepInhibit`): the logind fd dies with this
// backend process (crash/restart closes it and logind releases the lock), so
// the user's choice lives in this store and is re-applied here at startup via
// restoreInhibitState().
const sleepInhibitStore = createStateStore<"sleepInhibit">({
  app: "power",
  version: 1,
  keys: { sleepInhibit: (v: unknown) => typeof v === "boolean" },
})

// fd list returned by logind Inhibit — holding the reference keeps the
// inhibitor alive; dropping it (set to null) closes the fd and releases.
let inhibitFdList: any = null
// Generation counter + pending sentinel: the logind Inhibit round-trip is
// async, but the UI must flip synchronously. Toggling ON parks the sentinel so
// isInhibitActive() reads true instantly; the async completion later replaces
// it with the real fd — unless a newer toggle superseded it (generation
// mismatch → the stale completion is discarded, so a rapid on→off can't
// resurrect the lock).
let inhibitGen = 0
const INHIBIT_PENDING = "pending"

function persistInhibit(on: boolean): void {
  sleepInhibitStore.set("sleepInhibit", on)
}

/** Issue the logind Inhibit(idle) call and hold the returned fd list. */
function requestInhibit(gen: number): void {
  Gio.DBus.system.call_with_unix_fd_list(
    "org.freedesktop.login1",
    "/org/freedesktop/login1",
    "org.freedesktop.login1.Manager",
    "Inhibit",
    new GLib.Variant("(ssss)", [
      "idle",
      "ags-applets",
      "TINSHELL applets backend: sleep inhibit",
      "block",
    ]),
    new GLib.VariantType("(h)"),
    Gio.DBusCallFlags.NONE,
    -1,
    null,
    null,
    (_obj: any, res: any) => {
      // Superseded by a newer toggle — never apply a stale fd.
      if (gen !== inhibitGen) return
      try {
        const result = Gio.DBus.system.call_with_unix_fd_list_finish(res) as [GLib.Variant, any]
        const [, fdList] = result
        inhibitFdList = fdList
      } catch (e) {
        print(`[power] Inhibit DBus call failed: ${e}`)
        // Roll the optimistic sentinel back — no lock was actually acquired.
        if (inhibitFdList === INHIBIT_PENDING) {
          inhibitFdList = null
          persistInhibit(false)
        }
      }
    },
  )
}

function releaseInhibit(): void {
  inhibitFdList = null
}

function spawn(cmd: string): void {
  try {
    GLib.spawn_command_line_async(cmd)
  } catch (e) {
    print(`[power] spawn failed for "${cmd}": ${e}`)
  }
}

/** Session-lifecycle command with a checked exit: a rejection (an unknown user,
 *  a session that cannot be locked) throws, so the overlay that announces the
 *  transition dismisses instead of covering a session that never went away.
 *  logind reports such a failure through its exit status, a bare spawn does
 *  not. */
const SESSION_CMD_TIMEOUT_MS = 5000

async function runSessionCommand(argv: string[]): Promise<void> {
  const res = await run(argv, { timeoutMs: SESSION_CMD_TIMEOUT_MS, captureStderr: true })
  if (res.exit !== 0) throw new Error(`${argv.join(" ")} exited ${res.exit}: ${res.stderr.trim()}`)
}

export async function executePowerAction(action: PowerAction): Promise<void> {
  switch (action) {
    case "sleep":
      spawn("systemctl suspend")
      break
    case "hibernate":
      spawn("systemctl hibernate")
      break
    case "reboot":
      spawn("systemctl reboot")
      break
    case "shutdown":
      spawn("systemctl poweroff")
      break
    case "logout":
      // hyprshutdown's hl.dsp.exit() lands non-cleanly on 0.56.2, so the
      // start-hyprland watchdog restarts Hyprland in safe mode instead of
      // ending the session. End the whole session via logind instead — no
      // watchdog restart possible, greetd returns to the login screen.
      await runSessionTransition("logout", () =>
        runSessionCommand(["loginctl", "terminate-user", GLib.get_user_name()]),
      )
      break
    case "lock":
      // logind routes the lock request to hypridle's lock_cmd (the greeter's
      // ext-session-lock bundle); the overlay covers the gap until that surface
      // paints.
      await runSessionTransition("lock", () => runSessionCommand(["loginctl", "lock-session"]))
      break
    case "inhibit":
      if (inhibitFdList === null) {
        // Optimistic flip: park the sentinel so the UI reflects ON instantly;
        // the real logind fd lands async (generation-guarded in requestInhibit).
        inhibitFdList = INHIBIT_PENDING
        inhibitGen++
        requestInhibit(inhibitGen)
        persistInhibit(true)
      } else {
        // Uninhibit — drop the fd (or pending sentinel) and release the lock.
        releaseInhibit()
        inhibitGen++ // discard any in-flight Inhibit completion
        persistInhibit(false)
      }
      break
  }
}

export function isInhibitActive(): boolean {
  return inhibitFdList !== null
}

/** Re-apply the persisted inhibit at startup — the fd dies with the dock
 *  (crash/restart closes it and logind releases the lock), so a saved "1"
 *  is re-established here. No-op when the file is missing or "0". */
export async function restoreInhibitState(): Promise<void> {
  const inhibited = sleepInhibitStore.get("sleepInhibit")
  if (inhibited !== true) return
  if (inhibitFdList === null) {
    // Same optimistic flip as the toggle: show the restored ON intent
    // immediately; the fd lands async (generation-guarded).
    inhibitFdList = INHIBIT_PENDING
    inhibitGen++
    requestInhibit(inhibitGen)
  }
}
