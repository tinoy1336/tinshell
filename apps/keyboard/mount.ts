/**
 * keyboard app — the on-screen keyboard surface as a REAL standalone app
 * (bus io.Astal.keyboard). Sources live here (windows, keys, layouts).
 * Config-gated: keyboard.enabled=false → stub + no-op, NO keyboard module
 * ever imported (the memory guarantee; esbuild defers the dynamic imports).
 *
 * Production runs inside the shell; this island is the DEV shape.
 * Config: the keyboard's OWN store + facade (./config — keyboardEnabled gate).
 */
import "@common/log/debug-log" // sets the ONE sink (file /tmp/tinshell-debug.log)
import { register } from "@common/commands/registry"
import { ignore } from "@common/log/logger"
import theme from "@common/shell/theme.css"
import { run } from "@common/subprocess/run"
import { keyboardEnabled } from "./config"
import type { KeyboardControl } from "./Main"

const KB_ENABLED = keyboardEnabled()

/** The ydotool liveness probe is one `systemctl is-active` call: bound it, so a
 *  wedged systemctl cannot stall the keyboard's first key. */
const YDOTOOLD_PROBE_TIMEOUT_MS = 3_000

// Keyboard module references — captured at boot when enabled, null otherwise.
let kbBuildWindow: (() => KeyboardControl) | null = null
let kbSetControl: ((c: KeyboardControl) => void) | null = null
let kbRefreshCss: (() => void) | null = null
let kbStartTabletWatchdog: (() => void) | null = null
let kbStopRepeat: (() => void) | null = null
let kbOnConfigChanged: ((cb: () => void) => () => void) | null = null
let kbCssOnly = ""

export let keyboardCss = theme

if (KB_ENABLED) {
  // Import the keyboard's command tree + main-body modules ONLY when enabled.
  // (esbuild inlines the code in the bundle, but the module bodies — GI
  // imports, widget trees, state — run only when the dynamic import resolves.)
  const { default: KeyboardMain } = await import("./Main")
  const kbCommands = await import("./commands")
  const kbStyle = await import("./style")
  const kbTablet = await import("./tablet")
  const kbRepeat = await import("./keys/repeat")
  const kbConfig = await import("./config")
  const kbCss = (await import("./style.css")).default

  // SAFETY: KeyboardMain builds the keyboard surface WINDOW; the control object is wired
  // separately via kbSetControl. The declared () => KeyboardControl type on the builder
  // is a legacy mismatch (the build fn returns a window), runtime-correct.
  kbBuildWindow = KeyboardMain as unknown as () => KeyboardControl
  kbSetControl = kbCommands.setControl
  kbRefreshCss = kbStyle.refreshCss
  kbStartTabletWatchdog = kbTablet.startTabletWatchdog
  kbStopRepeat = kbRepeat.stopRepeat
  kbOnConfigChanged = kbConfig.store.onConfigChanged.bind(kbConfig.store)
  kbCssOnly = "\n" + kbCss
  keyboardCss = theme + kbCssOnly
} else {
  // Stub shadows the whole keyboard subtree.
  register(["keyboard"], (_args, res) => {
    res("keyboard: disabled (keyboard.enabled=false)")
  })
}

/** Keyboard (gated): ydotool daemon, window + control, tablet watchdog, live
 *  rebuild. No-op when keyboard.enabled=false (stub registered at import). */
export function keyboardMount(): void {
  if (
    !KB_ENABLED ||
    !kbBuildWindow ||
    !kbSetControl ||
    !kbRefreshCss ||
    !kbStartTabletWatchdog ||
    !kbOnConfigChanged
  ) {
    return
  }
  // ydotool daemon (uinput backend) up before any key goes out — no-op
  // when it's already running. A failed PROBE also attempts the start: the
  // keyboard must not lose its backend because systemctl itself misbehaved.
  const startYdotoold = (): void => {
    void run(["systemd-run", "--user", "--unit=ydotoold", "--collect", "ydotoold"]).catch((e) =>
      ignore("ydotoold autostart", e),
    )
  }
  void run(["systemctl", "--user", "is-active", "ydotoold"], {
    timeoutMs: YDOTOOLD_PROBE_TIMEOUT_MS,
  })
    .then((r) => {
      if (r.exit !== 0) startYdotoold()
    })
    .catch((e: Error) => {
      ignore("ydotoold probe", e)
      startYdotoold()
    })

  // Dynamic tokens (config.appearance.*) via a display-level provider.
  kbRefreshCss()

  // Build the window once; expose its control surface to the dispatcher.
  const kbWin = kbBuildWindow()
  kbSetControl(kbWin)

  // 500ms SW_TABLET_MODE poll → edge-triggered show/hide (wired in Main).
  kbStartTabletWatchdog()

  // Live config changes: rebuild rows (layout/keyScale) and refresh the
  // dynamic CSS (appearance.*). Facade-filtered — fires only on KEYBOARD
  // subtree changes.
  kbOnConfigChanged(() => {
    kbWin.rebuild()
    kbRefreshCss!()
  })
}

/** Quit → stop the keyboard's client-side key repeat. */
export function keyboardShutdown(): void {
  kbStopRepeat?.()
}
