/**
 * Keyboard applet — on-screen-keyboard show mode + layout cycle.
 */
import { config as keyboardConfig, keyboardEnabled } from "@apps/keyboard/config"
import type { AppletConfig } from "@common/applets/config"
import { createStepApplet } from "@common/applets/shared/create-step-applet"
import { clamp01, drawDisc, drawGlyph } from "@common/applets/shared/draw-utils"
import type { AppletContext } from "@common/applets/types"
import { dispatch } from "@common/commands/registry"
import { onCleanup } from "gnim"

// ── Steps ──
// The keyboard is merged into the shell process (bus io.Astal.shell), gated
// behind keyboard.enabled (startup-read only — restart to apply). Four options:
//   0 Hide  — keyboard.showMode = "hide" (never show the OSK)
//   1 Show  — keyboard.showMode = "show" (always show the OSK)
//   2 Auto  — keyboard.showMode = "auto" (tablet-driven show/hide)
//   3 Mode  — cycle the keyboard layout (standard ↔ thumbs)
// The active showMode is highlighted on open (getInitialStep). When
// keyboard.enabled=false all steps NO-OP (stay visible, do nothing); when
// deactivated (not in tablet mode) the applet is hidden AND inert.

type ShowMode = "auto" | "show" | "hide"

const STEPS = (config: AppletConfig): { label: string; emoji: string }[] => [
  { label: "Hide", emoji: config.appearance.icons.keyboardHide },
  { label: "Show", emoji: config.appearance.icons.keyboardShow },
  { label: "Auto", emoji: config.appearance.icons.keyboardShow },
  { label: "Mode", emoji: config.appearance.icons.keyboardCycle },
]

const showModeStep = (m: ShowMode): number => (m === "hide" ? 0 : m === "show" ? 1 : 2)

function drawIcon(
  config: AppletConfig,
  cr: any,
  w: number,
  h: number,
  _value: number,
  _state: boolean,
  ringFill = 1,
  _skipDisc?: boolean,
  _textValue?: number,
): void {
  const rf = clamp01(ringFill)
  const size = Math.min(w, h)
  drawDisc(config, cr, size / 2, size / 2, size / 2)
  const glyph = config.appearance.icons.keyboardShow
  const gc = config.appearance.glyphColour
  drawGlyph(
    config,
    cr,
    size / 2,
    size / 2,
    glyph,
    config.fonts.iconSize,
    [gc.rgb[0], gc.rgb[1], gc.rgb[2], gc.alpha * rf],
    undefined,
    config.appearance.textShadow.alpha * rf,
  )
}

export default function mount({ port, hooks, config, backend }: AppletContext): void {
  // Live tablet state for the belt-and-suspenders no-op guard (a deactivated
  // applet is hidden so its panel can't open, but the guard keeps a stale
  // open panel from committing a step).
  let tabletActive = false

  createStepApplet(port, {
    config,
    steps: STEPS(config),
    getStepColour: (i: number) => config.appearance.stepColours.keyboard[i],
    getInitialStep: () => showModeStep((keyboardConfig.showMode as ShowMode) ?? "auto"),
    drawIcon: (cr, w, h, v, s, rf, sd, tv) => drawIcon(config, cr, w, h, v, s, rf, sd, tv),
    onSelect: (step, close) => {
      // keyboard.enabled=false → the applet stays visible but steps no-op
      // (user-locked: the merged shell's keyboard surface is config-gated).
      if (!keyboardEnabled()) {
        console.log(`[keyboard-applet] step ${step}: disabled (keyboard.enabled=false)`)
        close()
        return
      }
      // Deactivated (not in tablet mode) → steps no-op (belt-and-suspenders:
      // the applet is hidden so the panel can't open normally).
      if (!tabletActive) {
        console.log(`[keyboard-applet] step ${step}: deactivated (not in tablet mode)`)
        close()
        return
      }
      switch (step) {
        case 0:
          // Never show the OSK (sticky until Show/Auto is picked).
          dispatch(["keyboard", "show-mode", "set", "hide"], () => {})
          break
        case 1:
          // Always show the OSK (sticky until Hide/Auto is picked).
          dispatch(["keyboard", "show-mode", "set", "show"], () => {})
          break
        case 2:
          // Tablet-driven auto show/hide.
          dispatch(["keyboard", "show-mode", "set", "auto"], () => {})
          break
        case 3:
          // Cycle the keyboard's layout through the internal command tree.
          dispatch(["keyboard", "layout", "next"], () => {})
          break
      }
      close()
    },
    logLabel: "keyboard",
  })

  // Deactivation (tablet-driven) — same contract as the workspaces applet:
  // hidden regardless of overflow MODE + kept out of the reveal fan-out while
  // not in tablet mode. onTabletChange seeds with the current value.
  const applyTabletVisibility = (tablet: boolean): void => {
    tabletActive = tablet
    hooks.setAppletDeactivated(port.name, !tablet)
    if (!port.isOpen() && !port.isHiddenState()) port.icon.queue_draw()
  }
  const unsubTablet = backend.tablet.onTabletChange(applyTabletVisibility)
  onCleanup(unsubTablet)
}
