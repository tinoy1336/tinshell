/**
 * common/applets/applet-window.ts — the applet-facing binding contract.
 *
 * ONE implementation of the AppletWindow state machine that every applet host
 * runs its applets against — the dock app (apps/dock) and the greeter strip
 * (apps/greeter) both build their bindings with the surface-backed factory
 * `common/applets/surface/applet.ts`.
 *
 * Share, never copy: the genuinely substrate-independent core lives HERE — the
 * `AppletWindow` interface, the open/teardown/hidden flags, the appear
 * channel, can-target seeding, and the attach/detach orchestration. Every
 * substrate-specific action goes through the thin `AppletBindingPort`, whose
 * ONE implementation performs `AppletSurface` ops keyed by applet name — the
 * substrate difference itself (layer-shell band vs embedded strip) lives in
 * the renderer's `AppletSurfaceHost` (common/applets/surface/host.ts).
 *
 * The shared core must not change host behaviour: nothing in either host's
 * widget tree, surface machinery, or dock-row is touched here. Applet modules
 * (apps/dock/Overflow.tsx) consume the `AppletWindow` shape — which stays
 * GENERIC over the row/surface so each app's own, richer row type survives at
 * its adapter seam (the dock applets need the FULL DockRow, e.g. move-mode /
 * overflow ops; the greeter needs only its row stub).
 *
 * The one thing deliberately NOT centralized: each host's own intro/hidden
 * VISUALS. The surface-backed factory parks `render.intro=0` and leaves it 0
 * until the caller replays the appear (dock row reveal/unhide); the greeter's
 * adapter flips `render.intro` 0↔1 directly and drives cell.visible via its
 * gate. Those stay in each port's setHidden, so each host keeps its hidden
 * semantics.
 */

import type { AppletConfig } from "@common/applets/config"
import { createRenderState, type RenderState } from "@common/applets/render-state"
import type { Astal, Gtk } from "ags/gtk4"

/** The geometry members applet bindings and applet cores read off `aw`.
 *  Structurally IDENTICAL to dock's DockGeometry (anchor type included) so
 *  values flow both ways without casts — the shared core never imports an
 *  app module, dock passes its real DockGeometry in and applet code that
 *  expects a DockGeometry-shaped object keeps type-checking. */
export interface AppletGeometry {
  position: string
  rotation: number
  growDir: 1 | -1
  rowAxis: "x" | "y"
  growAxis: "x" | "y"
  anchor: Astal.WindowAnchor
  rowAlign: "center" | "start" | "end"
  margin: { top: number; bottom: number; left: number; right: number }
}

/** The pointer-handler set applet cores install for closed-state routing. */
export interface AppletPointerHandlers {
  onEnter?: (x: number, y: number) => void
  onLeave?: () => void
  onMotion?: (x: number, y: number) => void
  onPressOpen?: (x: number, y: number) => void
}

/** Indicator-level hover listeners (e.g. the overflow clock). */
export interface AppletHoverHandlers {
  onEnter?: (x: number, y: number) => void
  onLeave?: () => void
  onMotion?: (x: number, y: number) => void
}

/**
 * The shared applet-facing binding. Generic over the ROW type so each app
 * keeps the row it actually hands its applets (dock: full DockRow; greeter:
 * its row stub). The DEFAULT is the common minimal row shape — the greeter
 * binds against that; the dock instantiates with its DockRow.
 */
export interface AppletWindow<TRow = AppletRowLike> {
  /** The hosting window (dock: the shared surface window; greeter: the hosting
   *  window, or the strip's own row before that window exists — resolved once
   *  at build time). */
  window: Gtk.Window
  icon: Gtk.DrawingArea
  geometry: AppletGeometry
  /** The layer surface this binding is attached to (dock only; greeter:
   *  null — its host has no layer surface). */
  surface: unknown
  attachIconTo: (overlay: unknown) => void
  detachIcon: () => void
  isOpen: () => boolean
  /** Play the appear animation — forward (0→1) by default, reverse (1→0) to
   *  retract. Resolves when the run completes (or is superseded / skipped,
   *  e.g. appearAnim=0). */
  playAppear: (reverse?: boolean, ease?: (t: number) => number) => Promise<void>
  setTearingDown: (v: boolean) => void
  isTearingDown: () => boolean
  /** Applet key ("wifi", "battery", …). */
  name: string
  /** Per-applet render values, owned by this binding and written in place by
   *  the applet core, the appear run, the open panel and the dock row. */
  render: RenderState
  /** Owning row (dock: the dock row; greeter: its row stub). */
  row?: TRow
  setHiddenState: (hidden: boolean) => void
  setInputEmpty: () => void
  isHiddenState: () => boolean
  setPointerHandlers: (handlers: AppletPointerHandlers) => void
  addHoverListener: (handlers: AppletHoverHandlers) => void
  setPanelOh: (oh: number) => void
}

/** The minimal row contract (dock's DockRow and the greeter's row stub both
 *  satisfy it; the dock applet cores use this subset through `aw.row`). */
