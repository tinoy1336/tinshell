/**
 * The greetd login flow — AstalGreet/PAM wiring for the login card.
 *
 * greetd IPC goes through the Greeter object, not the one-shot `Greet.login()`
 * (PAM can issue several auth requests). One Greeter lives for the app's
 * lifetime; every submit re-creates the PAM flow (`create_session`). The
 * signal handlers read a mutable `current` holder (user/password/session) that
 * `startAuth` refreshes on EVERY submit — retries post the CURRENT values,
 * never the first attempt's (a per-submit parameter capture would re-post the
 * first attempt's password).
 *
 * gi://AstalGreet is loaded LAZILY on the first submit: preview mode never
 * touches the typelib, so the UI can be iterated in the live session before it
 * is installed (in production the import resolves before PAM prompts).
 *
 * Auth errors NEVER auto-restart the flow: an auto-retry would re-post the same
 * wrong password and pam_faillock (deny=9, unlock_time=0) locks the account
 * after a single manual mistake. The card unlocks and waits for the user.
 */
import GLib from "gi://GLib"
import app from "ags/gtk4/app"
import { harness, lockMode, preview } from "../mode"
import { writeLastUser } from "../state"
import type { LoginCardHandle } from "./card"
import type { SessionEntry } from "./sessions"

/** Wire the Greeter to the card handle; returns the submit handler. */
export function wireGreeter(
  handle: LoginCardHandle,
): (user: string, pass: string, session: SessionEntry) => void {
  let greeter: any = null
  let current: { user: string; password: string; session: SessionEntry } | null = null

  function connectGreeter(Greet: any): any {
    const g = new Greet.Greeter()
    g.connect("visible-request", (_: any, msg: any) => {
      console.log(`[greeter] visible-request: ${msg}`)
      g.post_auth(current!.user)
    })
    g.connect("secret-request", (_: any, msg: any) => {
      console.log(`[greeter] secret-request: ${msg}`)
      g.post_auth(current!.password)
    })
    g.connect("info-message", (_: any, msg: any) => {
      console.log(`[greeter] info: ${msg}`)
      handle.setStatus(String(msg), "info")
    })
    g.connect("error-message", (_: any, msg: any) => {
      // Wrong password / unknown user: promptd's wrong-password treatment —
      // error text + red mask, card stays up, WAIT for the user to retry.
      handle.setBusy(false)
      handle.authFailed(String(msg))
    })
    g.connect("cancelled", (_: any, err: any) => {
      handle.setBusy(false)
      const desc = err?.description ?? err?.message ?? ""
      if (desc) handle.authFailed(String(desc))
      else handle.setStatus("Authentication cancelled — try again", "info")
    })
    g.connect("authenticated", () => {
      console.log(`[greeter] authenticated — starting session ${current!.session.name}`)
      g.start_session(current!.session.exec, current!.session.env, (_: any, res: any) => {
        try {
          g.start_session_finish(res)
        } catch (e: any) {
          console.error(`[greeter] start_session failed: ${e?.message ?? e}`)
          handle.setBusy(false)
          handle.setStatus(`Failed to start session: ${e?.message ?? e}`, "error")
          return
        }
        console.log("[greeter] session started")
        if (preview || harness || lockMode) {
          // Dev modes never hand off to a real session (the harness's dummy
          // greetd ends here). NEVER spawn the handoff outside production — in
          // harness it would SIGKILL the user's real compositor.
          console.log("[greeter] dev mode — quitting greeter")
          app.quit()
          return
        }
        // PRODUCTION handoff: never quit. Show the freeze frame and SIGKILL the
        // greeter compositor tree (greeter-handoff.sh) so the framebuffer keeps
        // wallpaper + "Logging in..." until the user session paints over it.
        // The app exits on its own when the compositor dies under it.
        handle.setStatus("Logging in...", "info")
        try {
          GLib.spawn_command_line_async("/etc/greetd/greeter-handoff.sh")
        } catch (e: any) {
          console.error(`[greeter] handoff spawn failed: ${e?.message ?? e}`)
        }
      })
    })
    return g
  }

  return function startAuth(user: string, password: string, session: SessionEntry): void {
    // Refresh the mutable holder BEFORE any handler can fire: the closures read
    // this at call time, so a retry posts the CURRENT password.
    current = { user, password, session }
    writeLastUser(user)
    if (!greeter) {
      import("gi://AstalGreet")
        .then((m) => {
          greeter = connectGreeter(m.default)
          greeter.create_session(user)
        })
        .catch((e: any) => {
          console.error(`[greeter] AstalGreet unavailable: ${e?.message ?? e}`)
          handle.setBusy(false)
          handle.setStatus("Login backend unavailable", "error")
        })
      return
    }
    greeter.create_session(user)
  }
}
