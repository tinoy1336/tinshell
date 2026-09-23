/**
 * LockSession applet — sleep-inhibit toggle, notifications, lock, logout.
 */
import type { AppletBackend } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import { createStepApplet } from "@common/applets/shared/create-step-applet"
import { clamp01, drawDisc, drawGlyph } from "@common/applets/shared/draw-utils"
import type { AppletContext } from "@common/applets/types"
import { dispatch } from "@common/commands/registry"

// Step emojis read live from config so they can be restyled without a restart.
// The Notifs step's bell is static (the control centre's open state has no
// query); the unified Sleep step's icon reflects the live inhibit state
// (lock = sleep blocked, unlock = sleep allowed).
//
// The Sleep emoji is an accessor, not a captured value: the panel reads the
// step emojis on every paint, while the inhibit flips outside this applet (the
// backend re-applies the persisted inhibit after mount, logind clients toggle
// it). A value captured at mount pins the panel's Sleep step to the pre-change
// glyph while the dock icon (drawLockIcon) and dockGlyph.emoji read the state
// live — the collapsed and expanded views would then show different glyphs for
// the same state. Same accessor pattern as the Overflow applet's steps.
function stepDefs(
  config: AppletConfig,
  backend: AppletBackend,
): { label: string; emoji: string }[] {
  return [
    {
      label: "Sleep",
      get emoji() {
        const active = backend.power.isInhibitActive()
        return active ? config.appearance.icons.sleepBlocked : config.appearance.icons.sleepAllowed
      },
    },
    { label: "Notifs", emoji: config.appearance.icons.notifications },
    { label: "Lock", emoji: config.appearance.icons.lock },
    { label: "Logout", emoji: config.appearance.icons.logout },
  ]
}

function drawLockIcon(
  config: AppletConfig,
  backend: AppletBackend,
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
  const ic = config.appearance.icons
  const active = backend.power.isInhibitActive()
  drawDisc(config, cr, size / 2, size / 2, size / 2)
  drawGlyph(
    config,
    cr,
    size / 2,
    size / 2,
    active ? ic.sleepBlocked : ic.sleepAllowed,
    config.fonts.iconSize,
    [0.9, 0.9, 0.9, rf],
    undefined,
    config.appearance.textShadow.alpha * rf,
  )
}

export default function mount({ port, hooks, config, backend }: AppletContext): void {
  // Parked in overflow by default (auto mode) — revealed via the overflow
  // caret, or forced visible by the overflow pill's "Show all" step.
  hooks.setAppletHidden(port.name, true)
  const handle = createStepApplet(port, {
    config,
    getStepColour: (i: number) => config.appearance.stepColours.lockSession[i],
    steps: stepDefs(config, backend),
    drawIcon: (cr, w, h, v, s, rf, sd, tv) =>
      drawLockIcon(config, backend, cr, w, h, v, s, rf, sd, tv),
    // Declare the closed-state dock glyph identity (it IS a single emoji: the
    // white sleep icon, same codepoint as the step-0 "Sleep" option). The
    // panel judges on the fly (codepoint + colour) whether to suppress the
    // hover cross-fade while the disc sits at index 0 (no blink).
    dockGlyph: {
      emoji: () => {
        const active = backend.power.isInhibitActive()
        return active ? config.appearance.icons.sleepBlocked : config.appearance.icons.sleepAllowed
      },
      colour: { rgb: [0.9, 0.9, 0.9], alpha: 0.9 },
    },
    getInitialStep: () => 0,
    onSelect: (step, close) => {
      switch (step) {
        // Unified sleep toggle: inhibits idle-sleep when allowed, releases
        // when blocked (executePowerAction("inhibit") is a toggle). The flip
        // is synchronous; redraw() repaints the pill + dock glyph so the
        // Sleep emoji tracks the new state immediately.
        case 0:
          // Redraw AFTER the action resolves: the promise settles once the
          // client has re-read the polled inhibit state, so this paints the
          // new glyph. Redrawing on the next line instead reads the
          // pre-toggle memo — and nothing repaints when it later catches up.
          void backend.power.executePowerAction("inhibit").then(() => {
            handle.redraw()
          })
          break
        // Notifications: toggle the merged shell's notifications control
        // centre via the internal command tree (in-process dispatch, no bus
        // hop). Fire-and-forget — the pill stays open until the cursor leaves.
        case 1:
          dispatch(["notifications", "toggle-centre"], () => {})
          break
        case 2:
          backend.power.executePowerAction("lock")
          close()
          break
        case 3:
          backend.power.executePowerAction("logout")
          close()
          break
      }
    },
    logLabel: "lock",
  })

  // The persisted sleep inhibit is re-applied by the process that hosts the
  // applet backend and owns the logind fd (the dock), not by this applet.
}
