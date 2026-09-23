/**
 * App start helper — the cross-app TINSHELL entry-point scaffolding.
 *
 * Wraps `app.start` so each app's `app.ts` shrinks to its app-specific bits:
 * instanceName, css, the main window factory, and (optionally) quit teardown
 * + command-handler module imports (which register against the shared registry
 * at import time). The request handler is wired to the shared dispatcher +
 * normalizer here, so apps never reimplement the argv-normalization dance.
 *
 *   import { createApp } from "@common/app/start"
 *   import "./commands/config"                    // side-effect: registers handlers
 *   createApp({
 *     instanceName: "dock",
 *     css: style,
 *     main() { ... },
 *   })
 *
 * The Gtk runtime is imported DYNAMICALLY inside this module: importing an
 * app's mount module never loads the toolkit, and the `<instance> quit`
 * command is registered SYNCHRONOUSLY (it needs no toolkit) so it exists
 * before any request can arrive.
 */
import GLib from "gi://GLib"
import { dispatch, has, register } from "@common/commands/registry"
import { cancelUnload, ensureLoaded, isLazyApp, isLoaded } from "./lazy"
import { isShell } from "./mode"
import { normalizeRequestArgv } from "./request"

interface AppConfig {
  /** The app's bus name suffix → owns io.Astal.<instanceName>. Also the
   *  namespace of the instance's own `<instanceName> quit` command. */
  instanceName: string
  /** CSS string (each app imports its own style.css). */
  css: string
  /** Build the app's windows. Called once at startup. */
  main: () => void
  /** Teardown for the instance's `<instanceName> quit` request, run before the
   *  process quits. Optional: the quit COMMAND is registered either way — see
   *  createApp — this only adds teardown to it. */
  onQuit?: () => void | Promise<void>
  /** Quit the instance when its last window closes — island parity for a lazy
   *  app hosted as its own singleton (files, media). Ignored in a resident
   *  instance (isShell): a shared host must never die with one window. */
  quitOnLastWindow?: boolean
}

export function createApp(cfg: AppConfig): void {
  // Command-handler modules register themselves at import time. Apps import
  // them at the top of their app.ts (BEFORE createApp is called) so every
  // handler is registered before app.start accepts requests.

  // Every instance must be stoppable through its own request surface: the
  // whole mode-switch path (`tinshell-host stop`, tinshell-mode's stop_islands,
  // restart-shell.sh) stops an instance by sending `<instance> quit`. So this
  // command is registered UNCONDITIONALLY, except where the app already owns
  // that path with richer semantics (the dock's fading quit, which only quits
  // the PROCESS when the dock owns it). Gating it on `onQuit` instead left
  // every app without teardown unstoppable — the D-Bus-activated portal shim
  // answered `unknown command 'quit'`, so nothing could release it and the
  // shell's duplicate-host guard refused to start.
  if (!has([cfg.instanceName, "quit"])) registerQuitCommand(cfg.instanceName, cfg.onQuit)

  void (async () => {
    const app = (await import("ags/gtk4/app")).default
    app.start({
      instanceName: cfg.instanceName,
      css: cfg.css,
      main: cfg.main,
      requestHandler(argv: string[], res: (response: any) => void) {
        const tokens = normalizeRequestArgv(argv)
        const first = tokens[0]
        // Lazy-app pre-step: a request naming a lazy app loads it first, then
        // dispatches. A request naming an ALREADY-loaded app cancels the
        // idle-grace unload timer (reopen must not race the unload that would
        // destroy the freshly-opened window). Fires wherever lazy apps are
        // registered — the shell AND every resident island (universal entry
        // registerLazyApps). Pure-lazy singleton islands register nothing →
        // empty lazy registry → never triggers.
        if (first && isLazyApp(first)) {
          if (isLoaded(first)) cancelUnload(first)
          else {
            ensureLoaded(first).then(
              () => dispatch(tokens, res),
              () => res(`error: failed to load app '${first}'`),
            )
            return
          }
        }
        dispatch(tokens, res)
      },
    })

    if (cfg.quitOnLastWindow && !isShell) {
      app.connect("window-removed", () => {
        if (app.windows.length === 0) app.quit()
      })
    }
  })()
}

/** The reachable quit path. The shim's own quit (App.quit → g_application_quit
 *  → exit(code)) hard-exits the process before GApplication emits ::shutdown,
 *  so app-level teardown can only run on a request command. */
function registerQuitCommand(
  instanceName: string,
  onQuit: (() => void | Promise<void>) | undefined,
): void {
  register([instanceName, "quit"], (_args, res) => {
    // Reply BEFORE the teardown and defer the teardown to an idle callback:
    // the reply reaches the bus only once the main loop resumes this handler
    // (the reply callback is a promise continuation), so quitting in-handler
    // would kill the process before the caller hears an answer — the caller
    // would see a failure for a quit that worked.
    res("quitting")
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      void (async () => {
        try {
          if (onQuit) await onQuit()
        } catch (e) {
          console.error(`[start] quit teardown failed: ${String(e)}`)
        }
        // A failing teardown must never leave the instance wedged alive.
        ;(await import("ags/gtk4/app")).default.quit()
      })()
      return GLib.SOURCE_REMOVE
    })
  })
}
