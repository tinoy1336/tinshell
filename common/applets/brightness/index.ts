/**
 * Brightness applet — screen-backlight slider.
 */
import type { AppletConfig } from "@common/applets/config"
import { continuousPanel } from "@common/applets/panel-framework"
import { createContinuousApplet } from "@common/applets/shared/create-continuous-applet"
import { clamp01, drawDisc, drawGlyph, drawRings } from "@common/applets/shared/draw-utils"
import type { AppletContext } from "@common/applets/types"
import { onCleanup } from "gnim"

function drawBrightnessIcon(
  config: AppletConfig,
  cr: any,
  w: number,
  h: number,
  value: number,
  _state: boolean,
  ringFill = 1,
  skipDisc = false,
  _textValue?: number,
): void {
  const size = config.layout.iconSize
  const cx = w / 2
  const cy = h / 2
  const thickness = config.appearance.ringThickness
  const radius = (size - thickness) / 2
  const ringColour = config.appearance.ringColours.brightness
  const rc: [number, number, number, number] = [
    ringColour.rgb[0],
    ringColour.rgb[1],
    ringColour.rgb[2],
    ringColour.alpha,
  ]
  const rf = clamp01(ringFill)

  if (!skipDisc) {
    drawDisc(config, cr, cx, cy, size / 2)
  }

  if (value > 0) {
    drawRings(cr, cx, cy, radius, thickness, [{ start: 0, end: value, colour: rc }], rf)
  }

  // Glyph (fades out as ringFill→0)
  if (rf > 0.001) {
    drawGlyph(
      config,
      cr,
      cx,
      cy,
      config.appearance.icons.brightness,
      config.fonts.iconSize,
      [0.9, 0.9, 0.9, rf],
      undefined,
      config.appearance.textShadow.alpha * rf,
    )
  }

  // % text (fades in as ringFill→0)
  if (1 - rf > 0.001) {
    const pctText = `${Math.round(value)}`
    const pt = config.appearance.pctTextColour
    drawGlyph(config, cr, cx, cy, pctText, config.fonts.labelSize, [
      pt.rgb[0],
      pt.rgb[1],
      pt.rgb[2],
      pt.alpha * (1 - rf),
    ])
  }
}

export default function mount({ port, config, backend }: AppletContext): void {
  const bl = backend.brightness.brightnessState(config.timing.poll.brightness)

  createContinuousApplet(port, {
    config,
    drawIcon: (cr, w, h, v, s, rf, sd, tv) =>
      drawBrightnessIcon(config, cr, w, h, v, s, rf, sd, tv),
    getState: () => false,
    getValue: () => bl.peek().screen,
    setupSubscriptions: ({ sync }) => {
      onCleanup(bl.subscribe(() => sync()))
    },
    buildPanel: ({ setDragActive, setPanelOh }) =>
      continuousPanel({
        config,
        setDragActive,
        setPanelOh,
        initialValue: bl.peek().screen,
        onValue: (v) => backend.brightness.setScreenBrightness(v),
        externalIcon: port.icon,
        render: port.render,
        dockGeometry: port.geometry,
      }),
    logLabel: "brightness",
  })
}
