/**
 * Power applet — the uptime as the disc's content (from the backend's served
 * `system systemUptime` member, formatted by the shared
 * `common/applets/shared/elapsed`), the power glyph as the no-readout fallback,
 * and the sleep/hibernate/restart/shutdown step selector.
 */
import type { AppletConfig } from "@common/applets/config"
import { createStepApplet } from "@common/applets/shared/create-step-applet"
import { clamp01, drawDisc, drawGlyph } from "@common/applets/shared/draw-utils"
import { formatElapsed } from "@common/applets/shared/elapsed"
import type { AppletContext, DrawIcon } from "@common/applets/types"
import { onCleanup } from "gnim"

/** Step emojis read live from config so they can be restyled without a restart.
 *  Labels and onSelect actions are aligned: Sleep → sleep, Hibernate →
 *  hibernate, Restart → reboot, Shutdown → shutdown. */
const stepDefs = (config: AppletConfig): { label: string; emoji: string }[] => [
  { label: "Sleep", emoji: config.appearance.icons.sleep },
  { label: "Hibernate", emoji: config.appearance.icons.hibernate },
  { label: "Restart", emoji: config.appearance.icons.restart },
  { label: "Shutdown", emoji: config.appearance.icons.shutdown },
]

/** The disc's fallback glyph, painted only when no uptime could be sourced
 *  (a host with no live backend to serve the member): the applet is the power
 *  control, so an unreadable disc still marks it instead of reading as an empty
 *  cell. Nerd Font glyph. */
const POWER_GLYPH = "\uf011" // nf-fa-power_off (U+F011, power)

export default function mount({ port, hooks, config, backend }: AppletContext): void {
  // Parked in overflow by default (auto mode) — revealed via the overflow
  // caret, or forced visible by the overflow pill's "Show all" step.
  hooks.setAppletHidden(port.name, true)
  // Seed with a placeholder; the immediate async read (and the 1s timer) populate it.
  let uptime = ""

  const drawPowerIcon: DrawIcon = (
    cr,
    w,
    h,
    _value,
    _state,
    ringFill = 1,
    _skipDisc,
    _textValue,
  ) => {
    const rf = clamp01(ringFill)
    const size = Math.min(w, h)
    drawDisc(config, cr, size / 2, size / 2, size / 2)
    const sh = config.appearance.textShadow
    if (!uptime) {
      // No readout sourced (no backend answered the member).
      const gc = config.appearance.glyphColour
      drawGlyph(
        config,
        cr,
        size / 2,
        size / 2,
        POWER_GLYPH,
        config.fonts.iconSize,
        [gc.rgb[0], gc.rgb[1], gc.rgb[2], gc.alpha * rf],
        undefined,
        sh.alpha * rf,
      )
      return
    }
    // The readout is the disc's face, in the applet's own readout metrics:
    // `appearance.uptimeTextColour` at `fonts.labelSize`, centred on the disc.
    const ut = config.appearance.uptimeTextColour
    drawGlyph(
      config,
      cr,
      size / 2,
      size / 2,
      uptime,
      config.fonts.labelSize,
      [ut.rgb[0], ut.rgb[1], ut.rgb[2], ut.alpha * rf],
      undefined,
      sh.alpha * rf,
    )
  }

  /** Refresh the readout from the SERVED member (`applets system
   *  systemUptime`) — the ONE source on every host: the dock's request
   *  transport and the greeter's socket both reach it, while the `fs` domain
   *  stays unreachable for socket peers. */
  function refresh(): void {
    void backend.system.systemUptime().then((u) => {
      const next = u === null ? "" : formatElapsed(u)
      if (next === uptime) return // text unchanged — nothing to repaint
      uptime = next
      if (!port.isOpen() && !port.isHiddenState()) port.icon.queue_draw()
    })
  }

  const timer = setInterval(refresh, config.timing.poll.uptime)
  onCleanup(() => clearInterval(timer))
  refresh()

  createStepApplet(port, {
    config,
    getStepColour: (i: number) => config.appearance.stepColours.power[i],
    steps: stepDefs(config),
    drawIcon: drawPowerIcon,
    getInitialStep: () => 0,
    onSelect: (step) => {
      switch (step) {
        case 0:
          backend.power.executePowerAction("sleep")
          break
        case 1:
          backend.power.executePowerAction("hibernate")
          break
        case 2:
          backend.power.executePowerAction("reboot")
          break
        case 3:
          backend.power.executePowerAction("shutdown")
          break
      }
    },
    logLabel: "power",
  })
}
