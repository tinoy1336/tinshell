/**
 * common/applets/screengrab/capture-run.ts — the capture pipeline the applet's
 * overlay and the request surface both run.
 *
 * Geometry resolution → output path → grim / wf-recorder, plus the notification
 * that carries the action row (annotate the capture, preview it). It lives apart
 * from menu.tsx because a keybind must be able to start the SAME capture the
 * overlay starts: the notification actions are dispatched through in-process
 * handlers, so a capture driven from outside the instance (`tinshell-route` →
 * `dock screengrab capture`) has to run here, in the process that owns the
 * notification daemon.
 */

import { notifyWithAction } from "@apps/notifications/Notifd"
import { ensureLoaded, isLazyApp, isLoaded } from "@common/app/lazy"
import type { AppletBackend, CaptureMode } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import { copyImageFile } from "@common/clipboard"
import { dispatch } from "@common/commands/registry"
import { log } from "@common/log/logger"
import { treeRoot } from "@common/path/tree-root"
import { shq } from "@common/subprocess/quote"
import { runCb, spawnDetached } from "@common/subprocess/run"

function notify(config: AppletConfig, title: string, body: string): void {
  if (!config.screengrab.notify) return
  runCb(`notify-send ${shq(title)} ${shq(body)}`, () => {})
}

interface CaptureOutcome {
  /** false when the user cancelled the selection or grim failed. */
  ok: boolean
  /** The output path; empty when the selection was cancelled before rendering. */
  file: string
  geo: string | null
}

/** Show the capture in a media window of its own — the route the clipboard
 *  picker's row preview drives: the media app's SPAWN verb (`new`, never the
 *  retargeting `open`, so a second preview adds a window instead of replacing
 *  what an earlier one shows) dispatched in process through the command
 *  registry, with the lazy pre-step the dispatcher runs for a routed request
 *  (a resident instance hosts media lazily, so the handler may not exist yet). */
function previewCapture(path: string): void {
  const tokens = ["media", "new", path]
  const onReply = (reply: string) => {
    if (reply !== "ok") log(`screengrab preview failed for ${path}: ${reply}`)
  }
  if (isLazyApp("media") && !isLoaded("media")) {
    ensureLoaded("media").then(
      () => dispatch(tokens, onReply),
      () => log("screengrab preview: media failed to load"),
    )
  } else {
    dispatch(tokens, onReply)
  }
}

export async function runCapture(
  config: AppletConfig,
  backend: AppletBackend,
  mode: "still" | "video",
  geoMode: CaptureMode,
  opts: { copyToClipboard?: boolean } = {},
): Promise<CaptureOutcome> {
  const sg = config.screengrab
  // Ensure the storage dir exists before writing (async — capture starts after).
  await new Promise<void>((resolve) =>
    runCb(`mkdir -p ${shq(backend.screengrab.expandPath(sg.dir))}`, () => resolve()),
  )

  let geo = await backend.screengrab.resolveGeometry(geoMode)
  if (geoMode === "window" && !geo) {
    // No focused window (empty desktop / unmapped) — fall back to the monitor.
    geo = await backend.screengrab.resolveGeometry("fullscreen")
    notify(config, "Screen capture", "No focused window — captured the monitor")
  }
  if (!geo && geoMode === "select") return { ok: false, file: "", geo: null } // slurp cancelled

  const ext =
    mode === "still" ? (sg.format === "jpg" ? "jpg" : "png") : sg.codec === "vp9" ? "webm" : "mp4"
  const file = backend.screengrabNaming.renderCapturePath(sg.dir, sg.nameTemplate, ext)

  if (mode === "video") {
    backend.screengrab.startRecording(geo, file)
    notify(config, "Recording started", file)
    return { ok: true, file, geo }
  }

  const ok = await new Promise<boolean>((resolve) =>
    backend.screengrab.takeStill(geo, file, resolve),
  )
  if (!ok) {
    notify(config, "Screenshot failed", "grim exited non-zero")
    return { ok: false, file, geo }
  }
  if (opts.copyToClipboard) copyImageFile(file)
  if (config.screengrab.notify) {
    // In-process notification with actions (a notify-send shell-out dies with
    // the sending process, so its actions could never invoke). Annotate spawns
    // the annotate editor on the captured file; Preview shows the same file in
    // a media window.
    notifyWithAction({
      summary: "Screenshot saved",
      body: file,
      appName: "ScreenGrab",
      actions: [
        {
          id: "annotate",
          label: "Annotate",
          onInvoke: (body) => {
            if (!body) return
            spawnDetached([`${treeRoot()}/apps/annotate/ensure-open.sh`, body])
          },
        },
        {
          id: "preview",
          label: "Preview",
          onInvoke: (body) => {
            if (!body) return
            previewCapture(body)
          },
        },
      ],
    })
  }
  return { ok: true, file, geo }
}
