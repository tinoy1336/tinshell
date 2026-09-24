/**
 * Request handlers for the keyboard — `ags -i shell request "keyboard ..."`.
 *
 * Handlers register against the shared command registry
 * (common/commands/registry). The control surface is injected from app.ts
 * (the window owner). `key <keysym>` is a DEBUG command (injects a key via
 * the real ydotool path — used for headless verification without touching the
 * screen).
 */

import { createArrayAwareCoerce, registerConfigCommands } from "@common/commands/config-commands"
import { register } from "@common/commands/registry"
import { all, get as getConfig, reloadConfig, set as setConfig } from "./config"
import { sendKeyChecked } from "./keys/backend"
import { repeatInfo } from "./keys/repeat"
import type { KeyboardControl } from "./Main"
import { buildDynamicCss } from "./style"
import { setTabletOverride, tabletInfo } from "./tablet"

let control: KeyboardControl | null = null

export function setControl(c: KeyboardControl | null): void {
  control = c
}

/** Array values (appearance.*.rgb colours) parse from JSON through the
 *  shared array-aware coercion; every other shape uses its scalar fallback. */
const coerce = createArrayAwareCoerce(getConfig)

// ── Handler registrations ──

register(["keyboard", "toggle"], (_t, res) => {
  control?.toggle()
  res("ok")
})

register(["keyboard", "show"], (_t, res) => {
  control?.show()
  res("ok")
})

register(["keyboard", "hide"], (_t, res) => {
  control?.hide()
  res("ok")
})

register(["keyboard", "ping"], (_t, res) => {
  res(control ? "pong" : "error: no control")
})

// Re-fit the keyboard for the current monitor transform (rotation). The
// auto-rotate script calls this the instant it rotates the display, so the
// rows re-fit without waiting for the keyboard's own 2s poll.
register(["keyboard", "rebuild"], (_t, res) => {
  control?.refreshMonitorWidth()
  res("ok")
})

register(["keyboard", "status"], (_t, res) => {
  res(control?.status() ?? "error: no control")
})

register(["keyboard", "layout", "set"], (a, res) => {
  if (!a[0]) {
    res("error: usage layout set <standard|thumbs>")
    return
  }
  res(control?.setLayout(a[0]) ?? "error: no control")
})

register(["keyboard", "layout", "next"], (_t, res) => {
  res(control?.nextLayout() ?? "error: no control")
})

register(["keyboard", "layout", "get"], (_t, res) => {
  res(control?.getLayout() ?? "error: no control")
})

register(["keyboard", "show-mode", "set"], (a, res) => {
  if (!a[0] || !["auto", "show", "hide"].includes(a[0])) {
    res("error: usage show-mode set <auto|show|hide>")
    return
  }
  res(control?.setShowMode(a[0]) ?? "error: no control")
})

register(["keyboard", "show-mode", "get"], (_t, res) => {
  res(control?.getShowMode() ?? "error: no control")
})

register(["keyboard", "tablet", "set"], (a, res) => {
  if (!a[0] || !["on", "off", "auto"].includes(a[0])) {
    res("error: usage tablet set <on|off|auto>")
    return
  }
  setTabletOverride(a[0] as "on" | "off" | "auto")
  res("ok")
})

register(["keyboard", "tablet", "get"], (_t, res) => {
  res(tabletInfo())
})

register(["keyboard", "repeat", "get"], (_t, res) => {
  res(repeatInfo())
})

register(["keyboard", "key"], async (a, res) => {
  if (!a[0]) {
    res("error: usage key <keysym>")
    return
  }
  const ok = await sendKeyChecked(a[0])
  res(ok ? `sent ${a[0]}` : `error: ydotool failed for '${a[0]}'`)
})

// Debug diagnostics (dev surface).
register(["keyboard", "debug", "css"], (_t, res) => {
  res(buildDynamicCss())
})

register(["keyboard", "debug", "tree"], (_t, res) => {
  res(control?.debugTree() ?? "error: no control")
})

// Config (standardized replies).
registerConfigCommands(
  "keyboard",
  {
    get: getConfig,
    set: setConfig,
    reloadConfig,
    all,
  },
  { coerce },
)
