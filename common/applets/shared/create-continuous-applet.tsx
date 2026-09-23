import type { AppletWindow } from "@common/applets/applet-window"
import type { AppletConfig } from "@common/applets/config"
import type { DrawIcon, Panel } from "@common/applets/types"
import { type AppletCoreHandle, createAppletCore } from "./create-applet-core"

interface ContinuousAppletOpts {
  drawIcon: DrawIcon
  /** The host's live config view (geometry, timing, appearance). */
  config: AppletConfig
  getState: () => boolean
  getValue: () => number
  setupSubscriptions: (callbacks: { redraw: () => void; sync: () => void }) => void
  buildPanel: (ctx: {
    setDragActive: (active: boolean) => void
    /** Report the grown pill extent (oh) to the shared surface's region engine. */
    setPanelOh: (oh: number) => void
  }) => Panel
  /** Called when the panel finishes opening (parity with StepAppletOpts). */
  onPanelOpen?: () => void
  /** Called when the panel fully closes (parity with StepAppletOpts). */
  onPanelClosed?: () => void
  logLabel?: string
}

/**
 * Wires a continuous-slider applet (Volume / Brightness / Battery / Workspaces) to its
 * panel — thin wrapper over the shared createAppletCore state machine (see
 * create-applet-core.ts):
 *
 *   - Hover the icon → open (zero delay). Move away → close after 220ms grace.
 *   - The real applet icon is reparented into the panel on open (spatial
 *     continuity) and returned on close.
 *   - During the open animation the panel overrides the icon's displayed value
 *     through the applet's render state; when closed the icon reads its
 *     own ringValue (smoothed by the core's closed-state ring smoother).
 *   - External value changes (volume keys, etc.) arrive via sync(). If a drag
 *     or animation is in progress the change is deferred (the panel's
 *     onExternalChange returns early while animating); otherwise the icon's
 *     ringValue eases toward the new value.
 *
 * Single-open is enforced via PanelHub: opening this panel closes any other.
 */
export function createContinuousApplet(
  aw: AppletWindow,
  opts: ContinuousAppletOpts,
): AppletCoreHandle {
  return createAppletCore(aw, {
    drawIcon: opts.drawIcon,
    config: opts.config,
    onPanelOpen: opts.onPanelOpen,
    onPanelClosed: opts.onPanelClosed,
    logLabel: opts.logLabel,
    buildPanel: ({ setDragActive }) =>
      opts.buildPanel({
        setDragActive,
        setPanelOh: (oh) => aw.setPanelOh(oh),
      }),
    draw: { state: opts.getState, channels: true },
    setupSubscriptions: opts.setupSubscriptions,
    getValue: opts.getValue,
  })
}
