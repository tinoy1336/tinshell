/**
 * notes request handlers — `ags -i notes request ...`.
 *
 * The notes app is addressable while it runs (bus io.Astal.notes, instance
 * "notes"): `fresh` (the Mod+N action — a guaranteed fresh empty note), `new`
 * (the Mod+SHIFT+N action — reopen the most recently closed note, else a fresh
 * blank one), `open <name-or-path>`, `close <name-or-path>` (closes the WINDOW;
 * the file stays on disk), `list`, `history` (the open notes' edit chains),
 * `ping`, and the standard `config get|set|reload|all`. Quit is the builtin
 * `ags -i notes quit`.
 */

import { registerConfigCommands } from "@common/commands/config-commands"
import { register } from "@common/commands/registry"
import { all, get as getConfig, reloadConfig, set as setConfigRaw } from "./config"
import {
  closeNote,
  historyDump,
  noteNames,
  openFreshNote,
  openNoteByName,
  reopenOrBlankNote,
} from "./notes"
import { debugState as sessionDebugState } from "./session"

register(["notes", "ping"], (_t, res) => {
  res("pong")
})

register(["notes", "session"], (_t, res) => {
  res(sessionDebugState())
})

// The edit chains of the open notes: steps recorded, the position in the chain
// (how many are applied), how many were folded into the baseline, and whether
// another live instance owns the chain (read-only for this process).
register(["notes", "history"], (_t, res) => {
  res(historyDump())
})

register(["notes", "new"], (_t, res) => {
  reopenOrBlankNote()
  res("ok")
})

register(["notes", "fresh"], (_t, res) => {
  openFreshNote()
  res("ok")
})

register(["notes", "open"], (tokens, res) => {
  if (!tokens[0]) return res("error: usage: open <note-name-or-path>")
  const r = openNoteByName(tokens.join(" "))
  res(r.ok ? "ok" : `error: ${r.error}`)
})

register(["notes", "close"], (tokens, res) => {
  if (!tokens[0]) return res("error: usage: close <note-name-or-path>")
  const r = closeNote(tokens.join(" "))
  res(r.ok ? "ok" : `error: ${r.error}`)
})

register(["notes", "list"], (_t, res) => {
  const names = noteNames()
  res(names.length ? names.join("\n") : "no notes yet")
})

registerConfigCommands("notes", {
  get: getConfig,
  set: setConfigRaw,
  reloadConfig,
  all,
})
