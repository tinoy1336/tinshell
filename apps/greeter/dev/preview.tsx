/**
 * Dev-only windowed prototypes — `TINSHELL_GREETER_PREVIEW=1|login|lock`.
 *
 * Both build the REAL card + the REAL dock applet strip into a plain
 * Gtk.Window (NOT layer-shell) so they tile on the spare workspace preview.sh
 * pins them to: no greetd IPC, no session lock, no PAM. They exist so the login
 * and lock layouts can be iterated in the live session without touching the
 * production paths (login/window.tsx, lock/screen.tsx).
 *
 * Imported LAZILY from app.ts, so a production run never evaluates this module.
 */
import { Gtk } from "ags/gtk4"
import LoginCard from "../login/card"
import type { SessionEntry } from "../login/sessions"
import { makeEscapeController, overlayBackdrop } from "../login/window"
import GreeterDock from "../strip/Strip"

/** Login card in a plain window. The window is transparent on purpose — the
 *  live session's wallpaper + global blur show through, the same image + frost
 *  the real login screen gets from its compositor. */
export function openLoginPreview(card: Gtk.Widget): void {
  const win = new Gtk.Window({
    title: "TINSHELL greeter (preview)",
    default_width: 960,
    default_height: 640,
  })
  // Match window.greeter in style.css; the production window gets the class
  // from login/window.tsx.
  win.add_css_class("greeter")
  const dock = GreeterDock({ getWindow: () => win })
  win.set_child(overlayBackdrop(card, dock))
  win.present()
}

/** Lock card in a plain window: the same composition as lock/screen.tsx minus
 *  the session lock and PAM — submit only reports status. */
export function openLockPreview(): void {
  const win = new Gtk.Window({
    title: "TINSHELL greeter (preview)",
    default_width: 960,
    default_height: 640,
  })
  win.add_css_class("greeter")
  const { widget, handle } = LoginCard(
    (_user: string, _pass: string, _session: SessionEntry) => {
      handle.setStatus("Preview: unlock (PAM not invoked)", "info")
      handle.setBusy(false)
    },
    [],
    { lock: true },
  )
  const dock = GreeterDock({ getWindow: () => win })
  win.add_controller(makeEscapeController(handle))
  win.set_child(overlayBackdrop(widget, dock))
  win.present()
}
