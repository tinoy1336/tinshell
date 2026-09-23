/**
 * media request handlers — `ags -i media request ...`.
 *
 * The media app is addressable while it runs (bus io.Astal.media, instance
 * "media"): `open [path|url]`, `new [path|url]`, `ring <path|dir>`, `close`,
 * `append <path|url>`, `toggle` / `play` / `pause`, `seek <+|-sec | sec |
 * pct%>`, `volume <0-100 | +N | -N>`, `mute`, `next` / `prev`, `zoom
 * fit|in|out|100`, `playlist` / `play <idx>` / `remove <idx>` / `clear` /
 * `shuffle`, `speed <x>`, `status`, `ping`, `preview
 * on|off|toggle|mode pane|full|width <px>|status`, and the standard
 * `config get|set|reload|all`. Quit is the builtin `ags -i media quit`.
 *
 * Multi-instance: `open` focuses the most-recent media window else creates
 * one; `new` always creates another (the xdg-open path — see ./ensure-open.sh).
 * A NAMED path is resolved first (window.tsx `resolveTarget`) and refused with
 * `error: <reason>` when it is not a regular file there, so a path with nothing
 * at it can never become a window showing nothing — the empty state is for a
 * request that named no file, which asks the portal. `append` resolves its
 * target through the same helper (window.tsx `appendToActive`) and refuses it
 * the same way, so an entry the pipeline can never load never enters the queue.
 * `open` picks the window's MODE from the file's kind (common/media/classify):
 * a still opens in the viewer, audio and video in the transport. Transport/queue
 * commands route to the ACTIVE transport window (most-recently-playing else
 * last-focused — window.tsx owns the selection via media.setActiveInstance);
 * `next`/`prev` step the active VIEWER's folder RING instead while that window
 * holds one, and `zoom` addresses the active surface in either mode. Every
 * command is a thin pass-through to that surface — `error: <msg>` never
 * crashes; the handlers below are the API surface.
 *
 * ONE REQUESTED FILE = ONE FILE: `open` loads exactly what it was given and
 * builds no sibling list. The folder ring a flip needs is the EXPLICIT `ring`
 * request.
 */

import { unloadNow } from "@common/app/lazy"
import { registerConfigCommands } from "@common/commands/config-commands"
import { register } from "@common/commands/registry"
import {
  PREVIEW_MIN_WIDTH,
  previewSettings,
  setPreviewEnabled,
  setPreviewMode,
  setPreviewWidth,
  togglePreview,
} from "@common/media/preview"
import type { MediaPipeline } from "@common/media/types"
import { all, get as getConfig, reloadConfig, set as setConfigRaw, store } from "./config"
import {
  activePipeline,
  activeViewer,
  appendToActive,
  closeActive,
  newSurface,
  openPath,
  refreshView,
  ringPath,
  setActiveZoom,
} from "./window"

/** The active transport window's media backend, or an error reply. */
function media(res: (r: string) => void): MediaPipeline | null {
  const m = activePipeline()
  if (!m) res("error: no media window open (use `media open <path>` or `media new`)")
  return m
}

// Debug hook: force a lazy unload cycle
// on demand so unload→reload can be exercised without waiting on grace.
register(["media", "debug-unload"], (_t, res) => {
  void unloadNow("media").then(
    () => res("ok: unloaded"),
    (e) => res(`error: unload failed: ${String(e)}`),
  )
})

register(["media", "ping"], (_t, res) => {
  res("pong")
})

register(["media", "open"], (tokens, res) => {
  // open [path|url] — focus the most-recent window else create one. No path
  // → just focus/show (the ensure-open.sh warm path sends `open` to focus —
  // it must NOT clobber the current media), and a window created by it with
  // no path raises the portal prompt. A still path switches the window into
  // the viewer, anything else into the transport — and it is the ONLY file
  // loaded: a folder ring needs the explicit `ring` request. A path that
  // resolves to nothing is refused HERE, so the caller (the launcher bang,
  // tinshell-route, a debug call) gets the reason instead of a silent empty window.
  const reason = openPath(tokens.join(" ") || undefined)
  if (reason) return res(`error: ${reason}`)
  res("ok")
})

