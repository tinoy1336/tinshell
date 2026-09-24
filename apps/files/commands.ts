/**
 * files request handlers — `ags -i files request ...`.
 *
 * The files app is addressable while it runs (bus io.Astal.files, instance
 * "files"): `open [path]`, `new [path]`, `navigate <path>`, `up` / `back` /
 * `forward` / `reload`, `toggle-hidden`, `mkdir <name>`, `rename <new-name>`,
 * `trash`, `reveal <path>`, `ping`, and the standard
 * `config get|set|reload|all`. Quit is the builtin `ags -i files quit`.
 *
 * Multi-window: `open` surfaces the window a request acts on (the
 * compositor-activated one, else the newest) and creates a window only when
 * none is open; `new` always opens another independent window. Every other
 * per-window command routes to that same active window.
 */

import { registerConfigCommands } from "@common/commands/config-commands"
import { register } from "@common/commands/registry"
import { all, get as getConfig, reloadConfig, set as setConfigRaw, store } from "./config"
import {
  closeActiveBrowser,
  getBrowser,
  newBrowserWindow,
  openPath,
  refreshBrowsers,
} from "./window"

/** Run a handler against the browser window (errors when the window is gone). */
function withBrowser(
  fn: (b: NonNullable<ReturnType<typeof getBrowser>>) => string | void,
  res: (reply: string) => void,
): void {
  const b = getBrowser()
  if (!b) {
    res("error: no window")
    return
  }
  res(fn(b) ?? "ok")
}

register(["files", "ping"], (_t, res) => {
  res("pong")
})

register(["files", "open"], (tokens, res) => {
  // open [path] — surface the browser: focus the window a request acts on
  // (compositor-activated else newest); with a path, navigate to it (no path →
  // startup dir). An existing window is never duplicated — a second one comes
  // from `new` only. Cold-start `open <path>` arrives via run.sh argv instead
  // (app.ts main) — this handler is the WARM path only.
  openPath(tokens.join(" ") || undefined)
  res("ok")
})

register(["files", "new"], (tokens, res) => {
  // new [path] — always open another independent window (no path → the
  // startup dir). Multi-window, the `media new` shape.
  newBrowserWindow(tokens.join(" ") || undefined)
  res("ok")
})

register(["files", "close"], (_t, res) => {
  // App-internal close of the ACTIVE window; the other windows stay open.
  // closeActiveBrowser() runs that window's teardown (drops its handle + arms
  // the unload grace once the last window is gone) BEFORE destroying it — a
  // handle left pointing at a destroyed window makes the next open present() a
  // zombie the compositor keeps mapped (see window.tsx's teardown note).
  // There is no hyprctl window-close here — that path is banned [11d94i].
  if (!closeActiveBrowser()) return res("error: no window")
  res("ok")
})

register(["files", "navigate"], (tokens, res) => {
  if (!tokens[0]) return res("error: usage: navigate <path>")
  withBrowser((b) => {
    b.navigate(tokens.join(" "))
  }, res)
})

register(["files", "up"], (_t, res) => {
  withBrowser((b) => b.up(), res)
})

register(["files", "back"], (_t, res) => {
  withBrowser((b) => b.back(), res)
})

register(["files", "forward"], (_t, res) => {
  withBrowser((b) => b.forward(), res)
})

register(["files", "reload"], (_t, res) => {
  withBrowser((b) => b.reload(), res)
})

register(["files", "toggle-hidden"], (_t, res) => {
  withBrowser((b) => `hidden: ${b.toggleHidden()}`, res)
})

register(["files", "mkdir"], (tokens, res) => {
  if (!tokens[0]) return res("error: usage: mkdir <name>")
  withBrowser((b) => {
    const r = b.mkdir(tokens.join(" "))
    return r.ok ? "ok" : `error: ${r.error}`
  }, res)
})

register(["files", "rename"], (tokens, res) => {
  if (!tokens[0]) return res("error: usage: rename <new-name>")
  withBrowser((b) => {
    const r = b.renameSelected(tokens.join(" "))
    return r.ok ? "ok" : `error: ${r.error}`
  }, res)
})

register(["files", "trash"], (_t, res) => {
  withBrowser((b) => {
    b.trashSelected() // async (confirm via promptd) — result lands in the status bar
  }, res)
})

register(["files", "reveal"], (tokens, res) => {
  if (!tokens[0]) return res("error: usage: reveal <path>")
  withBrowser((b) => {
    const r = b.reveal(tokens.join(" "))
    return r.ok ? "ok" : `error: ${r.error}`
  }, res)
})

registerConfigCommands(
  "files",
  {
    get: getConfig,
    set: setConfigRaw,
    reloadConfig,
    all,
  },
  {
    onSet: (path) => {
      // Live-tier keys take effect immediately (every window re-renders from
      // its cached listing — no re-enumeration for showSize/showModified/...),
      // so a set lands in ALL open windows, not just the active one. The hidden
      // filter is state, not config, and its toggle repaints the windows
      // itself (window.tsx toggleHidden).
      if (store.tierOf(path) === "live") {
        refreshBrowsers()
      }
    },
  },
)
