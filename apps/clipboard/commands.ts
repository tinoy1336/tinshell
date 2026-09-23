/**
 * clipboard request handlers — `ags -i clipboard request ...`.
 *
 * `toggle` / `show` / `hide` (picker visibility), `focus-search`,
 * `history [n]`, `clear`, `delete <id>`, `pin` / `unpin <id>`, `debug`,
 * and the standard `config get|set|reload`.
 * Quit is the builtin `ags -i clipboard quit`.
 */

import { registerConfigCommands } from "@common/commands/config-commands"
import { register } from "@common/commands/registry"
import { captureState } from "./capture"
import { get, reloadConfig, set } from "./config"
import { all, clear, pinned, remove, togglePin } from "./store"

let control: {
  toggle: () => void
  show: () => void
  hide: () => void
  focusSearch: () => void
} | null = null

export function setControl(c: typeof control): void {
  control = c
}

register(["clipboard", "toggle"], (_t, res) => {
  control?.toggle()
  res("ok")
})

register(["clipboard", "show"], (_t, res) => {
  control?.show()
  res("ok")
})

register(["clipboard", "hide"], (_t, res) => {
  control?.hide()
  res("ok")
})

register(["clipboard", "focus-search"], (_t, res) => {
  control?.focusSearch()
  res("ok")
})

register(["clipboard", "history"], (tokens, res) => {
  const n = Number(tokens[0])
  const limit = Number.isInteger(n) && n > 0 ? n : 20
  const lines = all()
    .slice(0, limit)
    .map((e) => {
      const t = new Date(e.ts).toISOString()
      if (e.mime === "text") return `${t} ${e.id} text  ${(e.text ?? "").slice(0, 60)}`
      return `${t} ${e.id} image ${e.imagePath ?? "?"}`
    })
  res(lines.length ? lines.join("\n") : "(empty)")
})

register(["clipboard", "clear"], (_t, res) => {
  clear()
  res("ok")
})

register(["clipboard", "delete"], (tokens, res) => {
  const id = tokens[0]
  if (!id) return res("usage: delete <id>")
  res(remove(id) ? "ok" : "error: no such entry")
})

register(["clipboard", "pin"], (tokens, res) => {
  const id = tokens[0]
  if (!id) return res("usage: pin <id>")
  if (!pinned().has(id)) togglePin(id)
  res("ok")
})

register(["clipboard", "unpin"], (tokens, res) => {
  const id = tokens[0]
  if (!id) return res("usage: unpin <id>")
  if (pinned().has(id)) togglePin(id)
  res("ok")
})

register(["clipboard", "debug"], (_t, res) => {
  let state: Record<string, unknown>
  try {
    state = JSON.parse(captureState())
  } catch {
    state = { error: "capture state unavailable" }
  }
  res(
    JSON.stringify({
      ...state,
      entries: all().length,
      pinned: [...pinned()].length,
    }),
  )
})

registerConfigCommands("clipboard", {
  get,
  set,
  reloadConfig,
})