export interface AppletRowLike {
  setAppletHidden: (name: string, hidden: boolean) => void
  setAppletDeactivated: (name: string, v: boolean) => void
  setPanelOpen: (name: string, open: boolean) => void
  isMoveMode?: () => boolean
  cursorEnter?: (name: string) => void
  cursorLeave?: (name: string) => void
  noteInteraction?: (name: string) => void
  setAppletAttention?: (name: string, active: boolean) => void
  setDockVisible?: (visible: boolean) => void
}

/** The appear-channel functions a host binds to its icon. Implemented once in
 *  `@common/applets/utils/appear`; hosts inject it so the binding core never
 *  imports a host module. */
interface AppearChannel {
  startAppear: (
    icon: Gtk.DrawingArea,
    render: RenderState,
    config: AppletConfig,
    opts: { reverse?: boolean; onDone?: () => void; ease?: (t: number) => number },
  ) => void
  cancelAppear?: (icon: Gtk.DrawingArea) => void
}

/** Everything a binding needs from its substrate. Implemented per app —
 *  the port is the ONLY seam. */
export interface AppletBindingPort {
  /** Applet key. */
  name: string
  geometry: AppletGeometry
  /** The applet's icon widget, created by the substrate. */
  icon: Gtk.DrawingArea
  /** The hosting window, resolved ONCE at build time. Each port returns a
   *  non-null value with its host's semantics (dock: the layer window;
   *  greeter: the hosting window or the strip's row before it exists). */
  getWindow: () => Gtk.Window
  /** Register the icon with the host's closed-state row. Called AFTER `aw` is
   *  fully built so the map-time birth intro can close over `aw` (the surface
   *  fires `onMap` on first map — both hosts play it).
   *  May be a no-op when the substrate already hosts the icon. */
  registerEntry: (aw: AppletWindow, onMap?: () => void) => void
  /** Attach the open panel overlay above this applet's slot (the shared
   *  surface puts it in its GtkFixed at the slot, in every host). The icon
   *  rides inside the overlay while open. */
  attachOverlay: (overlay: unknown) => void
  /** Detach the open panel overlay; the icon returns to the closed row. */
  detachOverlay: () => void
  /** Hidden-state change. The port owns its host's intro VISUALS — dock parks
   *  `render.intro=0` + cancels the appear; greeter flips `render.intro` and
   *  cell visibility. */
  setHidden: (hidden: boolean, render: RenderState) => void
  /** Drop input capture without touching the intro channel (dock only —
   *  greeter's per-cell routing has no separate suppression). */
  setInputEmpty?: () => void
  setPointerHandlers: (handlers: AppletPointerHandlers) => void
  addHoverListener: (handlers: AppletHoverHandlers) => void
  setPanelOh: (oh: number) => void
}

interface AppletBindingOptions {
  port: AppletBindingPort
  appear: AppearChannel
  /** The host's live config view (the appear timings + frame cadence). */
  config: AppletConfig
  /** `render.intro` seed: 0 when the appear animation will play the birth intro
   *  on first map (dock), 1 for a steady-state host (greeter — no appear
   *  flash). */
  initialIntro: number
}

/** Build the shared AppletWindow state machine over a substrate port. */
export function createAppletBinding(opts: AppletBindingOptions): AppletWindow {
  const { port, appear, initialIntro } = opts
  const icon = port.icon

  // The icon is purely visual in BOTH hosts — pointer events must reach the
  // host's routing (dock: shared-surface geometric router; greeter: cell
  // controllers), never be eaten by the icon itself.
  ;(icon as any).set_can_target?.(false)

  const render = createRenderState(initialIntro)

  let panelOpen = false
  let tearingDown = false
  let hiddenState = false

  const aw: AppletWindow = {
    window: port.getWindow(),
    icon,
    geometry: port.geometry,
    surface: null,
    name: port.name,
    render,

    attachIconTo(overlay: unknown) {
      panelOpen = true
      port.attachOverlay(overlay)
    },

    detachIcon() {
      port.detachOverlay()
      panelOpen = false
    },

    isOpen: () => panelOpen,

    playAppear: (reverse = false, ease?: (t: number) => number): Promise<void> =>
      new Promise<void>((resolve) => {
        appear.startAppear(icon, render, opts.config, { reverse, onDone: resolve, ease })
      }),

    setTearingDown: (v: boolean) => {
      tearingDown = v
    },
    isTearingDown: () => tearingDown,

    setHiddenState(hidden: boolean) {
      hiddenState = hidden
      port.setHidden(hidden, render)
    },
    setInputEmpty: () => {
      port.setInputEmpty?.()
    },
    isHiddenState: () => hiddenState,

    setPointerHandlers: (handlers) => port.setPointerHandlers(handlers),
    addHoverListener: (handlers) => port.addHoverListener(handlers),
    setPanelOh: (oh: number) => port.setPanelOh(oh),
  }

  port.registerEntry(aw)
  return aw
}
