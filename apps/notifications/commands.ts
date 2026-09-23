/**
 * Request handlers for the notifications app — `ags -i shell request "notifications ..."`.
 *
 * Handlers register against the shared command registry (common/commands/
 * registry). Each handler runs sync or async; errors surface as
 * `error: <msg>`. The empty-token probe returns the available commands (the
 * no-op probe signature of a stray bus holder).
 *
 * UI-surface commands (toggle-centre, close-all, dismiss, history) delegate
 * to the `NotificationsControl` injected by the UI module at mount; they no-op
 * with a sane response while the UI isn't built.
 */

import { createArrayAwareCoerce, registerConfigCommands } from "@common/commands/config-commands"
import { register } from "@common/commands/registry"
import { get as getConfig, reloadConfig, set as setConfigRaw } from "./config"
import { ignore } from "./log"
import {
  addInhibitor,
  clearInhibitors,
  getNotification,
  inhibitors,
  invokeAction,
  invokeDefault,
  removeInhibitor,
} from "./Notifd"

/** Array values (code.apps) parse from JSON through the shared array-aware
 *  coercion; every other shape uses its scalar fallback. */
const coerce = createArrayAwareCoerce(getConfig)

function setConfig(path: string, raw: string): void {
  setConfigRaw(path, coerce(path, raw))
}

// ── UI control surface (injected by the UI module when it mounts) ──

interface NotificationsControl {
  toggleCentre(): void
  showCentre(): void
  hideCentre(): void
  closeAll(): void
  dismiss(id: number): void
  /** Snapshot of the current history (one line per notification). */
  history(): string[]
}

let control: NotificationsControl | null = null

export function setControl(c: NotificationsControl | null): void {
  control = c
}

// ── Handler registrations ──

register(["notifications", "ping"], (_t, res) => {
  res("pong")
})

// DND — lives in config, applied live by the Notifd wiring.
register(["notifications", "dnd", "set"], (tokens, res) => {
  const arg = tokens[0]
  if (arg === "on") setConfig("dnd.enabled", "true")
  else if (arg === "off") setConfig("dnd.enabled", "false")
  else if (arg === "toggle") setConfig("dnd.enabled", String(!getConfig("dnd.enabled")))
  else return res("usage: dnd set on|off|toggle")
  res(`ok (dnd ${getConfig("dnd.enabled") ? "on" : "off"})`)
})

register(["notifications", "dnd", "get"], (_t, res) => {
  res(getConfig("dnd.enabled") ? "on" : "off")
})

// Centre window control.
register(["notifications", "toggle-centre"], (_t, res) => {
  control?.toggleCentre()
  res("ok")
})

register(["notifications", "show-centre"], (_t, res) => {
  control?.showCentre()
  res("ok")
})

register(["notifications", "hide-centre"], (_t, res) => {
  control?.hideCentre()
  res("ok")
})

register(["notifications", "close-all"], (_t, res) => {
  control?.closeAll()
  res("ok")
})

register(["notifications", "dismiss"], (tokens, res) => {
  const id = Number(tokens[0])
  if (!Number.isInteger(id)) return res("usage: dismiss <id>")
  control?.dismiss(id)
  res("ok")
})

// Invoke an action by id (defaults to the "default" action if omitted) —
// the bus-driven equivalent of clicking a card/button (suite model: any UI
// surface can drive the app). Also the deterministic action-path test hook.
register(["notifications", "invoke"], (tokens, res) => {
  const id = Number(tokens[0])
  if (!Number.isInteger(id)) return res("usage: invoke <id> [action-id]")
  const n = getNotification(id)
  if (!n) return res("error: no such notification")
  const actionId = tokens.slice(1).join(" ")
  if (actionId) invokeAction(n, actionId)
  else invokeDefault(n)
  res("ok")
})

register(["notifications", "history"], (_t, res) => {
  res(control?.history()?.join("\n") ?? "")
})

// Debug: dump a notification's raw fields (icon debugging).
register(["notifications", "debug", "dump"], (tokens, res) => {
  const id = Number(tokens[0])
  if (!Number.isInteger(id)) return res("usage: debug dump <id>")
  const n = getNotification(id)
  if (!n) return res("error: no such notification")
  res(
    JSON.stringify({
      id: n.id,
      app_name: n.app_name,
      app_icon: n.app_icon,
      desktop_entry: n.desktop_entry,
      summary: n.summary,
      image: n.image,
      hints: (() => {
        try {
          const out: Record<string, string> = {}
          const h = n.hints
          for (const k of ["image-path", "image_data", "icon_data"]) {
            try {
              const v = h?.lookup_value(k, null)
              if (v !== null && v !== undefined) out[k] = String(v.unpack()).slice(0, 60)
            } catch (e) {
              // Hint absent or unreadable — it is simply not reported.
              ignore("notification hint read", e)
            }
          }
          return out
        } catch (e) {
          ignore("notification hints snapshot", e)
          return {}
        }
      })(),
    }),
  )
})

// Inhibitors (swaync-client --inhibitor-add/remove compat over the request API;
// the org.erikreider.swaync.cc DBus interface is exported by Notifd.ts).
register(["notifications", "inhibitor", "add"], (tokens, res) => {
  const id = tokens.join(" ")
  if (!id) return res("usage: inhibitor add <app-id>")
  res(addInhibitor(id) ? "ok" : "error: already present")
})

register(["notifications", "inhibitor", "remove"], (tokens, res) => {
  const id = tokens.join(" ")
  if (!id) return res("usage: inhibitor remove <app-id>")
  res(removeInhibitor(id) ? "ok" : "error: not present")
})

register(["notifications", "inhibitor", "clear"], (_t, res) => {
  clearInhibitors()
  res("ok")
})

register(["notifications", "inhibitor", "get"], (_t, res) => {
  res(inhibitors().join("\n"))
})

// Config (standardized replies: JSON get, "reloaded" reload). `coerce` is the
// shared array-aware rule, so an array-valued path (code.apps) parses from JSON.
registerConfigCommands(
  "notifications",
  {
    get: getConfig,
    set: setConfigRaw,
    reloadConfig,
  },
  { coerce },
)
