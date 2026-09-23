import GLib from "gi://GLib"
import { createStepApplet } from "@common/applets/shared/create-step-applet"
import { clamp01, drawDisc, drawGlyph } from "@common/applets/shared/draw-utils"
import type { AppletContext, DrawIcon } from "@common/applets/types"
import { closeMenu, menuKind } from "@common/menus/menu-framework"
import { shq } from "@common/subprocess/quote"
import { runCb } from "@common/subprocess/run"
import { onCleanup } from "gnim"
import {
  captureOverlayOpen,
  openScreenGrabCaptureMenu,
  openScreenGrabSettingsMenu,
  SETTINGS_KIND,
} from "./menu"

/**
 * The screen grab applet — 4 steps: Still / Video / Files / Settings.
 *
 *   Still/Video — open a capture-mode overlay (Fullscreen / Window / Select
 *     area / Cancel) that runs grim (still) or wf-recorder (video). While
 *     recording, the Video step swaps to a stop glyph and the applet's icon
 *     blinks red (a soft fade pulse driven by the dock row's attention value
 *     `render.attention` — see dock-row.ts setAppletAttention); the
 *     blink lives on the applet's icon while it is visible in the dock and on
 *     the overflow caret while the applet is parked in overflow. The icon
 *     also shows the elapsed mm:ss.
 *   Files — opens the storage folder in the file manager.
 *   Settings — the capture settings GUI (path, format/quality, codec, fps,
 *     naming template, cursor/audio/notify toggles, show-dock toggle).
 *
 * The pill closes normally on cursor leave (no pinning) — the capture
 * overlay and settings menu are independent surfaces.
 */

export default function mount({ port, hooks, config, backend, store }: AppletContext): void {
  const icon = port.icon

  const steps = [
    {
      label: "Still",
      get emoji() {
        return config.appearance.icons.screengrabStill
      },
    },
    {
      label: "Video",
      get emoji() {
        return backend.screengrab.isRecording()
          ? config.appearance.icons.screengrabRecording
          : config.appearance.icons.screengrabVideo
      },
    },
    {
      label: "Files",
      get emoji() {
        return config.appearance.icons.screengrabFiles
      },
    },
    {
      label: "Settings",
      get emoji() {
        return config.appearance.icons.screengrabSettings
      },
    },
  ]

  const drawIcon: DrawIcon = (
    cr,
    w,
    h,
    _value,
    _state,
    ringFill = 1,
    skipDisc = false,
    _textValue,
  ) => {
    const rf = clamp01(ringFill)
    const size = Math.min(w, h)
    const cx = w / 2
    const cy = h / 2
    if (!skipDisc) {
      drawDisc(config, cr, cx, cy, size / 2)
    }
    const gc = config.appearance.glyphColour
    const attention = port.render.attention

    if (backend.screengrab.isRecording()) {
      // Red, softly pulsing stop glyph (the row drives `attention` 0..1).
      const rc = config.appearance.recordingColour
      const pulseAlpha = gc.alpha * rf * (0.3 + 0.7 * attention)
      drawGlyph(
        config,
        cr,
        cx,
        cy,
        config.appearance.icons.screengrabRecording,
        config.fonts.iconSize,
        [rc.rgb[0], rc.rgb[1], rc.rgb[2], pulseAlpha],
        undefined,
        config.appearance.textShadow.alpha * rf,
      )
      // Elapsed mm:ss under the glyph.
      const startUs = backend.screengrab.recordingStartUs()
      const secs = startUs ? Math.floor((GLib.get_monotonic_time() - startUs) / 1e6) : 0
      const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`
      const pt = config.appearance.pctTextColour
      cr.setSourceRGBA(pt.rgb[0], pt.rgb[1], pt.rgb[2], pt.alpha * rf)
      cr.selectFontFace(config.fonts.family, 0, 0)
      cr.setFontSize(config.fonts.labelSize)
      const ext = cr.textExtents(text)
      cr.moveTo(
        cx - ext.width / 2 - ext.xBearing,
        cy + size / 2 - 5 - ext.height / 2 - ext.yBearing,
      )
      cr.showText(text)
    } else {
      // Idle glyph is a fixed config key (appearance.icons.screengrabIdle),
      // independent of the last capture mode; captureMode persists only for
      // the overlay's remembered selection.
      drawGlyph(
        config,
        cr,
        cx,
        cy,
        config.appearance.icons.screengrabIdle,
        config.fonts.iconSize,
        [gc.rgb[0], gc.rgb[1], gc.rgb[2], gc.alpha * rf],
        undefined,
        config.appearance.textShadow.alpha * rf,
      )
    }
  }

  const handle = createStepApplet(port, {
    config,
    steps,
    getStepColour: (i: number) => config.appearance.stepColours.screengrab[i],
    getInitialStep: () => 0,
    drawIcon,
    onSelect: (step, close) => {
      const monitor = (port.window as any).gdkmonitor
      switch (step) {
        case 0:
          // Still: a second click on the SAME mode toggles the overlay closed;
          // a click while the VIDEO overlay is open SWITCHES to still (the old
          // overlay fades out as the new one fades in — hubAdopt's replace).
          if (captureOverlayOpen() === "still") closeMenu()
          else openScreenGrabCaptureMenu({ monitor, mode: "still", config, store, backend })
          break
        case 1:
          if (backend.screengrab.isRecording()) {
            backend.screengrab.stopRecording()
          } else if (captureOverlayOpen() === "video") {
            // Video: toggle the capture overlay closed on a second click.
            closeMenu()
          } else {
            // Opens the video overlay; a STILL overlay that's open switches to
            // it instead (same fade-out → fade-in replace as the menus).
            openScreenGrabCaptureMenu({ monitor, mode: "video", config, store, backend })
          }
          break
        case 2:
          runCb(
            `mkdir -p ${shq(backend.screengrab.expandPath(config.screengrab.dir))} && xdg-open ${shq(backend.screengrab.expandPath(config.screengrab.dir))}`,
            () => {},
          )
          close()
          break
        case 3:
          // Settings: a second click closes the menu (toggle), matching the
          // wifi/bluetooth "Open menu" step semantics.
          if (menuKind() === SETTINGS_KIND) closeMenu()
          else openScreenGrabSettingsMenu({ monitor, config, store, backend })
          break
      }
    },
    logLabel: "screengrab",
  })

  // Recording state → row attention (red blink routing) + visibility + redraw.
  // Auto-hidden unless a recording is live (like the wifi/bt/media status
  // rules): idle, the icon parks in overflow; while recording it appears in
  // the row so the blink + elapsed stay reachable (and the overflow caret
  // takes over the blink during the brief parked transition).
  const syncRecording = () => {
    const rec = backend.screengrab.isRecording()
    hooks.setAppletHidden(port.name, !rec)
    hooks.setAppletAttention(port.name, rec)
    icon.queue_draw()
  }
  onCleanup(backend.screengrab.subscribeRecording(syncRecording))
  syncRecording()

  // The "Show dock" setting — the dock hides ONLY while a capture is in
  // flight (and the toggle is off) and is perfectly visible at all other
  // times. Follows the capture state (subscribeShowDock — capture start/stop
  // republishes the effective value) AND the live config (`config set/update`/
  // `reload` never call setShowDock). setDockVisible is idempotent, so
  // double-firing is harmless.
  const applyDockVis = (): void => hooks.setDockVisible(backend.screengrab.dockVisibleEffective())
  hooks.setDockVisible(backend.screengrab.dockVisibleEffective())
  onCleanup(backend.screengrab.subscribeShowDock(applyDockVis))
  onCleanup(store.onConfigChanged(applyDockVis))
}
