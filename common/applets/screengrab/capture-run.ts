/**
 * common/applets/screengrab/capture-run.ts — the capture pipeline the applet's
 * overlay and the request surface both run.
 *
 * Geometry resolution → output path → grim / wf-recorder, plus the notification
 * that carries the editor action. It lives apart from menu.tsx because a keybind
 * must be able to start the SAME capture the overlay starts: the notification
 * action is dispatched through an in-process handler, so a capture driven from
 * outside the instance (`tinshell-route` → `dock screengrab capture`) has to run
 * here, in the process that owns the notification daemon.
 */

import GLib from "gi://GLib"
import { notifyWithAction } from "@apps/notifications/Notifd"
import type { AppletBackend, CaptureMode } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import { copyImageFile } from "@common/clipboard"
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
    // In-process notification with an action (a notify-send shell-out dies with
    // the sending process, so its action could never invoke). The action spawns
    // the annotate editor on the captured file.
    notifyWithAction({
      summary: "Screenshot saved",
      body: file,
      appName: "ScreenGrab",
      actionId: "annotate",
      actionLabel: "Annotate",
      onInvoke: (body) => {
        if (!body) return
        spawnDetached([`${GLib.get_home_dir()}/dev/tinshell/apps/annotate/ensure-open.sh`, body])
      },
    })
  }
  return { ok: true, file, geo }
}