register(["media", "new"], (tokens, res) => {
  // new [path|url] — always create another media window; a named path is
  // resolved and refused like `open`.
  const reason = newSurface(tokens.join(" ") || undefined)
  if (reason) return res(`error: ${reason}`)
  res("ok")
})

register(["media", "ring"], (tokens, res) => {
  // ring <path|dir> — the EXPLICIT multi-file load: the still's folder ring
  // (name-sorted, `isStillImage` siblings; a directory names its own stills),
  // loading the entry the path names. `open` never builds one: one requested
  // file is one file, and flipping is this request.
  const target = tokens.join(" ")
  if (!target) return res("error: usage: ring <path|dir>")
  if (!ringPath(target)) return res(`error: no still images at ${target}`)
  res("ok")
})

register(["media", "close"], (_t, res) => {
  // Close the active window (the viewer's `images close` carried over).
  if (!closeActive()) return res("error: no window")
  res("ok")
})

register(["media", "append"], (tokens, res) => {
  // append <path|url> — the queue load. The target is resolved and refused
  // exactly like `open`/`new` (window.tsx appendToActive): a playlist entry
  // the pipeline can never load is the same defect as a window showing
  // nothing, and the caller gets the reason instead of a bare `ok`.
  if (!tokens[0]) return res("error: usage: append <path|url>")
  const reason = appendToActive(tokens.join(" "))
  if (reason) return res(`error: ${reason}`)
  res("ok")
})

register(["media", "toggle"], (_t, res) => {
  const m = media(res)
  if (!m) return
  m.toggle()
  res("ok")
})

register(["media", "play"], (tokens, res) => {
  // play (no args) = resume; play <idx> = playlist jump (flat API — the
  // registry's first-node-wins walk can't have a bare `play` handler AND
  // `play <idx>` subcommands, so the handler branches on its first token).
  if (tokens[0] !== undefined) {
    const m = media(res)
    if (!m) return
    const idx = parseInt(tokens[0], 10)
    if (Number.isNaN(idx)) return res(`error: bad playlist index: ${tokens[0]}`)
    if (idx < 0 || idx >= m.getPlaylist().length)
      return res(`error: playlist index out of range: ${idx}`)
    m.playIndex(idx)
    return res("ok")
  }
  const m = media(res)
  if (!m) return
  m.play()
  res("ok")
})

register(["media", "pause"], (_t, res) => {
  const m = media(res)
  if (!m) return
  m.pause()
  res("ok")
})

register(["media", "seek"], (tokens, res) => {
  const spec = tokens[0]
  if (!spec) return res("error: usage: seek <+|-sec | sec | pct%>")
  const m = media(res)
  if (!m) return
  const status = m.getStatus()
  const pct = /^([+-]?\d+(?:\.\d+)?)%$/.exec(spec)
  if (pct) {
    const d = status.duration
    if (!d || d <= 0) return res("error: cannot seek percent without a duration")
    m.seekSeconds((parseFloat(pct[1]) / 100) * d)
    return res("ok")
  }
  if (/^[+-]\d/.test(spec)) {
    const cur = status.timePos
    if (cur === null) return res("error: cannot seek relative without a position")
    m.seekSeconds(cur + parseFloat(spec))
    return res("ok")
  }
  const abs = parseFloat(spec)
  if (Number.isNaN(abs)) return res(`error: bad seek value: ${spec}`)
  m.seekSeconds(abs)
  res("ok")
})

register(["media", "volume"], (tokens, res) => {
  const spec = tokens[0]
  if (!spec) return res("error: usage: volume <0-100 | +N | -N>")
  const m = media(res)
  if (!m) return
  const delta = /^([+-])(\d+(?:\.\d+)?)$/.exec(spec)
  if (delta) {
    const next = Math.max(0, Math.min(100, m.getVolume() + parseFloat(delta[1] + delta[2])))
    m.setVolume(next)
    return res("ok")
  }
  const v = parseFloat(spec)
  if (Number.isNaN(v)) return res(`error: bad volume value: ${spec}`)
  m.setVolume(Math.max(0, Math.min(100, v)))
  res("ok")
})

