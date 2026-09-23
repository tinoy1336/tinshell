/**
 * annotate request handlers — `ags -i annotate request ...`.
 *
 * The app is addressable while it runs (bus io.Astal.annotate, instance
 * "annotate"): `open <path>` (the warm ensure-open.sh path), `save`,
 * `close`, `ping`, and the standard `config get|set|reload|all`. Quit is
 * the builtin `ags -i annotate quit`.
 *
 * annotate is MULTI-WINDOW and the request surface has no window argument:
 * `open` always mounts a NEW window, `save` acts on the most recently opened
 * one, and `close` closes them all (the app-level close).
 */

import { registerConfigCommands } from "@common/commands/config-commands"
import { register } from "@common/commands/registry"
import { all, get as getConfig, reloadConfig, set as setConfigRaw } from "./config"
import { closeEditors, getEditor, openEditor, resolveTarget } from "./window"

register(["annotate", "ping"], (_t, res) => {
  res("pong")
})

register(["annotate", "open"], (tokens, res) => {
  // open <image-path> — the named path is resolved and checked BEFORE a window
  // is mounted (`resolveTarget` in window.tsx): a path that is not a decodable
  // image file answers its reason here and opens nothing, so a caller can never
  // leave an editor showing nothing behind. The usage error is the only
  // no-argument answer — the empty editor is the app's own bare start, never a
  // request's.
  const path = tokens.join(" ")
  if (!path) return res("error: usage: open <image-path>")
  const target = resolveTarget(path)
  if ("reason" in target) return res(`error: ${target.reason}`)
  openEditor(target.path)
  res("ok")
})

register(["annotate", "save"], (_t, res) => {
  // The request carries no window argument: it saves the most recently opened
  // window (the one the user is annotating), never a hidden sibling.
  const ed = getEditor()
  if (!ed) return res("error: no editor window")
  const r = ed.save()
  res(r.ok ? (r.path ? `ok: ${r.path}` : "ok") : `error: ${r.error ?? "save failed"}`)
})

register(["annotate", "close"], (_t, res) => {
  closeEditors()
  res("ok")
})

registerConfigCommands("annotate", {
  get: getConfig,
  set: setConfigRaw,
  reloadConfig,
  all,
})
