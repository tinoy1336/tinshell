/**
 * dock/commands/screengrab.ts — the `dock screengrab capture` request command.
 *
 * Starts the SAME capture the applet's overlay starts (see
 * common/applets/screengrab/capture-run), so a keybind reaches the whole
 * pipeline: output path from the config, region freeze, the capture itself, the
 * notification with its editor action, and the clipboard copy.
 *
 * The capture has to run in the instance that hosts the dock, not in the
 * caller: the notification action is dispatched through an IN-PROCESS handler,
 * so a capture started from outside the instance would raise the notification
 * but its Annotate button would go nowhere.
 */

import type { CaptureMode } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import { runCapture } from "@common/applets/screengrab/capture-run"
import { register } from "@common/commands/registry"
import { dockBackend } from "../applets"
import { dock } from "../config"

const MODES: CaptureMode[] = ["fullscreen", "window", "select"]

register(["dock", "screengrab", "capture"], (args, res) => {
  const [modeArg, geoArg] = args
  if ((modeArg !== "still" && modeArg !== "video") || !MODES.includes(geoArg as CaptureMode)) {
    res("error: usage: dock screengrab capture <still|video> <fullscreen|window|select>")
    return
  }
  const mode = modeArg as "still" | "video"
  const geoMode = geoArg as CaptureMode
  // The clipboard copy rides this path: a capture asked for by a keystroke is
  // usually headed straight for a paste. The overlay's own capture stays
  // clipboard-free (it is a deliberate save).
  void runCapture(dock.config as AppletConfig, dockBackend, mode, geoMode, {
    copyToClipboard: true,
  })
    .then((out) => {
      if (!out.file) res("cancelled")
      else if (out.ok) res(`saved: ${out.file}`)
      else res(`error: capture failed: ${out.file}`)
    })
    .catch((e) => res(`error: ${e}`))
})
