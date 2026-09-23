/**
 * ScreenGrab applet commands — the `dock debug screengrab` capture driver.
 *
 * Registered by the host's applet manifest. It drives the capture backend and
 * renders the output path, so the whole probe is service-side: it touches no
 * host internals. Useful as a manual test hook because driving a capture
 * otherwise needs pointer events on the overlay.
 *
 *   debug screengrab still|video <fullscreen|window|select>
 *   debug screengrab stop
 */
import type { AppletBackend, CaptureMode } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import type { Handler } from "@common/commands/registry"

/** Build the `dock debug screengrab` capture driver against the host's
 *  screengrab domains + its live config view. */
export function screengrabDebugCommand(backend: AppletBackend, config: AppletConfig): Handler {
  return (args, res) => {
    const [cmd, modeArg] = args
    const geoModes: CaptureMode[] = ["fullscreen", "window", "select"]
    if (cmd === "stop") {
      backend.screengrab.stopRecording()
      res("recording stopped")
      return
    }
    if ((cmd !== "still" && cmd !== "video") || !geoModes.includes(modeArg as CaptureMode)) {
      res(
        "usage: debug screengrab <still|video> <fullscreen|window|select> | debug screengrab stop",
      )
      return
    }
    const mode = cmd as "still" | "video"
    const geoMode = modeArg as CaptureMode
    void (async () => {
      const sg = config.screengrab
      const geo = await backend.screengrab.resolveGeometry(geoMode)
      const ext =
        mode === "still"
          ? sg.format === "jpg"
            ? "jpg"
            : "png"
          : sg.codec === "vp9"
            ? "webm"
            : "mp4"
      const file = backend.screengrabNaming.renderCapturePath(sg.dir, sg.nameTemplate, ext)
      if (mode === "still")
        backend.screengrab.takeStill(geo, file, (ok) =>
          res(`still ${ok ? "saved" : "failed"}: ${file} (geo=${geo})`),
        )
      else {
        backend.screengrab.startRecording(geo, file)
        res(`recording started: ${file} (geo=${geo})`)
      }
    })()
  }
}
