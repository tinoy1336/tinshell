/**
 * Workspaces applet — workspace switcher, slider form.
 *
 * A faithful clone of the Battery applet's structure (which is proven to
 * work), revised only for workspaces:
 *   - standard 0-100 continuous domain, 10% steps → 11 positions =
 *     workspaces 1-11 (workspace 1 at the bottom, 11 at the top, full pill);
 *   - the icon shows the workspace number (Battery's %-text slot) — the
 *     number under the cursor while dragging, the active workspace at rest;
 *   - dispatch (`hyprctl dispatch "hl.dsp.focus({ workspace = N })"`) fires
 *     once on release (commitOnRelease, like Battery's threshold write).
 *
 * No extras: no auto-hide, no tap-toggle, no extra controllers — the shared
 * factory (createContinuousApplet) already owns hover open/close, PanelHub
 * single-open, and the dock-row pokes.
 */
import { continuousPanel } from "@common/applets/panel-framework"
import { createContinuousApplet } from "@common/applets/shared/create-continuous-applet"
import { drawDisc, drawGlyph } from "@common/applets/shared/draw-utils"
import type { AppletContext, DrawIcon } from "@common/applets/types"
import { onCleanup } from "gnim"

/** Workspaces 1-11 (SUPER+1..9, SUPER+0 = 10, SUPER+MINUS = 11). */
const MAX_WS = 11
/** 10% increments over the standard 0-100 domain: positions 0,10,...,100. */
const STEP = 10

const valueFromWs = (ws: number): number => (ws - 1) * STEP
const wsFromValue = (v: number): number => Math.max(1, Math.min(MAX_WS, 1 + Math.round(v / STEP)))

export default function mount({ port, hooks, config, backend }: AppletContext): void {
  // Backend state: the active workspace, polled from hyprctl. Seed 0 (→ ws 1)
  // so the first draw has a value; the poll's sync() eases ringValue to the
  // real workspace (mirrors Battery's threshold seed + sync wiring).
  let active = 0

  // Tablet-driven poll lifecycle: the poll only runs while the applet is
  // ACTIVE (tablet mode). Deactivated (not tablet) = hidden + inert — the
  // 30s safety poll parks while the socket2 event listener stays cheaply
  // connected (refresh() itself no-ops while hidden). The tablet callback
  // seeds at boot, and the poll is started inside setupSubscriptions (which
  // runs during createContinuousApplet, BEFORE the tablet wiring below) — so
  // the seed always finds the refresh closure installed.
  let refreshPoll: (() => void) | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const stopPoll = (): void => {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const startPoll = (): void => {
    if (pollTimer !== null) return
    if (!refreshPoll) return
    pollTimer = setInterval(refreshPoll, Math.max(200, config.timing.workspacePoll))
  }

  // ── Icon: disc + workspace number (Battery's draw structure, revised) ──
  const drawWorkspacesIcon: DrawIcon = (
    cr,
    w,
    h,
    value,
    _state,
    _ringFill = 1,
    skipDisc = false,
    textValue = value,
  ) => {
    const size = config.layout.iconSize
    const cx = w / 2
    const cy = h / 2

    // Disc (always) — Battery pattern.
    if (!skipDisc) {
      drawDisc(config, cr, cx, cy, size / 2)
    }

    // Workspace number — always visible (Battery's wattage/% text slot).
    // textValue = step-quantized (ticks per 10% step); value = raw float
    // during a drag (the number follows the cursor to the nearest workspace).
    const text = String(wsFromValue(textValue ?? value))
    const sh = config.appearance.textShadow
    const gc = config.appearance.glyphColour
    drawGlyph(
      config,
      cr,
      cx,
      cy,
      text,
      config.fonts.labelSize,
      [gc.rgb[0], gc.rgb[1], gc.rgb[2], gc.alpha],
      undefined,
      sh.alpha,
    )
  }

  createContinuousApplet(port, {
    config,
    drawIcon: drawWorkspacesIcon,
    getState: () => false,
    getValue: () => valueFromWs(Math.max(1, active)),
    setupSubscriptions: ({ redraw, sync }) => {
      // Poll hyprctl for the active workspace; on change, sync() (eases the
      // closed icon's value + snaps an open panel) then redraw() (the number).
      const refresh = (): void => {
        if (port.isHiddenState()) return
        backend.workspaces.fetchWorkspaceState((s) => {
          if (s.active === active) return
          active = s.active
          sync()
          redraw()
        })
      }
      refreshPoll = refresh
      onCleanup(() => {
        refreshPoll = null
        stopPoll()
      })
      // PRIMARY: socket2 events (instant, no hyprctl churn while idle).
      // fetchWorkspaceState dedups (s.active === active early-return).
      onCleanup(backend.workspaces.onWorkspaceEvents(() => refresh()))
      // Safety net: config.timing.workspacePoll (now 30s) catches missed
      // events (socket2 hiccups, reconnect windows).
      startPoll()
      refresh()
    },
    buildPanel: ({ setDragActive, setPanelOh }) =>
      continuousPanel({
        config,
        setDragActive,
        setPanelOh,
        initialValue: valueFromWs(Math.max(1, active)),
        onValue: (v) => backend.workspaces.jumpToWorkspace(wsFromValue(v)),
        step: STEP,
        // The workspace dispatch happens once on release, not per drag-update.
        commitOnRelease: true,
        externalIcon: port.icon,
        render: port.render,
        dockGeometry: port.geometry,
      }),
    logLabel: "workspaces",
  })

  // Deactivation (tablet-driven) — the exact idiom of the hideable applets
  // (Wifi/Media/ScreenGrab), STRONGER: setAppletDeactivated hides the applet
  // regardless of the overflow MODE ("Show all" cannot revive it) and keeps
  // it out of the overflow reveal fan-out. Deactivated = hidden AND the poll
  // is suspended; activated = visible AND the poll resumes. onTabletChange
  // seeds with the current value and fires on change.
  const applyTabletVisibility = (tablet: boolean): void => {
    hooks.setAppletDeactivated(port.name, !tablet)
    if (tablet) startPoll()
    else stopPoll()
    if (!port.isOpen() && !port.isHiddenState()) port.icon.queue_draw()
  }
  const unsubTablet = backend.tablet.onTabletChange(applyTabletVisibility)
  onCleanup(unsubTablet)
}
