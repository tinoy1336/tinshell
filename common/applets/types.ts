import type Gtk from "gi://Gtk?version=4.0"
import type { AppletWindow } from "@common/applets/applet-window"
import type { AppletBackend } from "@common/applets/backend"
import type { AppletConfig, AppletConfigSource } from "@common/applets/config"
import type { AppletHooks } from "./hooks"

// ── Applet contract ──

/** Host-supplied dependencies of one applet instance. `port` is the binding
 *  the host built for this applet (dock layer surface or greeter strip cell);
 *  `hooks` is that host's policy surface; `config` is that host's LIVE config
 *  view (the identity of `store.config` — reads go through it, writes/change
 *  notifications through `store`); `backend` is the host's OS-call set. */
export interface AppletContext {
  readonly port: AppletWindow
  readonly hooks: AppletHooks
  readonly config: AppletConfig
  readonly store: AppletConfigSource
  readonly backend: AppletBackend
}

/** An applet frontend. `common/applets/<Name>/index.ts` exports ONE mount
 *  function per applet; a host calls it with the port, the hooks, the config
 *  view and the backend it wants that applet to run on. Every piece of
 *  per-instance state lives in the closure mount creates, so the module itself
 *  stays stateless and a second host can mount the same applet independently. */
export type AppletMount = (ctx: AppletContext) => void

// ── Panel framework ──

/**
 * Draws an applet icon (translucent disc + glyph, and optionally a ring arc).
 * `value`: current value (0-100). Float during a continuous drag (rings/position
 *   glide on this); use it for ring arcs and anything that should track the
 *   cursor smoothly.
 * `state`: applet-specific boolean (muted for Volume, isKeyboard for Brightness).
 * `ringFill` (0..1): how much of the accent ring arc to draw.
 * `skipDisc`: if true, don't paint the disc background.
 * `textValue`: step-quantized value for text display (== `value` when the panel
 *   has no step). Use this for any % text so it updates in step increments while
 *   the slider glides on the float `value`.
 * Appear: the factory wrapper paints the WHOLE icon into a cairo group and
 *   fades the group via the applet's render state intro (paintWithAlpha) —
 *   per-glyph fades are handled there, never by the drawIcon itself.
 */
export type DrawIcon = (
  cr: any,
  w: number,
  h: number,
  value: number,
  state: boolean,
  ringFill?: number,
  skipDisc?: boolean,
  textValue?: number,
) => void

export interface PanelHandle {
  /** Snap the icon to a value instantly (click-to-set). */
  setHighlight: (idx: number) => void
  /** Called when the underlying value changes externally (e.g. another slider). */
  onExternalChange?: (value: number) => void
  /** Close animation. Invoke done() when finished. */
  animateOut?: (done: () => void) => void
  /** Open animation. Re-entering mid-close calls this to reverse-in-place. */
  animateIn?: () => void
  /** Called every frame during animation with current pillGrowth (0-1). */
  onGrowth?: (growth: number) => void
  /** Set the visible height of the panel widget (for window resize sync). */
  setHeight?: (h: number) => void
  /** Rotate the emoji of `stepIndex` continuously while active (a scan in
   *  flight); on stop the angle eases back to upright before the tick dies. */
  setSpin?: (stepIndex: number, active: boolean) => void
  /** Called when the open (growth) animation completes — lets a panel run a
   *  click/drag commit it deferred so it would not cancel the open anim. */
  onOpenSettled?: () => void
}

export interface Panel {
  widget: Gtk.Widget
  handle: PanelHandle
  /** Optional topmost overlay child (above the icon/disc), e.g. step emojis.
   *  The factory re-raises it after attachIconTo so it stacks above the disc
   *  (GtkOverlay draws later-added children on top, and the icon is added at
   *  attach time, after the foreground is created). null/absent if none. */
  foreground?: Gtk.DrawingArea | null
}

// ── System / Hardware ──

export type GpuColour = "red" | "yellow" | "green" | "none"

// ── TLP / Power ──

export type TlpProfile = "performance" | "balanced" | "power-saver" | "unknown"

export type PowerAction =
  | "sleep"
  | "hibernate"
  | "reboot"
  | "shutdown"
  | "logout"
  | "inhibit"
  | "lock"

// ── Drag / Gesture ──

export interface DialOpts {
  getStart: () => number
  min: number | (() => number)
  max: number | (() => number)
  pxPerUnit: number | (() => number)
  onSelect?: (value: number) => void
  /** Grow axis and direction of the dock (from DockGeometry).
   *  Defaults: growAxis="y", growDir=-1 (bottom dock). */
  growAxis?: "x" | "y"
  growDir?: 1 | -1
}

export interface Dial {
  begin: () => void
  update: (offsetX: number, offsetY: number) => void
  end: () => void
}
