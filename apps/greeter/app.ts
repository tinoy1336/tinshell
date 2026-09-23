/**
 * TINSHELL greeter — boot-level login screen (greetd island).
 *
 * Third app category: BOOT-LEVEL, owned by greetd (NOT a systemd user unit,
 * NOT on-demand). greetd spawns a minimal Hyprland compositor
 * (/etc/greetd/greeter.lua) as user `greeter`; its exec-once runs the bundled
 * app via `/etc/greetd/tinshell-greeter.sh`. The login IPC is the multi-request
 * AstalGreet `Greeter` object (login/auth.ts); the environment-selected
 * products (login / lock / preview / harness) are resolved in mode.ts.
 *
 * THIS FILE IS THE ENTRY: mode dispatch only. The bundle entry must stay a
 * plain .ts — JSX parses only in .tsx — so the surfaces live in login/, lock/
 * and strip/, and the dev-only prototypes in dev/.
 *
 * HANDOFF (production): after start_session_finish the app does NOT quit — it
 * shows "Logging in..." and spawns /etc/greetd/greeter-handoff.sh, which
 * SIGKILLs the greeter compositor tree so the last rendered frame freezes on
 * the framebuffer until the user session paints over it. Logout → greetd
 * respawns this greeter.
 */
import { createApp } from "@common/app/start"
import { buildStampText, registerBuildStampRequest } from "@common/host/build-stamp"
import { log } from "@common/log/logger"
import theme from "@common/shell/theme.css"
import LockScreen from "./lock/screen"
import { wireGreeter } from "./login/auth"
import LoginCard, { type LoginCardHandle } from "./login/card"
import { loadSessions, type SessionEntry } from "./login/sessions"
import GreeterWindow from "./login/window"
import { harness, lockMode, preview, previewLock } from "./mode"
import style from "./style.css"
import { greeterThemeCss } from "./theme"

/** The product this process is running — one of the four documented in mode.ts. */
const product = lockMode
  ? "lock"
  : previewLock
    ? "preview-lock"
    : preview
      ? "preview"
      : harness
        ? "harness"
        : "greetd"

registerBuildStampRequest("greeter", () => [`product: ${product}`])

/** Dev-only submit stub: the preview reports what it WOULD start. Harness mode
 *  takes the real flow — it runs against a dummy greetd. */
function previewSubmit(
  handle: LoginCardHandle,
): (user: string, pass: string, session: SessionEntry) => void {
  return (user: string, _pass: string, session: SessionEntry): void => {
    console.log(`[greeter][preview] would start ${session.name} (${session.type}) as ${user}`)
    handle.setStatus(`Preview: would start ${session.name} as ${user}`, "info")
    handle.setBusy(false)
  }
}

createApp({
  instanceName: "greeter", // io.Astal.greeter (exists only pre-login)
  css: `${theme}\n${style}\n${greeterThemeCss()}`,
  main() {
    // This bundle is a snapshot of apps/greeter/ + common/ taken at build time
    // (build.sh / build-lock.sh, stamped). Which snapshot is running — and
    // whether it still matches the sources — is otherwise invisible from the
    // login screen or the lock, so it is stated at startup and answerable
    // through `greeter debug build`.
    log(`[greeter] ${product}: ${buildStampText()}`)
    if (lockMode) {
      LockScreen()
      return
    }
    if (previewLock) {
      // Windowed LOCK prototype: the same card + dock composition as
      // lock/screen.tsx, but no session lock and no PAM. Loaded lazily so a
      // production run never evaluates the dev prototypes.
      import("./dev/preview")
        .then((m) => m.openLockPreview())
        .catch((e: any) => console.error(`[greeter] preview import failed: ${e?.message ?? e}`))
      return
    }

    const sessions = loadSessions()
    console.log(
      `[greeter] ${preview ? "PREVIEW" : harness ? "HARNESS" : "greetd"} mode — ${sessions.length} session(s) available`,
    )

    let submitFn: (u: string, p: string, s: SessionEntry) => void = () => {}
    const { widget, handle } = LoginCard((u, p, s) => submitFn(u, p, s), sessions)
    submitFn = preview ? previewSubmit(handle) : wireGreeter(handle)

    if (preview || harness) {
      // Plain Gtk.Window (NOT layer-shell) so it tiles on the workspace
      // preview.sh pinned it to. The real dock applet strip rides
      // bottom-centre exactly as in production.
      import("./dev/preview")
        .then((m) => m.openLoginPreview(widget))
        .catch((e: any) => console.error(`[greeter] preview import failed: ${e?.message ?? e}`))
      return
    }

    GreeterWindow(widget, handle)
  },
})
