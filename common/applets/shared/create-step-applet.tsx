import type { AppletWindow } from "@common/applets/applet-window"
import type { AppletConfig } from "@common/applets/config"
import { type DockGlyphDescriptor, stepPanel } from "@common/applets/panel-framework"
import type { DrawIcon } from "@common/applets/types"
import { type AppletCoreHandle, createAppletCore } from "./create-applet-core"

interface StepAppletOpts {
  steps: { label: string; emoji: string }[]
  /** The host's live config view (geometry, timing, appearance). */
  config: AppletConfig
  /** Called each frame during painting — must read from C at call time. */
  getStepColour: (index: number) => { rgb: number[]; alpha: number }
  /** Re-evaluated on each open — the step to land the icon on when the panel opens. */
  getInitialStep: () => number
  /** Icon draw function. The factory wires it into the icon's set_draw_func
   *   and passes render.ringFill so the glyph fades during panel open/close. */
  drawIcon: DrawIcon
  /** The applet's closed-state dock glyph when it IS a single emoji glyph
   *   (most step applets draw rings/text — leave unset). The panel judges on
   *   the fly whether it's identical to the index-0 option (same codepoint
   *   AND same colour); when it is, the open cross-fade is suppressed — the
   *   disc does not move for index 0, so fading the identical icon out (dock
   *   glyph) and back in (step-0 emoji) at the same spot would blink. */
  dockGlyph?: DockGlyphDescriptor
  /** Fires when the user commits a step (drag-release or click-snap). The factory
   *  does NOT auto-close — pass the supplied `close` callback if the applet wants
   *  to dismiss the panel after selecting (e.g. LockSession). */
  onSelect: (step: number, close: () => void) => void
  /** When true, the leave-grace close is suppressed (panel stays open even
   *  after the cursor leaves). Used by wifi/bluetooth while their GUI is open. */
  keepOpen?: () => boolean
  /** Called when the panel finishes opening (used by overflow: beginReveal). */
  onPanelOpen?: () => void
  /** Called when the panel fully closes (used by overflow: endReveal; also
   *  lets the dock row apply deferred hides). */
  onPanelClosed?: () => void
  logLabel?: string
}

/** Handle returned by createStepApplet for applets that need to push external
 *  changes into the open panel (e.g. Performance's TLP poller). */
type StepAppletHandle = AppletCoreHandle

/**
 * Wires a step-selector applet (Performance / Lock-Session / Power / Wifi /
 * Bluetooth / Media / Overflow) to its panel — thin wrapper over the
 * shared createAppletCore state machine (see create-applet-core.ts):
 *
 *   - One motion controller on the WINDOW (not the icon + panel separately).
 *     The window's input region is the disc (closed) / stadium (open)
 *     silhouette, so a single controller reliably reports enter/leave on the
 *     window boundary — no dual-controller boundary-interleaving (the bug that
 *     caused spurious closes when the cursor crossed the icon/pill edge).
 *   - Hover the window → open (zero delay). Move away → close after 220ms grace.
 *   - Re-entering the window mid-close reverses the close in-place on the SAME
 *     panel (no rebuild, no leaked animateOut).
 *   - The real applet icon is reparented into the panel on open and returned on
 *     close; during animation the panel drives the icon through the applet's
 *     render state (value + ring fill).
 *   - Single-open is enforced via PanelHub across ALL applets (step and continuous).
 */
export function createStepApplet(aw: AppletWindow, opts: StepAppletOpts): StepAppletHandle {
  return createAppletCore(aw, {
    drawIcon: opts.drawIcon,
    config: opts.config,
    keepOpen: opts.keepOpen,
    onPanelOpen: opts.onPanelOpen,
    onPanelClosed: opts.onPanelClosed,
    logLabel: opts.logLabel,
    buildPanel: ({ setDragActive, close }) =>
      stepPanel({
        steps: opts.steps,
        config: opts.config,
        getStepColour: opts.getStepColour,
        initialStep: opts.getInitialStep(),
        externalIcon: aw.icon,
        render: aw.render,
        onSelect: (step) => opts.onSelect(step, close),
        setDragActive,
        dockGlyph: opts.dockGlyph,
        dockGeometry: aw.geometry,
        setPanelOh: (oh) => aw.setPanelOh(oh),
        // During move mode the closing overflow pill must not claim step
        // selections (that would clobber the overflow mode or interrupt the
        // close) — the move drag owns presses then.
        dragEnabled: () => !(aw.row?.isMoveMode?.() ?? false),
      }),
    draw: { state: () => false, channels: false },
  })
}
