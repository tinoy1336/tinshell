/**
 * LockScreen — the in-session session lock.
 *
 * Runs only when TINSHELL_GREETER_MODE=lock (launched by hypridle's lock_cmd,
 * e.g. after `loginctl lock-session`). It acquires a REAL compositor-enforced
 * lock via ext-session-lock-v1 (gi://Gtk4SessionLock — NOT the layer-shell
 * namespace) and authenticates the process owner with PAM (AstalAuth.Pam).
 * On PAM success it calls inst.unlock(); Escape only clears the password
 * (a lock screen never unlocks on Escape).
 *
 * One LoginCard + one Gtk.Window per monitor (the ::monitor signal fires once
 * per monitor after lock; the library presents/unmaps/destroys the window, so
 * present() must never be called here). gi://Gtk4SessionLock and gi://AstalAuth
 * are lazy-imported so greet/preview mode never load them.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { run } from "@common/subprocess/run"
import { type Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import LoginCard, { type LoginCardHandle } from "../login/card"
import {
  GREETER_WALLPAPER,
  makeEscapeController,
  overlayBackdrop,
  wallpaperBackdrop,
} from "../login/window"
import GreeterDock from "../strip/Strip"
import { buildLockSurface } from "./surface"

export default function LockScreen(): void {
  let inst: any = null

  // Authenticate a submitted password against the process owner via PAM.
  function auth(password: string, handle: LoginCardHandle): void {
    handle.setBusy(true)
    import("gi://AstalAuth")
      .then((m) => {
        const Pam = m.default.Pam
        Pam.authenticate(password, (_src: any, res: any) => {
          try {
            Pam.authenticate_finish(res)
            console.log("[lock] authenticated — unlocking")
            inst.unlock()
          } catch (e: any) {
            console.error(`[lock] auth failed: ${e?.message ?? e}`)
            handle.setBusy(false)
            handle.authFailed(String(e?.message ?? e))
          }
        })
      })
      .catch((e: any) => {
        console.error(`[lock] AstalAuth unavailable: ${e?.message ?? e}`)
        handle.setBusy(false)
        handle.setStatus("Auth backend unavailable", "error")
      })
  }

  import("gi://Gtk4SessionLock")
    .then(async (m) => {
      const SL = m.default
      if (!SL.is_supported()) {
        console.error("[lock] session lock protocol unsupported")
        app.quit()
        return
      }

      // Query the current awww wallpaper BEFORE locking (desktop still
      // visible). Best-effort — null on any failure (falls back to the solid
      // backdrop).
      let wallpaperPath: string | null = null
      try {
        const res = await run(["awww", "query"], { timeoutMs: 2000 })
        if (res.exit === 0) {
          const mt = res.stdout.match(/currently displaying: image: (.*)/)
          if (mt) wallpaperPath = mt[1].trim()
        }
      } catch (e: any) {
        console.error(`[lock] awww query failed: ${e?.message ?? e}`)
      }
      // Best-effort sync to the greeter login wallpaper so the NEXT login
      // screen shows the same wallpaper. Fails harmlessly if the target is
      // not yet created or writable.
      if (wallpaperPath) {
        try {
          const src = Gio.File.new_for_path(wallpaperPath)
          const dst = Gio.File.new_for_path(GREETER_WALLPAPER)
          // Gio.File.copy(OVERWRITE) unlinks the destination first, which
          // needs write on the /etc/greetd/tinshell-greeter DIRECTORY (greeter-
          // owned, not writable by tinoy). Truncate in place instead:
          // load the source bytes and replace_contents with
          // G_FILE_CREATE_NONE (O_TRUNC on the world-writable file, no dir
          // write needed).
          const [ok, contents] = src.load_contents(null)
          if (ok) dst.replace_contents(contents, null, false, Gio.FileCreateFlags.NONE, null)
        } catch (e: any) {
          console.error(`[lock] greeter wallpaper sync failed: ${e?.message ?? e}`)
        }
      }

      inst = new SL.Instance()
      inst.connect("failed", () => {
        console.error("[lock] failed to acquire session lock")
        app.quit()
      })
      inst.connect("unlocked", () => {
        // ::unlocked fires SYNCHRONOUSLY inside unlock(), BEFORE the
        // unlock_and_destroy request is sent (gtk4-layer-shell v1.3.0 emits
        // the signal first, then sends the request + roundtrips). Quitting
        // here kills the process before Hyprland sees the unlock → the
        // "crashed lockscreen" (lockdead) screen. Defer the quit so unlock()'s
        // internal wl_display_roundtrip completes first (Hyprland sets
        // m_locked=false before the idle callback runs).
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          app.quit()
          return GLib.SOURCE_REMOVE
        })
      })
      inst.connect("monitor", (_: any, monitor: Gdk.Monitor) => {
        // This runs with the compositor lock ALREADY HELD, so the window must be
        // assigned even when building the surface fails: an escaping throw here
        // leaves this output with no lock surface (Hyprland keeps the session
        // locked with nothing to unlock it). The card is built first, the strip
        // is decoration, and lock/surface.ts owns the fallback + logging.
        //
        // The window exists before the dock here, so the applets'
        // panel-Escape controller lands on the real window (strip/host.ts).
        buildLockSurface(
          {
            card: () => {
              const { widget, handle } = LoginCard((_user, pass) => auth(pass, handle), [], {
                lock: true,
              })
              return { widget, handle }
            },
            strip: (win) => GreeterDock({ getWindow: () => win }),
            compose: (card, strip) =>
              wallpaperPath
                ? wallpaperBackdrop(wallpaperPath, card, strip)
                : overlayBackdrop(card, strip),
            escape: (win, handle) => win.add_controller(makeEscapeController(handle)),
          },
          (win, mon) => inst.assign_window_to_monitor(win, mon),
          monitor,
        )
      })
      inst.lock()
    })
    .catch((e: any) => {
      console.error(`[lock] Gtk4SessionLock unavailable: ${e?.message ?? e}`)
      app.quit()
    })
}
