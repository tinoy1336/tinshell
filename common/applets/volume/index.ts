/**
 * Volume applet — default-sink slider.
 *
 * The sink itself is read and written through the `volume` backend domain
 * (`common/applets/domains/volume`), the same one the overflow clock's
 * transient readout reads: no applet touches PipeWire on its own, and a host
 * that binds no volume domain has no sink to show — see the mount guard below.
 * The domain is the contract's only OPTIONAL domain, because a process without
 * a session (the pre-login greeter) has no session audio at all.
 */
import type { AppletConfig } from "@common/applets/config"
import type { SpeakerKind } from "@common/applets/domains/volume"
import { continuousPanel } from "@common/applets/panel-framework"
import { createContinuousApplet } from "@common/applets/shared/create-continuous-applet"
import { compensatedAlpha, drawDisc, drawGlyph, drawRings } from "@common/applets/shared/draw-utils"
import {
  createElementFade,
  type ElementFade,
  withFadeAlpha,
} from "@common/applets/shared/element-fade"
import type { AppletContext } from "@common/applets/types"
import { onCleanup } from "gnim"
import { volumeRingColour } from "./colour"

function volumeGlyph(config: AppletConfig, vol: number, muted: boolean): string {
  const ic = config.appearance.icons
  if (muted) return ic.volumeMuted
  if (vol === 0) return ic.volumeSilent
  if (vol < config.appearance.thresholds.volumeHigh) return ic.volumeLow
  return ic.volumeHigh
}

/** The applet's declared fade elements: the level ring's colour and the glyph
 *  (see mount). The % text is not one — it paints once per paint. */
interface VolumeFades {
  ring: ElementFade<[number, number, number, number]>
  glyph: ElementFade<string>
}

const drawVolumeIcon = (
  config: AppletConfig,
  fades: VolumeFades,
  cr: any,
  w: number,
  h: number,
  vol: number,
  muted: boolean,
  ringFill = 1,
  skipDisc = false,
  _textValue?: number,
  kind: SpeakerKind = "speaker",
): void => {
  const size = config.layout.iconSize
  const cx = w / 2
  const cy = h / 2
  const thickness = config.appearance.ringThickness
  const radius = (size - thickness) / 2
  const rc = volumeRingColour(kind, config)

  if (!skipDisc) {
    drawDisc(config, cr, cx, cy, size / 2)
  }

  if (vol > 0 && !muted) {
    // The colour is this applet's ring fade element: a sink of another class
    // cross-fades its colour into the new one.
    fades.ring.paint(rc, (colour, alpha) =>
      drawRings(
        cr,
        cx,
        cy,
        radius,
        thickness,
        [{ start: 0, end: vol, colour: withFadeAlpha(colour, alpha) }],
        ringFill,
      ),
    )
  }

  // Glyph (fades out as ringFill→0)
  if (ringFill > 0.001) {
    fades.glyph.paint(volumeGlyph(config, vol, muted), (glyph, alpha) =>
      drawGlyph(
        config,
        cr,
        cx,
        cy,
        glyph,
        config.fonts.iconSize,
        [0.9, 0.9, 0.9, ringFill * alpha],
        undefined,
        config.appearance.textShadow.alpha * ringFill * alpha,
      ),
    )
  }

  // % text (fades in as ringFill→0)
  if (1 - ringFill > 0.001) {
    const pctText = `${Math.round(vol)}`
    const pt = config.appearance.pctTextColour
    drawGlyph(config, cr, cx, cy, pctText, config.fonts.labelSize, [
      pt.rgb[0],
      pt.rgb[1],
      pt.rgb[2],
      pt.alpha * (1 - ringFill),
    ])
  }
}

/** The "no output device" surface: a muted disc in the disabled palette,
 *  faded by the applet's birth intro like every other disabled applet. */
function drawDisabledDisc(
  config: AppletConfig,
  cr: any,
  w: number,
  h: number,
  intro: number,
): void {
  const size = Math.min(w, h)
  const dd = config.appearance.disabledDisc
  const dg = config.appearance.disabledGlyph
  const paint = (): void => {
    drawDisc(config, cr, size / 2, size / 2, size / 2, [
      dd.rgb[0],
      dd.rgb[1],
      dd.rgb[2],
      compensatedAlpha(dd.alpha, config),
    ] as [number, number, number, number])
    drawGlyph(
      config,
      cr,
      size / 2,
      size / 2,
      config.appearance.icons.volumeSilent,
      config.fonts.iconSize,
      [dg.rgb[0], dg.rgb[1], dg.rgb[2], dg.alpha] as [number, number, number, number],
      undefined,
      0.31,
    )
  }
  // Plain alpha fade of disc + glyph (no radial sweep).
  cr.save()
  if (intro < 1) {
    cr.pushGroup()
    paint()
    cr.popGroupToSource()
    cr.paintWithAlpha(intro)
  } else {
    paint()
  }
  cr.restore()
}

export default function mount({ port, config, backend }: AppletContext): void {
  // A host that binds NO volume domain has no sink to read — the pre-login
  // greeter runs before any session audio exists (apps/greeter/strip/Strip.tsx
  // reaches the session domains over the socket and deliberately carries no
  // volume domain). Paint the disabled disc rather than a reading nothing can
  // supply.
  const volume = backend.volume
  if (!volume) {
    port.icon.set_draw_func((_, cr, w, h) => {
      drawDisabledDisc(config, cr, w, h, port.render.intro)
    })
    return
  }

  const sink = volume.volumeState(config.timing.poll.volume)

  // This applet declares two fade-eligible elements — the level ring's colour
  // and the glyph. The % text and the disabled disc are painted once per paint.
  const fades: VolumeFades = {
    ring: createElementFade<[number, number, number, number]>(port, config, "ring"),
    glyph: createElementFade<string>(port, config, "glyph"),
  }
  onCleanup(() => {
    fades.ring.dispose()
    fades.glyph.dispose()
  })

  createContinuousApplet(port, {
    config,
    drawIcon: (cr, w, h, v, m, rf, sd, tv) => {
      const state = sink.peek()
      // A domain bound in a process that has no default sink (WirePlumber not
      // up yet, or no output device): the disabled surface, and the slider's
      // writes stay no-ops in the domain until a sink exists.
      if (!state.available) {
        drawDisabledDisc(config, cr, w, h, port.render.intro)
        return
      }
      drawVolumeIcon(config, fades, cr, w, h, v, m, rf, sd, tv, state.kind)
    },
    getState: () => sink.peek().muted,
    getValue: () => sink.peek().volume,
    setupSubscriptions: ({ sync }) => {
      // The domain publishes a sink change (a drag, a media key, a sink swap)
      // with the value already resolved, so the applet takes the full-sync path
      // on every state change — the same path an external change used to take.
      onCleanup(sink.subscribe(() => sync()))
    },
    buildPanel: ({ setDragActive, setPanelOh }) =>
      continuousPanel({
        config,
        setDragActive,
        setPanelOh,
        initialValue: sink.peek().volume,
        onValue: (v) => volume.setVolume(v),
        externalIcon: port.icon,
        render: port.render,
        dockGeometry: port.geometry,
      }),
    logLabel: "volume",
  })
}