register(["media", "mute"], (_t, res) => {
  const m = media(res)
  if (!m) return
  m.toggleMute()
  res("ok")
})

register(["media", "next"], (_t, res) => {
  // next — the active VIEWER's next ring still, else the transport queue.
  const viewer = activeViewer()
  if (viewer?.hasRing()) {
    viewer.step(1)
    return res("ok")
  }
  const m = media(res)
  if (!m) return
  m.next()
  res("ok")
})

register(["media", "prev"], (_t, res) => {
  const viewer = activeViewer()
  if (viewer?.hasRing()) {
    viewer.step(-1)
    return res("ok")
  }
  const m = media(res)
  if (!m) return
  m.prev()
  res("ok")
})

register(["media", "zoom"], (tokens, res) => {
  const spec = tokens[0]
  if (spec !== "fit" && spec !== "in" && spec !== "out" && spec !== "100") {
    return res("error: usage: zoom fit|in|out|100")
  }
  // Stills and video both zoom: the active surface, whatever its mode.
  if (!setActiveZoom(spec)) return res("error: no media window")
  res("ok")
})

register(["media", "playlist"], (_t, res) => {
  const m = media(res)
  if (!m) return
  res(JSON.stringify(m.getPlaylist()))
})

register(["media", "remove"], (tokens, res) => {
  const idx = parseInt(tokens[0] ?? "", 10)
  if (Number.isNaN(idx)) return res("error: usage: remove <idx>")
  const m = media(res)
  if (!m) return
  m.removeIndex(idx)
  res("ok")
})

register(["media", "clear"], (_t, res) => {
  const m = media(res)
  if (!m) return
  m.clearPlaylist()
  res("ok")
})

register(["media", "shuffle"], (_t, res) => {
  const m = media(res)
  if (!m) return
  m.shufflePlaylist()
  res("ok")
})

register(["media", "speed"], (tokens, res) => {
  const x = parseFloat(tokens[0] ?? "")
  if (Number.isNaN(x) || x <= 0) return res("error: usage: speed <x> (e.g. 1.5)")
  const m = media(res)
  if (!m) return
  m.setSpeed(x)
  res("ok")
})

register(["media", "status"], (_t, res) => {
  const m = media(res)
  if (!m) return
  res(JSON.stringify(m.getStatus()))
})

register(["media", "preview"], (tokens, res) => {
  // The preview PREFERENCE — which host mounts the media pane (files' browser,
  // the portal chooser) and how the pane is shaped. It lives in its own state
  // store (common/media/preview) and this is its only write path, so every host
  // reads one value. Every verb answers the effective settings as JSON.
  const verb = tokens[0]
  const arg = tokens[1]
  switch (verb) {
    case "on":
      setPreviewEnabled(true)
      break
    case "off":
      setPreviewEnabled(false)
      break
    case "toggle":
      togglePreview()
      break
    case "mode":
      if (arg !== "pane" && arg !== "full") return res("error: usage: preview mode pane|full")
      setPreviewMode(arg)
      break
    case "width": {
      const w = Number.parseInt(arg ?? "", 10)
      if (!Number.isInteger(w)) return res("error: usage: preview width <px>")
      if (setPreviewWidth(w).width !== w) {
        return res(`error: width must be an integer >= ${PREVIEW_MIN_WIDTH}`)
      }
      break
    }
    case "status":
      break
    default:
      return res("error: usage: preview on|off|toggle|mode pane|full|width <px>|status")
  }
  res(JSON.stringify(previewSettings()))
})

registerConfigCommands(
  "media",
  {
    get: getConfig,
    set: setConfigRaw,
    reloadConfig,
    all,
  },
  {
    onSet: (path) => {
      if (store.tierOf(path) === "live") {
        // live tier: refresh the surface (viewer footer / seek scrubber)
        refreshView()
      }
    },
  },
)
