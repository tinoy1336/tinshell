/**
 * clipboard request handlers — `ags -i clipboard request ...`.
 *
 * METADATA-ONLY surface: every path that lists or inspects entries answers
 * entry metadata (timestamp, id, mime, payload byte size, pinned flag) and
 * never the payload. A caller looking for one entry therefore cannot end up
 * holding everyone's content. Payload content has exactly ONE way out, the
 * explicit opt-in `clipboard entry <id> --reveal`, which prints that single
 * named entry; no listing path takes a reveal flag and every one of them
 * refuses one instead of ignoring it.
 *
 * Argument parsing is STRICT: a token a path does not define is answered with
 * that path's usage line and the request does nothing else, so a flag that
 * does not apply can never look like it did.
 *
 * `toggle` / `show` / `hide` (picker visibility), `focus-search`,
 * `history [<limit>]`, `entry <id> [--reveal]`, `clear`, `delete <id>`,
 * `pin` / `unpin <id>`, `debug`, and the standard `config get|set|reload`.
 * Quit is the builtin `ags -i clipboard quit`.
 */

import { registerConfigCommands } from "@common/commands/config-commands"
import { register } from "@common/commands/registry"
import { captureState } from "./capture"
import { get, reloadConfig, set } from "./config"
import {
  all,
  type ClipboardEntry,
  clear,
  imagePath,
  payloadSize,
  pinned,
  remove,
  togglePin,
} from "./store"

let control: {
  toggle: () => void
  show: () => void
  hide: () => void
  focusSearch: () => void
} | null = null

export function setControl(c: typeof control): void {
  control = c
}

/** Usage line of every path that behaves like a flag-free one. */
const USAGE = {
  toggle: "usage: clipboard toggle",
  show: "usage: clipboard show",
  hide: "usage: clipboard hide",
  focusSearch: "usage: clipboard focus-search",
  history: "usage: clipboard history [<limit>]",
  entry: "usage: clipboard entry <id> [--reveal]",
  clear: "usage: clipboard clear",
  delete: "usage: clipboard delete <id>",
  pin: "usage: clipboard pin <id>",
  unpin: "usage: clipboard unpin <id>",
  debug: "usage: clipboard debug",
}

/**
 * ONE metadata line per entry: ISO timestamp, id, mime, payload bytes and the
 * pinned flag. Never the payload.
 */
function metaLine(e: ClipboardEntry, pinnedIds: Set<string>): string {
  return `${new Date(e.ts).toISOString()} ${e.id} ${e.mime} ${payloadSize(e)} ${pinnedIds.has(e.id)}`
}

/**
 * Refuse an argument a path does not define: answer its usage line and report
 * true, so the caller stops. An undeclared token is never ignored.
 */
function rejectArgs(tokens: string[], res: (response: string) => void, usage: string): boolean {
  if (tokens.length === 0) return false
  res(`error: ${usage}`)
  return true
}

register(["clipboard", "toggle"], (tokens, res) => {
  if (rejectArgs(tokens, res, USAGE.toggle)) return
  control?.toggle()
  res("ok")
})

register(["clipboard", "show"], (tokens, res) => {
  if (rejectArgs(tokens, res, USAGE.show)) return
  control?.show()
  res("ok")
})

register(["clipboard", "hide"], (tokens, res) => {
  if (rejectArgs(tokens, res, USAGE.hide)) return
  control?.hide()
  res("ok")
})

register(["clipboard", "focus-search"], (tokens, res) => {
  if (rejectArgs(tokens, res, USAGE.focusSearch)) return
  control?.focusSearch()
  res("ok")
})

register(["clipboard", "history"], (tokens, res) => {
  if (tokens.length > 1 || (tokens.length === 1 && !/^\d+$/.test(tokens[0]))) {
    return res(`error: ${USAGE.history}`)
  }
  const limit = tokens.length === 1 ? Number(tokens[0]) : 20
  if (limit < 1) return res(`error: ${USAGE.history}`)
  const pinnedIds = pinned()
  const lines = all()
    .slice(0, limit)
    .map((e) => metaLine(e, pinnedIds))
  res(lines.length ? lines.join("\n") : "(empty)")
})

register(["clipboard", "entry"], (tokens, res) => {
  const [id, flag, ...extra] = tokens
  if (!id || extra.length > 0 || (flag !== undefined && flag !== "--reveal")) {
    return res(`error: ${USAGE.entry}`)
  }
  const e = all().find((x) => x.id === id)
  if (!e) return res(`error: no such entry: ${id}`)
  if (flag !== "--reveal") return res(metaLine(e, pinned()))
  // The ONLY payload path: one named entry, behind an explicit flag. A text
  // entry prints verbatim; an image entry answers its absolute PNG path — the
  // bytes are never printed.
  res(e.mime === "text" ? (e.text ?? "") : imagePath(e.id))
})

register(["clipboard", "clear"], (tokens, res) => {
  if (rejectArgs(tokens, res, USAGE.clear)) return
  clear()
  res("ok")
})

register(["clipboard", "delete"], (tokens, res) => {
  if (tokens.length !== 1) return res(`error: ${USAGE.delete}`)
  res(remove(tokens[0]) ? "ok" : "error: no such entry")
})

register(["clipboard", "pin"], (tokens, res) => {
  if (tokens.length !== 1) return res(`error: ${USAGE.pin}`)
  if (!pinned().has(tokens[0])) togglePin(tokens[0])
  res("ok")
})

register(["clipboard", "unpin"], (tokens, res) => {
  if (tokens.length !== 1) return res(`error: ${USAGE.unpin}`)
  if (pinned().has(tokens[0])) togglePin(tokens[0])
  res("ok")
})

register(["clipboard", "debug"], (tokens, res) => {
  if (rejectArgs(tokens, res, USAGE.debug)) return
  let state: Record<string, unknown>
  try {
    state = JSON.parse(captureState())
  } catch {
    state = { error: "capture state unavailable" }
  }
  // Counts and capture-loop state only — the same metadata shape as the
  // listing paths, never an entry's content.
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
