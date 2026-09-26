/**
 * Panel framework — continuous slider + step selector panels.
 *
 * Both panel types share one core: a vertical pill (Gtk.DrawingArea) that grows
 * up out of the dock on open and collapses on close, with the applet icon riding
 * inside it. They differ only in:
 *   - value domain (continuous: 0..100; step: 0..N-1)
 *   - what's painted on the pill (continuous: accent fill below the icon;
 *     step: emoji labels at each step position)
 *
 * Geometry is anchored to the spec: the pill is IS() wide and PH()
 * tall; the icon's centre travels from centreYFor(min) (dock edge) to
 * centreYFor(max) (far end).
 *
 * Window sizing: the panel lives inside the dock's single shared surface,
 * whose grow-axis extent stays pillHeight — nothing is resized per animation
 * frame. render() re-issues the overlay/pill size requests only when they
 * change, and setHeight constrains the pill DrawingArea to the live pill
 * height so Cairo only draws the visible portion.
 */

import cairo from "gi://cairo"
import Gdk from "gi://Gdk"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { DOCK_CORNER_NAMESPACE } from "@apps/dock/identity"
import { easeQuadInOut } from "@common/anim/easings"
import { type FrameRunner, runFrames } from "@common/anim/run-frames"
import type { AppletConfig } from "@common/applets/config"
import type { DockGeometry } from "@common/applets/layout"
import { closeOpenPanel } from "@common/applets/panel-hub"
import type { RenderState } from "@common/applets/render-state"
import { backdropLiftColour, effectiveDiscAlpha } from "@common/applets/shared/draw-utils"
import type { Panel, PanelHandle } from "@common/applets/types"
import { easeCubicIn } from "@common/applets/utils/appear"
import { createDial } from "@common/applets/utils/drag"
import { geo } from "@common/applets/utils/geo-log"
import { ignore, logTo } from "@common/log/logger"
import { Astal, Gtk } from "ags/gtk4"

const DBG = !!GLib.getenv("DOCK_DEBUG")

// ── Drag keyboard-focus hold ──
// The dock window's keyboard focus follows the pointer (input:follow_mouse=1
// grants layer surfaces hover-focus on this build) and is revoked the moment
// the pointer leaves the window — even during a held drag — so an Escape
// pressed off-window never reaches the panel controller. While a drag is held
// we FREEZE follow_mouse (set to 0 via the Lua eval — the only runtime-config
// route here: `hyprctl keyword` is parser-locked and `hl.bind` doesn't
// persist), so the window keeps whatever focus it had at engage and the
// pointer leaving can't steal it. Restored at drag-end/cancel. The saved
// value is read once at the first arm (getoption) — the config on this
// machine never overrides follow_mouse, so the standard 1 is what's restored.
let savedFollowMouse = 1

/** Read the live `input:follow_mouse` option via hyprctl (null on failure). */
async function readFollowMouse(): Promise<number | null> {
  try {
    const proc = Gio.Subprocess.new(
      ["hyprctl", "getoption", "input:follow_mouse"],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    )
    const [, stdout] = await new Promise<any>((resolve) => {
      proc.communicate_async(null, null, (_p: any, res: any) => {
        try {
          resolve(proc.communicate_finish(res))
        } catch {
          resolve([false, null])
        }
      })
    })
    // SAFETY: gjs spawn stdout is a Uint8Array; its .buffer is the ArrayBuffer the
    // TextDecoder needs (TS can't express the gjs ABI).
    const text = stdout ? new TextDecoder().decode(stdout as unknown as ArrayBuffer) : ""
    const m = text.match(/int:\s*(\d+)/)
    if (m) return parseInt(m[1], 10)
  } catch (e) {
    ignore("panel int probe", e)
  }
  return null
}

function dragFocusArm(): void {
  if (DBG) print("[drag-focus] arm")
  // Capture the pre-drag value FIRST (the eval below would make getoption
  // report 0), then freeze.
  void (async () => {
    const v = await readFollowMouse()
    if (v !== null) savedFollowMouse = v
    if (DBG) print(`[drag-focus] follow_mouse -> 0 (saved=${savedFollowMouse})`)
    void GLib.spawn_command_line_async("hyprctl eval 'hl.config({ input = { follow_mouse = 0 } })'")
  })()
}

function dragFocusDisarm(): void {
  if (DBG) print(`[drag-focus] disarm (follow_mouse -> ${savedFollowMouse})`)
  void GLib.spawn_command_line_async(
    `hyprctl eval 'hl.config({ input = { follow_mouse = ${savedFollowMouse} } })'`,
  )
}

/** Startup safety: a drag that crashed while follow_mouse was frozen at 0
 *  would leave focus-follows-mouse off for the session. Restore the standard
 *  1 (the config on this machine never overrides follow_mouse). */
export function restoreFollowMouseAtStartup(): void {
  void (async () => {
    const v = await readFollowMouse()
    if (v === 0) {
      print("[drag-focus] startup: restoring follow_mouse from a frozen 0")
      void GLib.spawn_command_line_async(
        "hyprctl eval 'hl.config({ input = { follow_mouse = 1 } })'",
      )
    }
  })()
}

// ── Drag-bail: keyboard-Escape + corner-touch cancel (all applets) ──
// While a drag is held, two cancel paths revert it to the pre-drag
// value/step without committing (no onValue/onSelect fires) and close the
// panel via the hub (menu-pinned panels keep their pin):
//   1. Keyboard Escape — the applet window is keymode ON_DEMAND while its panel
//      is open, NONE at rest (the dock row drives the band's interactivity from
//      the open-panel count — see dock-row `applyKeyboardInteractivity`); a drag
//      is held on an OPEN panel, so the keys are there, its press is a click,
//      Hyprland grants the window keyboard focus on press, and the panel-level
//      EventControllerKey (attachPanelEscape) turns an Escape into
//      cancelActiveDrag() + closeOpenPanel().
//   2. Corner touch — an invisible layer surface at the TOP-LEFT screen
//      corner absorbs a touch press ("touch the corner to bail").
// A cancelled drag is STICKY for the rest of the button sequence: the engage
// gate requires !dragCancelled, and only a fresh drag-begin (new press)
// clears it — so the held button's continued motion can't re-engage the drag
// and the release commits nothing ("Escape, then let go" is a clean abort,
// not a snap to the cursor). While any drag is held, dragFocusArm freezes
// follow_mouse so the window keeps keyboard focus even when the pointer
// leaves the dock (see the drag-focus note above); dragFocusDisarm restores
// it at end/cancel.
function attachDragEscape(_win: any, onEscape: () => void): void {
  attachCornerCancel(onEscape)
  dragFocusArm()
}

function releaseDragEscape(_win: any): void {
  releaseCornerCancel()
  dragFocusDisarm()
}

// ── Corner-cancel surface (touch bail) ──
// While a drag is held, an invisible 160×160 layer surface at the TOP-LEFT
// screen corner absorbs a second finger's touch — the user's tablet-style
// "touch the corner to bail". Its input region is EMPTY at rest (fully
// click-through); the region is set only during a drag (attach/release
// alongside the Escape grab). A touch press there invokes the same onEscape
// as the keyboard Escape (revert the drag without committing). Pre-created
// and mapped from birth (invisible — nothing is painted) so mapping never
// happens at drag time (a map would re-evaluate the pointer over the dock
// windows and could kill the drag).
const CORNER_SIZE = 160
let cornerWin: Astal.Window | null = null
let cornerCancel: (() => void) | null = null
let cornerArmed = false

/** Create (once) the invisible corner surface on `monitor`. Pre-created at
 *  app startup (like the menu shell) so no surface maps mid-drag. */
export function cornerCancelInit(monitor: any): void {
  if (cornerWin || !monitor) return
  cornerWin = (
    <window
      namespace={DOCK_CORNER_NAMESPACE}
      class="dock-corner"
      gdkmonitor={monitor}
      exclusivity={Astal.Exclusivity.IGNORE}
      layer={Astal.Layer.OVERLAY}
      anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.LEFT}
      // NEVER take keys: without an explicit keymode the astal default grabs
      // keyboard focus when clicked — that froze all input the moment the
      // corner was touched (and left the dock icons dead).
      keymode={Astal.Keymode.NONE}
      visible={false}
      $={(self: any) => {
        self.set_default_size(CORNER_SIZE, CORNER_SIZE)
        self.connect("realize", () => {
          const surf = self.get_surface?.()
          if (!surf) return
          try {
            surf.set_opaque_region?.(null)
          } catch (e) {
            ignore("corner opaque region clear", e)
          }
          const down = new Gtk.GestureClick()
          down.connect("pressed", () => {
            cornerCancel?.()
            closeOpenPanel()
          })
          self.add_controller(down)
        })
        self.connect("map", () => {
          applyCornerRegion()
          ;(self as any).queue_draw?.()
        })
        // No self.show(): the corner maps on demand (setCornerRegion) while a
        // panel is open — an always-mapped layer surface gets reconfigured by
        // the compositor every frame (the 60fps ack/commit loop).
      }}
    />
  ) as any
}

function applyCornerRegion(): void {
  const surf = cornerWin?.get_surface?.()
  if (!surf) return
  const w = cornerWin?.get_width?.() ?? 0
  const h = cornerWin?.get_height?.() ?? 0
  const r: any = new (cairo as any).Region()
  if (cornerArmed && w > 0 && h > 0) r.unionRectangle({ x: 0, y: 0, width: w, height: h })
  surf.set_input_region(r)
}

function setCornerRegion(active: boolean): void {
  cornerArmed = active
  if (!cornerWin) return // Map only while a panel is open (the touch-bail region) — an always-mapped
  // layer surface is reconfigured by the compositor every frame (60fps loop).
  cornerWin.visible = active
  applyCornerRegion()
  cornerWin.queue_draw()
}

function attachCornerCancel(onCancel: () => void): void {
  // Callback ONLY — the input-region activation lives at the panel OPEN (see
  // attachPanelEscape). Setting the corner region here (mid-drag) perturbs
  // the surfaces during the gesture — the compositor re-evaluates and the
  // drag gets cancelled before release (step selections stopped applying).
  cornerCancel = onCancel
}

function releaseCornerCancel(): void {
  cornerCancel = null
}

/** Cancel whatever drag is currently held (the corner touch and the panel
 *  Escape controller both call this — no-op when no drag is active). */
function cancelActiveDrag(): void {
  cornerCancel?.()
}

// ── Panel-level Escape (keyboard bail) ──
// A controller on the applet window turns an Escape into cancelActiveDrag() +
// closeOpenPanel(). The applet window is keymode ON_DEMAND while a panel is
// open and NONE otherwise (the dock row drives the band's interactivity from
// the open-panel count — a standing ON_DEMAND takes the seat's keys on every
// map and pointer motion over a band that is otherwise pointer-only); the drag
// press is a click, so Hyprland grants the window keyboard focus on press and
// this controller fires. This is the WORKING Escape path — no capture surface
// is used.
let panelEscapeCtrl: Gtk.EventControllerKey | null = null
let panelEscapeWin: any = null

export function attachPanelEscape(win: any): void {
  releasePanelEscape()
  if (!win) return
  panelEscapeWin = win
  panelEscapeCtrl = new Gtk.EventControllerKey()
  panelEscapeCtrl.connect("key-pressed", (_c: any, keyval: number) => {
    if (keyval === Gdk.KEY_Escape) {
      if (DBG) print("[panel-esc] Escape received — applet window HAS keyboard focus")
      cancelActiveDrag()
      closeOpenPanel()
      return true
    }
    return false
  })
  win.add_controller(panelEscapeCtrl)
  // The corner bail region activates at the panel OPEN (a normal surface
  // change — no drag yet, safe) and stays active until the close — never a
  // mid-drag region change.
  if (!cornerWin) cornerCancelInit((win as any)?.gdkmonitor)
  setCornerRegion(true)
}

export function releasePanelEscape(): void {
  if (panelEscapeCtrl && panelEscapeWin) {
    try {
      panelEscapeWin.remove_controller(panelEscapeCtrl)
    } catch (e) {
      ignore("panel escape controller release", e)
    }
  }
  panelEscapeCtrl = null
  panelEscapeWin = null
  setCornerRegion(false)
}

// Last icon-trace timestamp (µs) for inter-frame dt in the DBG trace.
let lastTraceTs = 0

// ── Shared geometry (derived once) ──

const IS = (config: AppletConfig) => config.layout.iconSize
const PH = (config: AppletConfig) => config.layout.pillHeight

/** Total vertical travel of the icon centre (same regardless of direction). */
const centreRange = (config: AppletConfig) => PH(config) - IS(config) // 104

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// ──────────────────────────────────────────────────────────────────────────
// PillModel — abstracts the value domain (continuous vs step)
// ──────────────────────────────────────────────────────────────────────────

interface PillModel {
  readonly min: number
  readonly max: number
  /** Icon centre Y in pill space for a value. */
  centreYFor(value: number): number
  /** Icon top-left Y (rounded) for a value. */
  iconTopFor(value: number): number
  /** Inverse: a Y position → value (for drag decoding). */
  valueFromY(y: number): number
  /** Clamp to [min,max]. */
  clampValue(value: number): number
  /** Snap to a valid value (round for step; step-multiple for continuous). */
  snap(value: number): number
  /** Bounds for centre Y (used by drag gestures). minY may be > maxY. */
  minY: number
  maxY: number
}

function makeModel(
  config: AppletConfig,
  min: number,
  max: number,
  dg: DockGeometry,
  snapFn?: (v: number) => number,
): PillModel {
  const span = max - min
  // Icon centre Y at value=min and value=max. For growDir=-1 (bottom): min at
  // the dock edge (bottom, large Y), max at the far end (top, small Y). For
  // growDir=+1 (top): reversed.
  const centreAtMin = dg.growDir < 0 ? PH(config) - IS(config) / 2 : IS(config) / 2
  const centreAtMax = dg.growDir < 0 ? IS(config) / 2 : PH(config) - IS(config) / 2
  const cyRange = centreAtMax - centreAtMin // signed: negative for growDir=-1
  const centreYFor = (value: number) =>
    centreAtMin + ((clamp(value, min, max) - min) / span) * cyRange
  return {
    min,
    max,
    centreYFor,
    iconTopFor: (value) => Math.round(centreYFor(value) - IS(config) / 2),
    valueFromY: (y) => {
      const lo = Math.min(centreAtMin, centreAtMax)
      const hi = Math.max(centreAtMin, centreAtMax)
      const clamped = clamp(y, lo, hi)
      return min + ((clamped - centreAtMin) / cyRange) * span
    },
    clampValue: (v) => clamp(v, min, max),
    snap: snapFn ?? ((v) => v),
    minY: Math.min(centreAtMin, centreAtMax),
    maxY: Math.max(centreAtMin, centreAtMax),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Animation driver — tick_callback preferred (vsynced), timeout fallback
// ──────────────────────────────────────────────────────────────────────────

type FrameCb = (nowUs: number) => boolean // return false to stop

// ──────────────────────────────────────────────────────────────────────────
// Stadium input region — the pill+icon silhouette, for click-through corners.
//
// The pill is IS() wide. The input region approximates the stadium: rounded
// caps built from per-scanline chord rectangles (circle equation) + a
// full-width middle rect, so pixels outside the rounded silhouette — the four
// corners between the semicircular caps and the sharp window rect — pass
// clicks/hovers through to whatever's behind.
// The caps must NOT be full-width squares: their union with the middle rect
// equals the whole bounding rectangle — the
// empty corners of every expanded applet window would capture hover/click input.
// On close, detachIcon() removes the overlay and the surface re-issues the
// closed-state DISC region, not null.
//
// NOTE on the cairo API: the factory functions `region_create_polygon` /
// `region_create_rectangle` and the methods `copy()` / `translate()` do NOT
// exist in gjs (confirmed by live probe on gjs 1.88.1). The working APIs are
// `new cairo.Region()` (empty) + `region.unionRectangle(rect)`. So we rebuild
// the region from rectangles each frame — cheap integer math, no caching needed.
// ──────────────────────────────────────────────────────────────────────────
// Stadium input region lives in @common/applets/utils/row-region.ts: the
// shared surface's union region engine owns it; render() reports the grown
// extent (oh) via PillConfig.setPanelOh instead of writing the surface region
// directly.
// ──────────────────────────────────────────────────────────────────────────
// Pill factory — the shared core
// ──────────────────────────────────────────────────────────────────────────

interface PillConfig {
  /** The host's live config view (geometry, timing, appearance). */
  config: AppletConfig
  model: PillModel
  /** What to paint on the pill each frame (the value-domain-specific part). */
  paint: (cr: any, w: number, h: number, ctx: PaintCtx) => void
  /** Initial display value (icon starts here during open). */
  initialDisplay: number
  /** Initial target value. */
  initialTarget: number
  /** The applet's real icon, reparented into the overlay on open. Its draw_func
   *  is set by the applet factory, which reads the render state render()
   *  publishes below. */
  externalIcon: Gtk.DrawingArea
  /** The applet's render state — render() publishes the live value, ring fill,
   *  disc skip and step-quantized text here for the icon's draw trampoline. */
  render: RenderState
  setDragActive?: (active: boolean) => void
  /** How ringFill tracks animation progress:
   *   "travel" (continuous) — ringFill retracts as the icon rises from the dock.
   *   "growth" (step) — ringFill = 1 - pillGrowth, so glyph fades in lockstep
   *   with the pill expanding/shrinking. */
  ringFillMode?: "travel" | "growth"
  /** On-the-fly judgment (computed by stepPanel): true while the current step
   *  is index 0 AND the applet's dock glyph is identical to the step-0 emoji
   *  (same codepoint + colour). Keeps ringFill at 1 so the closed-state glyph
   *  does NOT fade out during the open cross-fade — the identical step-0 emoji
   *  is skipped in the foreground (paintStepEmojis), so the icon just stays
   *  put instead of blinking. */
  sameAsStep0?: () => boolean
  /** Maps the float `display` to a step-quantized value for the icon's text
   *  (continuous panels with a step). When set, render() publishes it as
   *  `render.textValue` so the icon's drawIcon can render % text in step
   *  increments while the slider glides on the float. Defaults to the float
   *  itself. */
  textValueFor?: (display: number) => number
  /** Report the grown pill extent (oh) to the shared surface's region engine
   *  (the stadium tracks the animation per frame). */
  setPanelOh?: (oh: number) => void
  /** Optional foreground painter, drawn on a topmost overlay layer ABOVE the
   *  icon (so above the disc). Used by step panels to render their emojis in
   *  front of the translucent disc instead of behind it. Receives the same
   *  PaintGeo context as the pill paint (window-space coords). */
  paintForeground?: (cr: any, w: number, h: number, geo: PaintGeo) => void
  /** Dock geometry — drives pill growth direction, icon travel, ringFill math. */
  dockGeometry: DockGeometry
}

interface PaintCtx {
  /** Current pill growth 0..1. */
  pillGrowth: number
  /** Current eased value (icon position). */
  display: number
}

interface PillCore {
  pill: Gtk.DrawingArea
  widget: Gtk.Widget
  icon: Gtk.DrawingArea
  /** Topmost overlay layer (above the icon/disc) for foreground painting
   *  (step emojis). null when no paintForeground was supplied. */
  foreground: Gtk.DrawingArea | null
  /** Shared mutable state — animation code reads/writes these. */
  state: {
    display: number
    target: number
    pillGrowth: number
    ringFill: number
    /** Icon's current top-Y relative to the grown pill's top, written by render()
     *  each frame. drawPill converts this to the disc's window-space centre
     *  (`topY + iconTopY + semiR`) and passes it to paintContinuous/paintStep so
     *  their concave disc-facing edges hug the disc exactly throughout the
     *  ride-the-leading-edge open/close motion — they must never be computed by
     *  separate formulas (icon position is window space; the disc edges must
     *  match the icon widget's actual painted position). */
    iconTopY: number
    /** Window height this frame, written by render(). */
    oh: number
    /** Current animation phase (for debug logging): "open" / "close" / "ext" / "snap" / "settle" / "" */
    phase: string
    animId: FrameRunner | null
    destroyed: boolean
  }
  render: () => void
  scheduleFrame: (cb: FrameCb, label: string) => FrameRunner
  clearAnim: () => void
}

function createPill(opts: PillConfig): PillCore {
  const config = opts.config
  const model = opts.model
  const ringFillMode = opts.ringFillMode ?? "travel"
  const dg = opts.dockGeometry
  // Icon's top Y in 140-space when the panel is closed (icon flush at dock edge).
  const dockIconTop = dg.growDir < 0 ? PH(config) - IS(config) : 0
  const state = {
    display: opts.initialDisplay,
    target: opts.initialTarget,
    pillGrowth: 0,
    ringFill: 1,
    iconTopY: 0,
    oh: IS(config),
    phase: "",
    animId: null as FrameRunner | null,
    destroyed: false,
  }

  // ── Pill DrawingArea — grow-axis align pins to dock edge: END for
  //  growDir=-1 (bottom/right), START for growDir=+1 (top/left).
  //  Cross-axis is always CENTER.
  const growAlign = dg.growDir < 0 ? Gtk.Align.END : Gtk.Align.START
  const crossAlign = Gtk.Align.CENTER
  const pillValign = dg.growAxis === "y" ? growAlign : crossAlign
  const pillHalign = dg.growAxis === "y" ? crossAlign : growAlign
  const pillW = dg.growAxis === "y" ? IS(config) : PH(config)
  const pillH = dg.growAxis === "y" ? PH(config) : IS(config)
  const pill = (
    <drawingarea
      class="dock-overlay-pill"
      valign={pillValign}
      halign={pillHalign}
      $={(self: Gtk.DrawingArea) => {
        self.set_draw_func((_, cr, w, h) => {
          drawPill(config, cr, w, h, opts, state, model)
        })
      }}
    />
    // SAFETY: the pill JSX element is a Gtk.DrawingArea; TINSHELL JSX types elements as
    // GtkWidget, the cast recovers the concrete type for the overlay child.
  ) as unknown as Gtk.DrawingArea

  // ── Overlay host — explicit size on both axes so GTK allocates immediately
  //  when the overlay becomes the window child (no 1-frame 0×0 layout stall).
  const widget = (
    <overlay class="dock-overlay-pill-overlay" widthRequest={pillW} heightRequest={pillH}>
      {pill}
    </overlay>
  ) as any

  // ── Icon: the applet's real icon, reparented into the overlay on open. The
  //  icon's own draw_func is set by the applet factory (create-continuous/
  //  step-applet), which reads the render state published by render(). ──
  const icon = opts.externalIcon

  // ── Foreground layer (topmost, above the icon/disc) — step emojis etc. ──
  // Built only when paintForeground is supplied. Same geometry as the pill
  // (fills the overlay, valign=END) so its coordinate space == window space and
  // model.centreYFor lands content at the same Y as the pill paint. Registered
  // AFTER the icon so Gtk.Overlay stacks it on top of the disc.
  let foreground: Gtk.DrawingArea | null = null
  if (opts.paintForeground) {
    foreground = (
      <drawingarea
        valign={pillValign}
        halign={pillHalign}
        $={(self: Gtk.DrawingArea) => {
          // Click-through: the foreground must not intercept the drag/click
          // gestures (which live on the overlay parent). can-target=FALSE makes
          // it render but pass all pointer events through to the widgets behind.
          ;(self as any).set_can_target?.(false)
          self.set_draw_func((_, cr, w, h) => {
            const oh = Math.round(IS(config) + state.pillGrowth * (PH(config) - IS(config)))
            const rotated = dg.rotation !== 0
            // Foreground is always sized to the full pill dimensions (no
            // setHeight constraint). Rotated positions need no rotation —
            // paintStepEmojis detects horizontal vs vertical orientation.
            const pw = rotated ? PH(config) : w
            const ph = rotated ? IS(config) : h
            const topY = dg.growDir < 0 ? h - oh : 0
            cr.save()
            // Clip to the grown pill region during animation so step
            // emojis outside the pill are hidden until the pill reaches them.
            if (rotated) {
              if (oh < w) {
                const startX = dg.growDir < 0 ? w - oh : 0
                cr.rectangle(startX, 0, oh, h)
                cr.clip()
              }
            } else if (oh < h) {
              cr.rectangle(0, topY, w, oh)
              cr.clip()
            }
            opts.paintForeground!(cr, pw, ph, {
              topY,
              semiR: IS(config) / 2,
              iconCentreY: 0,
              oh,
              pillGrowth: state.pillGrowth,
            } as PaintGeo)
            cr.restore()
          })
        }}
      />
      // SAFETY: same TINSHELL JSX element → Gtk.DrawingArea contract as the pill.
    ) as unknown as Gtk.DrawingArea
    const fgW = dg.growAxis === "y" ? IS(config) : PH(config)
    const fgH = dg.growAxis === "y" ? PH(config) : IS(config)
    ;(foreground as any).set_size_request(fgW, fgH)
    // NOTE: not added to the overlay here. The icon is added to this same
    // overlay later (at attach time, after this panel is built), and GtkOverlay
    // draws later-added children ON TOP — so if we added the foreground now,
    // the icon (disc) would cover it. The factory adds the foreground AFTER
    // attachIconTo so it stacks above the disc. See Panel.foreground.
  }

  // ── render(): per-frame geometry + window-size sync ──
  // Cache of the last-applied window/region geometry — render() only re-issues
  // size/region calls when they change (see the comment in render()).
  let lastReqW = -1
  let lastReqH = -1
  let lastRegionOh = -1

  function render(): void {
    const disp = model.clampValue(state.display)
    const oh = Math.round(IS(config) + state.pillGrowth * (PH(config) - IS(config)))
    const targetIy = model.iconTopFor(disp) // icon's value-target top (140-space)
    const wh = PH(config)

    // Pill start in window space and leading edge (the edge that moves as the
    // pill grows). For growDir=-1 (bottom/right) the pill is anchored at the
    // window end with the leading edge at pillStart. For growDir=+1 (top/left)
    // the pill is at window origin with the leading edge at pillStart + oh.
    const pillStart = dg.growDir < 0 ? wh - oh : 0
    const lead = dg.growDir < 0 ? pillStart : pillStart + oh - IS(config)

    // Icon rides the leading edge until it reaches its value-target, then
    // holds. Constraint direction flips with growDir: bottom/right → icon can't
    // go past the pill's leading edge (below/left of it → max); top/left → icon
    // can't go past the pill's leading edge (above/right of it → min).
    const iy140 = dg.growDir < 0 ? Math.max(targetIy, lead) : Math.min(targetIy, lead)
    const iy = Math.round(dg.growDir < 0 ? iy140 - lead : iy140)
    state.iconTopY = iy
    state.oh = oh

    if (ringFillMode === "growth") {
      state.ringFill =
        opts.sameAsStep0?.() && Math.round(state.display) === 0 ? 1 : 1 - state.pillGrowth
    } else {
      // ringFill: retracts 1→0 as the icon rides from dock to its target.
      // Generic formula: progress = how far the pill has grown past the icon
      // (oh-IS) divided by how far the icon travels |dock-target|.
      const travel = Math.abs(dockIconTop - targetIy)
      const risen = travel > 0.001 ? clamp((oh - IS(config)) / travel, 0, 1) : 0
      state.ringFill = Math.max(0, 1 - risen)
    }

    // Push icon position + animation state into the applet's render state.
    const rs = opts.render
    rs.value = disp
    rs.ringFill = state.ringFill
    if (ringFillMode === "travel") rs.skipDisc = true
    rs.textValue = opts.textValueFor ? opts.textValueFor(disp) : disp

    // Icon is valign/halign=START on the grow axis — position it from the
    // window/pill origin via margin_top (growAxis=y) or margin_start (growAxis=x).
    const iconMargin = pillStart + iy
    const ica = icon as any
    if (dg.growAxis === "y") ica.set_margin_top(iconMargin)
    else ica.set_margin_start(iconMargin)
    ica.queue_draw()

    pill.queue_draw()
    foreground?.queue_draw()

    // Window size: the shared surface's grow-axis extent is pillHeight —
    // CONSTANT (the pill grows inside the band; open/close never resizes the
    // surface). Resizing the shared surface here would clobber the row band
    // sizing.
    // (The widget/pill size requests below stay: they constrain the overlay
    // internals, which are surface-independent.)
    const [reqW, reqH] = dg.growAxis === "y" ? [IS(config), wh] : [wh, IS(config)]
    if (reqW !== lastReqW || reqH !== lastReqH) {
      lastReqW = reqW
      lastReqH = reqH
      ;(widget as any).set_size_request(reqW, reqH)
      ;(pill as any).set_size_request(reqW, reqH)
    }
    // The stadium input region is NOT size-driven: it must track the pill's
    // grown extent (oh), which changes during the open/close animation. The
    // shared surface rebuilds the union region from the report below — gated
    // on its own caching so it fires once per growth frame and then
    // stabilizes.
    try {
      // Freeze the stadium report during the CLOSE animation: per-frame
      // region re-issues make the compositor re-evaluate the pointer under
      // the finger — a synthetic LEAVE at the touch point that swallows the
      // next tap (the documented "swallowing the next click" race). The
      // region stays at its last open-frame extent until doClose's finish()
      // detaches the panel (restoring the DISC region), so no churn while
      // the panel animates out. The surface decouples this: the PAINT reads
      // the live oh (setPanelOh fires every frame, so the expanded-applet
      // backdrop eases down with the pill), while the INPUT REGION latches
      // regionOh (never shrinks mid-close) so no shrinking region is
      // re-issued under the pointer. So we always report the live oh — no
      // close-phase gate.
      if (oh !== lastRegionOh) {
        lastRegionOh = oh
        opts.setPanelOh?.(oh)
        if (DBG) print(`[win:region] STADIUM oh=${oh} phase=${state.phase}`)
        geo("input-region", {
          type: "stadium",
          pos: dg?.position ?? "?",
          oh,
          wh,
          phase: state.phase,
        })
      }
    } catch (e) {
      ignore("panel input region apply", e)
    }
    ;(widget as any).queue_resize?.()
    ;(pill as any).queue_resize?.()

    if (DBG) {
      const win: any = (widget as any).get_root?.()
      const pAlloc = (pill as any).get_allocation()
      const wAlloc = (widget as any).get_allocation()
      const rAlloc = win?.get_allocation?.()
      const iAlloc = ica.get_allocation?.()
      const iMargin = dg.growAxis === "y" ? ica.get_margin_top() : ica.get_margin_start()
      const ts = GLib.get_monotonic_time()
      const animLine = [
        `[anim] t=${ts}`,
        `phase=${state.phase}`,
        `g=${state.pillGrowth.toFixed(3)}`,
        `oh=${oh}`,
        `pillStart=${pillStart}`,
        `lead=${lead}`,
        `targetIy=${targetIy}`,
        `iy=${iy}`,
        `iconMargin=${iconMargin}`,
        `iLiveMargin=${iMargin}`,
        `iAlloc=${iAlloc?.width}x${iAlloc?.height}`,
        `pillAlloc=${pAlloc.width}x${pAlloc.height}`,
        `wAlloc=${wAlloc.width}x${wAlloc.height}`,
        `win=${rAlloc?.width}x${rAlloc?.height}`,
        `defSize=${win?.default_width}x${win?.default_height}`,
        `rf=${state.ringFill.toFixed(2)}`,
      ].join(" ")
      print(animLine)
      logTo("/tmp/tinshell-anim.log", animLine)

      // Per-frame icon-position trace for debugging close drift. Includes the
      // live cursor position relative to the surface so icon geometry can be
      // correlated with pointer position on every animation frame (motion
      // events only fire on movement; this captures the still-cursor case too).
      // NOTE: gdk_surface_get_device_position() is unreliable on Wayland layer
      // surfaces (returns false outside an in-flight pointer event), so we read
      // the last event-reported coords instead.
      const iconH = iAlloc?.height ?? IS(config)
      const iconTop = iMargin
      const iconBot = iconTop + iconH
      const winH = wAlloc?.height ?? -1
      const clipped = iconTop < 0 || iconBot > winH
      const cur = opts.render.cursor
      const cx = cur ? Math.round(cur.x) : -1
      const cy = cur ? Math.round(cur.y) : -1
      const over = cur ? cur.over : -1
      const dt = lastTraceTs ? Math.round((ts - lastTraceTs) / 1000) : -1
      lastTraceTs = ts
      print(
        [
          "[icon-trace]",
          `ts=${ts}`,
          `dt=${dt}`,
          `phase=${state.phase}`,
          `g=${state.pillGrowth.toFixed(4)}`,
          `val=${disp.toFixed(2)}`,
          `tgt=${state.target}`,
          `oh=${oh}`,
          `iy=${iy}`,
          `mt=${iMargin}`,
          `iconH=${iconH}`,
          `iconTop=${iconTop}`,
          `iconBot=${iconBot}`,
          `winH=${winH}`,
          `tgtIy=${targetIy}`,
          `leadIy=${lead}`,
          `CLIP=${clipped}`,
          `cx=${cx}`,
          `cy=${cy}`,
          `over=${over}`,
        ].join(" "),
      )
    }
  }

  function scheduleFrameLocal(cb: FrameCb, _label: string): FrameRunner {
    return runFrames(pill, cb, config.timing.framerate)
  }
  function clearAnimLocal(): void {
    state.animId?.cancel()
    state.animId = null
  }
  // Construction: pin the pill to its full size so the first allocation is sane.
  ;(pill as any).set_size_request(pillW, pillH)
  ;(widget as any).connect("destroy", () => {
    state.destroyed = true
    clearAnimLocal()
  })

  return {
    pill,
    widget,
    icon,
    foreground,
    state,
    render,
    scheduleFrame: scheduleFrameLocal,
    clearAnim: clearAnimLocal,
  }
}

/** The panel's toplevel window (the root of the overlay tree). */
function panelRoot(core: PillCore): any {
  return (core.widget as any).get_root?.() ?? null
}

// ── Shared open/close/external animators ──
// continuousPanel and stepPanel animate the SAME pill core; they differ only
// in the phase label, the continuous ringFill resets, and the step panel's
// "snap" phase guard (a pending click-to-step must finish — its onSelect
// fires from the snap completion).

function animatePillIn(
  config: AppletConfig,
  core: PillCore,
  handle: PanelHandle,
  label: "pill" | "step",
  resetRingFill: boolean,
): void {
  const { state, render, scheduleFrame, clearAnim } = core
  clearAnim()
  state.phase = "open"
  const fromGrowth = state.pillGrowth
  const tag = label === "step" ? "STEP " : ""
  if (DBG) print(`[icon-trace] === ${tag}OPEN START fromGrowth=${fromGrowth.toFixed(3)} ===`)
  if (fromGrowth >= 1) {
    state.pillGrowth = 1
    state.phase = ""
    render()
    handle.onOpenSettled?.()
    return
  }
  state.display = state.target
  const startUs = GLib.get_monotonic_time()
  const durationUs = config.timing.pillAnim * (1 - fromGrowth) * 1000
  state.animId = scheduleFrame((nowUs) => {
    if (state.destroyed) {
      state.animId = null
      state.phase = ""
      return false
    }
    const t = Math.min(1, durationUs > 0 ? (nowUs - startUs) / durationUs : 1)
    state.pillGrowth = fromGrowth + t * (1 - fromGrowth)
    render()
    handle.onGrowth?.(state.pillGrowth)
    if (t >= 1) {
      state.pillGrowth = 1
      if (resetRingFill) state.ringFill = 0
      state.animId = null
      state.phase = ""
      if (DBG) print(`[icon-trace] === ${tag}OPEN END ===`)
      handle.onOpenSettled?.()
      return false
    }
    return true
  }, `${label}:open`)
}

function animatePillOut(
  config: AppletConfig,
  core: PillCore,
  handle: PanelHandle,
  done: () => void,
  label: "pill" | "step",
  resetRingFill: boolean,
): void {
  const { state, render, scheduleFrame, clearAnim } = core
  clearAnim()
  state.phase = "close"
  const fromGrowth = state.pillGrowth
  const tag = label === "step" ? "STEP " : ""
  if (DBG) print(`[icon-trace] === ${tag}CLOSE START fromGrowth=${fromGrowth.toFixed(3)} ===`)
  const startUs = GLib.get_monotonic_time()
  state.animId = scheduleFrame((nowUs) => {
    if (state.destroyed) {
      state.animId = null
      state.phase = ""
      done()
      return false
    }
    const t = Math.min(1, (nowUs - startUs) / (config.timing.pillAnim * 1000))
    state.pillGrowth = fromGrowth * (1 - easeCubicIn(t))
    render()
    handle.onGrowth?.(state.pillGrowth)
    if (t >= 1) {
      state.pillGrowth = 0
      state.display = 0
      if (resetRingFill) state.ringFill = 0
      state.animId = null
      state.phase = ""
      if (DBG) print(`[icon-trace] === ${tag}CLOSE END (calling done) ===`)
      done()
      return false
    }
    return true
  }, `${label}:close`)
}

function animatePillExternal(
  config: AppletConfig,
  core: PillCore,
  opts: {
    snap: (v: number) => number
    guardSnap: boolean
    resetRingFill: boolean
    label: "pill" | "step"
  },
): (v: number) => void {
  const { state, render, scheduleFrame, clearAnim } = core
  return (v) => {
    // Apply the external value immediately (target snaps), then animate the
    // icon toward it over a short duration. The cursor is ignored during this
    // transition — an external change (volume key, brightness key) always wins.
    const newTarget = opts.snap(v)
    if (newTarget === state.target) return
    // Step: a pending click-to-step (phase "snap") MUST finish — its onSelect
    // fires from the snap's completion. Cancelling swallows the click (a
    // wifi/bt poll landing inside the 150ms snap window would eat it).
    if (opts.guardSnap && state.phase === "snap") return
    // Never interrupt a close in progress: its completion calls animateOut's
    // done() → detach; killing it leaves the panel stuck mid-close.
    if (state.phase === "close") return
    state.target = newTarget
    if (state.pillGrowth <= 0) {
      // Panel closed: nothing to animate visibly; the applet's own smoother
      // (continuous) handles the dock-icon update.
      state.display = state.target
      return
    }
    clearAnim()
    state.phase = "ext"
    const from = state.display
    const startUs = GLib.get_monotonic_time()
    state.animId = scheduleFrame((nowUs) => {
      if (state.destroyed) {
        state.animId = null
        state.phase = ""
        return false
      }
      const t = Math.min(1, (nowUs - startUs) / (config.timing.externalChange * 1000))
      state.display = from + (state.target - from) * easeQuadInOut(t)
      if (opts.resetRingFill) {
        state.ringFill = 0
        core.icon.queue_draw()
      }
      render()
      if (t >= 1) {
        state.display = state.target
        state.animId = null
        state.phase = ""
        return false
      }
      return true
    }, `${opts.label}:ext`)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Pill painting — the value-domain-specific draw, factored by panel type
// ──────────────────────────────────────────────────────────────────────────

/**
 * Draw the pill shape clipped to its grown region, then delegate the value-
 * domain content (disc-split fill for continuous; emoji labels for step) to
 * the `paint` callback. The pill is NOT painted under the disc — both regions'
 * disc-facing edges are concave arcs hugging the disc, so there's no alpha
 * compositing under the disc (see paintContinuous / paintStep).
 */
function drawPill(
  config: AppletConfig,
  cr: any,
  w: number,
  h: number,
  opts: PillConfig,
  state: PillCore["state"],
  model: PillModel,
): void {
  const growth = state.pillGrowth
  const disp = model.clampValue(state.display)
  const oh = Math.round(IS(config) + growth * (PH(config) - IS(config)))
  const dg = opts.dockGeometry

  const semiR = IS(config) / 2
  // Coordinate space: for top/bottom (rotation=0) the widget is constrained
  // to IS()×oh by setHeight, so we use w/h (widget allocation). For left/right
  // (rotation≠0) the drawing space is IS()×PH() and the rotation remaps it to
  // fill the transposed widget. This split avoids the top/bottom clip bug
  // (clipping to the full widget height would hide the grown pill region)
  // while keeping rotation correct for horizontal docks.
  const rotated = dg.rotation !== 0
  const pw = rotated ? IS(config) : w
  const ph = rotated ? PH(config) : h
  let topY = dg.growDir < 0 ? ph - oh : 0
  let iconCentreY = topY + state.iconTopY + IS(config) / 2

  cr.save()

  if (rotated) {
    // Cartesian remap: (x',y') → (y' - xOff, IS()-x'). For growDir=+1
    // (left) xOff=0 so y'=0→local x=0. For growDir=-1 (right) xOff=ph-oh
    // shifts the pill so y'=ph-oh→local x=0, keeping the drawing within
    // the oh×IS() widget at all animation stages.
    const xOff = dg.growDir < 0 ? ph - oh : 0
    cr.translate(-xOff, IS(config))
    cr.rotate(-Math.PI / 2)
  }

  // For growDir=+1 (top/left) the dock edge is at Y=0 in paint space,
  // but paintContinuous/paintStep expect it at the bottom (large Y).
  // Flip Y so the fill always grows from the "bottom" (visual dock
  // edge) toward the "top" (visual far end): y → ph - y.
  if (dg.growDir > 0) {
    cr.translate(0, ph)
    cr.scale(1, -1)
    topY = ph - (topY + oh)
    iconCentreY = ph - iconCentreY
  }

  if (oh < ph) {
    cr.rectangle(0, topY, pw, oh)
    cr.clip()
  }

  opts.paint(cr, pw, ph, {
    pillGrowth: growth,
    display: disp,
    topY,
    semiR,
    iconCentreY,
    oh,
  } as PaintCtx & PaintGeo)

  cr.restore()
}

interface PaintGeo {
  /** Top Y of the grown pill region (window space). */
  topY: number
  /** Pill corner radius = disc radius (half width). */
  semiR: number
  /** Disc centre Y in window/paint space — the concave edges hug the disc here. */
  iconCentreY: number
  /** Pill height this frame (oh). */
  oh: number
  /** Pill growth 0..1 (the pillAnim-driven progress). The foreground painter
   *  layers a fade on top of the clip reveal: step emojis fade in/out with
   *  the pill expansion, over the same timing.pillAnim duration. */
  pillGrowth: number
}

/**
 * Paint the continuous pill split at the disc — nothing is painted under the
 * disc to avoid alpha compositing:
 *
 *   TOP region (unfilled track, `trackColour(config)` — the shared element both
 *     families paint): from the pill's top cap
 *     down to the disc's top edge (concave ∩ cupping the disc from above).
 *   BOTTOM shape ([...config.appearance.disc.rgb, config.appearance.disc.alpha] as number[] ~0.70): the disc background + the fill stem, drawn
 *     as ONE connected Cairo path so they rasterize as a single fill with no
 *     seam. The outline is the disc's TOP semicircle (the dome) + straight stem
 *     walls down to the pill's bottom cap. The disc's BOTTOM semicircle is
 *     interior (the stem is full pill-width, so it fully contains the disc's
 *     lower half), so it's not on the outline.
 *
 * The icon widget skips its own disc background while the panel is open
 * (render.skipDisc) so the disc is painted exactly once — here, by this shape.
 * The icon still paints rings + glyph on top (foreground). The bottom shape +
 * the disc read as one solid "filled pill" growing from the dock up to the
 * icon (value 0% = just the disc / stem collapses; value 100% = filled to top).
 *
 * The disc-facing geometry is centred at `geo.iconCentreY` (the disc's
 * per-frame window-space centre, tracked from render()'s iconTopY) so it hugs
 * the disc exactly throughout the ride-the-leading-edge open/close motion.
 */
function paintContinuous(
  config: AppletConfig,
  cr: any,
  w: number,
  _h: number,
  geo: PaintGeo,
  _model: PillModel,
  _display: number,
): void {
  const { topY, semiR, iconCentreY, oh } = geo
  const cx = w / 2
  const capCentreYBottom = topY + oh - semiR
  const discTop = iconCentreY - semiR

  cr.save()

  // ── TOP region: unfilled track from the top cap down to the disc's top edge ──
  if (discTop > topY + 0.5) {
    cr.newPath()
    cr.moveTo(cx - semiR, topY + semiR) // top-left corner
    cr.arc(cx, topY + semiR, semiR, Math.PI, 2 * Math.PI) // top cap (∪ curving up)
    cr.lineTo(cx + semiR, iconCentreY) // down right wall to disc's right point
    cr.arcNegative(cx, iconCentreY, semiR, 0, Math.PI) // disc top semicircle, right→left (∩ cupping disc from above)
    cr.closePath() // up left wall back to start
    cr.setSourceRGBA(...trackColour(config))
    cr.fill()
  }

  // ── BOTTOM shape: disc + fill stem as ONE path (dome + stem walls + bottom cap) ──
  // Single fill → single rasterization → uniform alpha, no seam, no double
  // compositing (two overlapping fills of the same colour would OVER-blend to
  // a brighter band — that's the "half the disc is shaded differently" bug).
  // The disc's bottom half is interior to the full-width stem, so the outline
  // is just: dome (disc top semicircle) → right wall → bottom cap → left wall.
  cr.newPath()
  cr.moveTo(cx - semiR, iconCentreY) // disc's left point (start of dome)
  cr.arc(cx, iconCentreY, semiR, Math.PI, 2 * Math.PI) // dome: disc top semicircle, left→right (∩)
  cr.lineTo(cx + semiR, capCentreYBottom) // down right wall to bottom-right corner
  cr.arc(cx, capCentreYBottom, semiR, 0, Math.PI) // bottom cap (∩ curving down)
  cr.closePath() // up left wall to disc's left point
  // Backdrop-compensated: this disc+stem paints OVER the shared surface's
  // pill backdrop (strip + panel stadium) — raw alpha would OVER-stack and
  // read more opaque than the disc's configured alpha (see draw-utils).
  cr.setSourceRGBA(...([...config.appearance.disc.rgb, effectiveDiscAlpha(config)] as number[]))
  cr.fill()

  cr.restore()
}

/**
 * Paint the step pill as TWO unfilled regions split at the disc, so nothing is
 * painted under the disc — the disc floats in a circular void with unfilled
 * track both above and below it. Both regions use `trackColour(config)` (the same
 * unfilled element `paintContinuous` paints above its disc, one shared source);
 * there is no fill (step panels have no continuous value).
 *
 *   TOP region:    top cap → disc's top semicircle (concave ∩ from above).
 *   BOTTOM region: disc's bottom semicircle (concave ∪ from below) → bottom cap.
 *
 * The disc-facing arcs hug the disc at `geo.iconCentreY` (per-frame centre,
 * tracked from render()'s iconTopY). The step EMOJIS are NOT painted here —
 * they go in a foreground layer above the disc (see stepPanel's paintForeground
 * → paintStepEmojis) so the translucent disc doesn't muffle them.
 */
/**
 * The panel's UNFILLED region paint — the one source both the continuous and
 * the step family paint the same element with (`paintContinuous`'s region above
 * the disc, `paintStep`'s whole pill above+below it).
 *
 * It is `draw-utils`' `backdropLiftColour`: the layer that raises the backdrop's
 * own paint to the bar's visible tone, so the pill's surface reads exactly as
 * the dock bar does — the same value the dock's backdrop paints over its strip
 * between the discs (see `@common/applets/backdrop`). The region is already
 * covered by the backdrop base (strip + the open panel's stadium), so this pass
 * only ever ADDS the lift, never a second base.
 *
 * `paintStep` clips the disc's circle out of both regions and
 * `paintContinuous` leaves the disc + stem to the fill below it, so the disc
 * stays the pill's darkest surface and never composites over the lift — its
 * rendered colour is unchanged by the bar's tone.
 */
function trackColour(config: AppletConfig): number[] {
  return backdropLiftColour(config)
}

function paintStep(config: AppletConfig, cr: any, w: number, h: number, geo: PaintGeo): void {
  const { topY, semiR, iconCentreY, oh } = geo
  const cx = w / 2
  const capCentreYBottom = topY + oh - semiR

  cr.save()

  // TOP + BOTTOM unfilled tracks, split at the disc. Each: clip out the DISC
  // CIRCLE (even-odd clip: canvas rect + disc arc), then fill the track region
  // (the respective cap circle + rectangle to the disc's widest points) — the
  // track hugs the disc's curve at every icon position. No gates, no
  // self-intersecting paths (gated concave arcs can vanish the whole bottom
  // track once the disc comes within ~17% of the cap).
  const track = trackColour(config)

  cr.save()
  cr.newPath()
  cr.rectangle(0, 0, w, h)
  cr.setFillRule(1) // CAIRO_FILL_RULE_EVEN_ODD
  cr.newSubPath()
  cr.arc(cx, iconCentreY, semiR, 0, 2 * Math.PI)
  cr.clip()
  cr.setFillRule(0) // back to WINDING — the track fills must union, not punch
  // TOP track
  cr.newPath()
  cr.rectangle(cx - semiR, topY + semiR, 2 * semiR, iconCentreY - topY - semiR)
  cr.newSubPath()
  cr.arc(cx, topY + semiR, semiR, 0, 2 * Math.PI)
  cr.setSourceRGBA(...track)
  cr.fill()
  // BOTTOM track
  cr.newPath()
  cr.rectangle(cx - semiR, iconCentreY, 2 * semiR, capCentreYBottom - iconCentreY)
  cr.newSubPath()
  cr.arc(cx, capCentreYBottom, semiR, 0, 2 * Math.PI)
  cr.fill()
  cr.restore()

  cr.restore()
}

/**
 * Paint the step emojis in the FOREGROUND layer (above the disc). Same size
 * (13) and shadow as the icon glyph, but painted on a topmost overlay so the
 * translucent disc cannot muffle them. Positioned at each step's centre Y.
 */
function paintStepEmojis(
  config: AppletConfig,
  cr: any,
  w: number,
  h: number,
  geo: PaintGeo,
  steps: { label: string; emoji: string }[],
  getStepColour: (index: number) => { rgb: number[]; alpha: number },
  model: PillModel,
  spin: { index: number; angle: number } = { index: -1, angle: 0 },
  /** sameAsStep0: on-the-fly judgment — the applet's dock glyph is identical
   *  (same codepoint + colour) to the step-0 emoji. When step 0 is current
   *  AND the glyph matches, skip painting the step-0 emoji — the dock glyph
   *  (kept at full ringFill) already shows it, and painting it again would
   *  re-fade the same icon in on top of itself. */
  sameAsStep0: () => boolean = () => false,
  currentStep = 0,
): void {
  const sh = config.appearance.textShadow
  const horizontal = w > h
  // Layered fade: the emojis are clipped to the grown pill region (the
  // gradual one-by-one reveal as the pill expands) AND fade in/out with the
  // pill's growth over the same pillAnim duration.
  const fade = Math.max(0, Math.min(1, geo.pillGrowth))
  if (fade <= 0.001) return
  cr.selectFontFace(config.fonts.family, 0, 0)
  cr.setFontSize(config.fonts.iconSize)
  const skipStep0 = sameAsStep0() && currentStep === 0
  steps.forEach((step, i) => {
    if (skipStep0 && i === 0) return
    const pos = model.centreYFor(i) // position along the pill's long axis (x if horizontal, y if vertical)
    const colour = getStepColour(i)
    const ext = cr.textExtents(step.emoji)
    const tx = horizontal
      ? pos - ext.width / 2 - ext.xBearing
      : w / 2 - ext.width / 2 - ext.xBearing
    const ty = horizontal
      ? h / 2 - ext.height / 2 - ext.yBearing
      : pos - ext.height / 2 - ext.yBearing
    // Rotate the spinning step's glyph (e.g. the scan step while a scan is in
    // flight) around its visual centre — shadow + glyph together.
    const rotating = spin.index === i && Math.abs(spin.angle) > 0.001
    if (rotating) {
      const rcx = tx + ext.xBearing + ext.width / 2
      const rcy = ty + ext.yBearing + ext.height / 2
      cr.save()
      cr.translate(rcx, rcy)
      cr.rotate(-spin.angle) // counter-clockwise (the user's scan-spin direction)
      cr.translate(-rcx, -rcy)
    }
    // Shadow
    cr.setSourceRGBA(sh.rgb[0], sh.rgb[1], sh.rgb[2], 0.4 * fade)
    cr.moveTo(tx + sh.offset, ty + sh.offset)
    cr.showText(step.emoji)
    // Foreground — painted at the same alpha as the dock glyph (0.9), never
    // dimmer: a stepColour alpha below the glyph's 0.9 would leave the emojis
    // visibly weaker than the icon glyph.
    cr.setSourceRGBA(
      colour.rgb[0],
      colour.rgb[1],
      colour.rgb[2],
      Math.max(colour.alpha, 0.9) * fade,
    )
    cr.moveTo(tx, ty)
    cr.showText(step.emoji)
    if (rotating) cr.restore()
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Public: continuousPanel
// ──────────────────────────────────────────────────────────────────────────

interface ContinuousOpts {
  initialValue: number
  onValue: (v: number) => void
  setDragActive?: (active: boolean) => void
  step?: number
  /** When true, onValue fires once on drag release (and click) instead of on
   *  every drag-update. Use for backends where a per-update commit is wasteful
   *  or jittery (e.g. Battery writing charge_threshold to sysfs each update). */
  commitOnRelease?: boolean
  externalIcon: Gtk.DrawingArea
  /** The applet's render state (the icon's draw trampoline reads it). */
  render: RenderState
  dockGeometry: DockGeometry
  /** The host's live config view (geometry, timing, appearance). */
  config: AppletConfig
  /** Report the grown pill extent (oh) to the shared surface's region engine. */
  setPanelOh?: (oh: number) => void
}

export function continuousPanel(opts: ContinuousOpts): Panel {
  const stepFn = opts.step ? (v: number) => Math.round(v / opts.step!) * opts.step! : undefined
  const snap = (v: number) => clamp(stepFn ? stepFn(v) : Math.round(v), 0, 100)
  const model = makeModel(opts.config, 0, 100, opts.dockGeometry, snap)

  const core = createPill({
    config: opts.config,
    model,
    externalIcon: opts.externalIcon,
    render: opts.render,
    setDragActive: opts.setDragActive,
    initialDisplay: 0, // icon starts at the bottom and rises in
    initialTarget: snap(opts.initialValue),
    // SAFETY: ctx is the Cairo context from the applet draw_func; PaintGeo is the
    // caller-defined geometry struct the paint helpers read from it.
    paint: (cr, w, h, ctx) =>
      paintContinuous(opts.config, cr, w, h, ctx as unknown as PaintGeo, model, ctx.display),
    // When a step is set, publish a step-quantized text value so the icon's %
    // text ticks in step increments while the slider glides on the float.
    textValueFor: opts.step ? (d) => snap(d) : undefined,
    setPanelOh: opts.setPanelOh,
    dockGeometry: opts.dockGeometry,
  })

  const { state, render, scheduleFrame, clearAnim } = core

  function animateIn(): void {
    animatePillIn(opts.config, core, handle, "pill", true)
  }

  function animateOut(done: () => void): void {
    animatePillOut(opts.config, core, handle, done, "pill", true)
  }

  // ── Gestures ──
  // During a drag the slider glides at sub-percent granularity: `display`
  // (icon/fill position) tracks the cursor's raw float value, while the value
  // sent to the backend via onValue is always the snapped (quantized) one. So
  // Volume/Brightness feel infinitely granular visually even though the actual
  // value changes in 1% steps; the slider settles to the quantized position on
  // release (drag-end). When `step` is set (Battery: 5) the dial snaps in the
  // dial itself, so display is already quantized and the glide is step-sized.
  const dial = createDial({
    getStart: () => state.target,
    min: 0,
    max: 100,
    pxPerUnit: centreRange(opts.config) / 100,
    growAxis: opts.dockGeometry.growAxis,
    growDir: opts.dockGeometry.growDir,
    onSelect: (v) => {
      // v is always the raw float cursor value (the dial never snaps). display
      // tracks it for sub-percent glide on ALL continuous applets; target is
      // quantized via snap() (1% default, step multiples for Battery).
      // While the open (growth) animation runs, keep it alive: clearAnim here
      // would kill it mid-flight and freeze the expand (the window height
      // rides handle.onGrowth, which only the open anim drives). The open anim
      // writes only pillGrowth, so the value commit below coexists with it.
      const opening = state.phase === "open"
      if (!opening) clearAnim()
      state.display = v // float — icon/fill track the cursor exactly
      state.target = snap(v) // quantized — the committed value
      if (!opening) state.pillGrowth = 1
      render()
      // Fire onValue live unless the applet defers commits to release
      // (commitOnRelease — e.g. Battery, to avoid a sysfs write per drag-update).
      if (!opts.commitOnRelease) opts.onValue(state.target)
    },
  })

  let dragging = false
  let pressPos = 0
  let pendingSettle = false // drag-release settle deferred until the open anim finishes

  // Drag is driven by a GestureDrag, NOT EventControllerMotion: a gesture
  // claims the pointer sequence and rides the implicit grab, so drag-update
  // keeps firing even after the cursor leaves the panel surface (drags past
  // the top, off the side) until button release. EventControllerMotion only
  // emits motion inside the widget allocation, so it would drop the drag at
  // the boundary. drag-update delivers (offset_x, offset_y) relative to the
  // press point — exactly what dial.update() expects.
  const drag = new Gtk.GestureDrag()
  const geo = opts.dockGeometry
  const dragWin = (): any => panelRoot(core)
  let dragStart = 0
  let dragCancelled = false
  const cancelContinuousDrag = (): void => {
    if (!dragging) return
    if (DBG) print("[drag] cancel continuous (Escape/corner)")
    dragging = false
    dragCancelled = true
    clearAnim()
    state.phase = ""
    state.display = dragStart
    state.target = dragStart
    if (opts.onValue) opts.onValue(dragStart) // restore the backend (live applets)
    dial.end()
    opts.setDragActive?.(false)
    releaseDragEscape(dragWin())
    render()
  }
  drag.connect("drag-begin", (_g: any, startX: number, startY: number) => {
    pressPos = geo.growAxis === "x" ? startX : startY
    dragging = false
    dragStart = state.target
    dragCancelled = false
  })
  const DZ = opts.config.appearance.thresholds.dragDeadZone
  drag.connect("drag-update", (_g: any, offX: number, offY: number) => {
    const growOff = geo.growAxis === "x" ? offX : offY
    if (!dragging && !dragCancelled && Math.abs(growOff) > DZ) {
      dragging = true
      if (DBG) print("[drag] ENGAGE continuous")
      opts.setDragActive?.(true)
      dial.begin()
      attachDragEscape(dragWin(), cancelContinuousDrag) // Escape + corner-touch bail
    }
    if (!dragging) return
    dial.update(offX, offY)
  })
  drag.connect("drag-end", () => {
    if (dragCancelled) {
      if (DBG) print("[drag] END cancelled-bail")
      dragCancelled = false
      releaseDragEscape(dragWin())
      return
    }
    if (dragging) {
      // commitOnRelease applets (e.g. Battery) deferred the commit during the
      // drag; fire it once now, at release. (Live applets already got every
      // update via dial.onSelect.)
      if (opts.commitOnRelease) opts.onValue(state.target)
      if (state.phase === "open") {
        // Defer the settle until the open animation finishes — starting it now
        // would clearAnim() the open anim and freeze the expand mid-flight.
        pendingSettle = true
      } else {
        runSettle()
      }
    } else {
      // Click-to-set: jump instantly to the pressed position.
      const clampedVal = clamp(pressPos, model.minY, model.maxY)
      handle.setHighlight(Math.round(model.valueFromY(clampedVal)))
    }
    dragging = false
    dial.end()
    // Release the keyboard grab BEFORE clearing blockClose (setDragActive
    // false): the focus restore (follow_mouse) can trigger a compositor LEAVE,
    // and blockClose still guards the 220ms grace close. A LEAVE after
    // blockClose clears would schedule the close with the cursor still over the
    // pill.
    releaseDragEscape(dragWin())
    opts.setDragActive?.(false)
  })
  drag.connect("cancel", () => {
    if (DBG) print("[drag] GESTURE-CANCEL continuous")
    dragging = false
    dial.end()
    releaseDragEscape(dragWin())
    opts.setDragActive?.(false)
  })
  ;(core.widget as any).add_controller(drag)

  /** Ease the float `display` to the quantized `target` on drag release (also
   *  run deferred from onOpenSettled when the release landed mid-open). */
  const runSettle = (): void => {
    clearAnim()
    state.phase = "settle"
    state.animId = scheduleFrame(() => {
      if (state.destroyed) {
        state.animId = null
        state.phase = ""
        return false
      }
      const diff = state.target - state.display
      if (Math.abs(diff) < 0.05) {
        state.display = state.target
        state.animId = null
        state.phase = ""
        render()
        return false
      }
      state.display += diff * 0.4
      render()
      return true
    }, "pill:settle")
  }

  const handle: PanelHandle = {
    setHighlight(v) {
      // Don't kill a running open animation (click-to-set mid-expand would
      // otherwise clearAnim() it and freeze the pill at its current growth):
      // commit the value and let the open anim carry pillGrowth to 1 itself.
      const opening = state.phase === "open"
      if (!opening) clearAnim()
      state.target = snap(v)
      state.display = state.target
      if (!opening) {
        state.pillGrowth = 1
        state.ringFill = 0
      }
      render()
      opts.onValue(state.target)
    },
    animateIn,
    onOpenSettled: () => {
      if (pendingSettle) {
        pendingSettle = false
        runSettle()
      }
    },
    onExternalChange: animatePillExternal(opts.config, core, {
      snap,
      guardSnap: false,
      resetRingFill: true,
      label: "pill",
    }),
    animateOut,
    setHeight: (h) => {
      // Constrain the pill DrawingArea to the current pill height along the
      // grow axis. For vertical (top/bottom): IS()×h. For horizontal
      // (left/right): h×IS(). render() sets the full size every frame; this
      // override (called by onGrowth after render) clips the pill during
      // animation so Cairo only draws the visible portion.
      const [rw, rh] =
        opts.dockGeometry.growAxis === "y" ? [IS(opts.config), h] : [h, IS(opts.config)]
      ;(core.pill as any).set_size_request(rw, rh)
      ;(core.pill as any).queue_resize?.()
    },
  }

  render()
  return { widget: core.widget, handle }
}

// ──────────────────────────────────────────────────────────────────────────
// Public: stepPanel
// ──────────────────────────────────────────────────────────────────────────

/** The applet's closed-state dock glyph when it IS a single emoji glyph:
 *  live-resolved codepoint + the colour it's painted with. stepPanel judges on
 *  the fly whether it's identical to the index-0 option (same codepoint AND
 *  same colour) so the open cross-fade is suppressed instead of blinking the
 *  same icon in place. Applets whose dock glyph is a ring/text composition
 *  leave this unset — the comparison then fails and the fade stays. */
export interface DockGlyphDescriptor {
  emoji: () => string
  colour: { rgb: number[]; alpha: number }
}

interface DiscreteStepOpts {
  steps: { label: string; emoji: string }[]
  getStepColour: (index: number) => { rgb: number[]; alpha: number }
  initialStep: number
  onSelect: (step: number) => void
  setDragActive?: (active: boolean) => void
  externalIcon: Gtk.DrawingArea
  /** The applet's render state (the icon's draw trampoline reads it). */
  render: RenderState
  dockGeometry: DockGeometry
  /** The host's live config view (geometry, timing, appearance). */
  config: AppletConfig
  /** When false, the panel's drag/click-to-step is inert (the gesture still
   *  claims presses so a competing controller can't fire, but no onSelect or
   *  snap can run). Used during move mode: the closing overflow pill must not
   *  clobber the mode or interrupt its close while the move drag takes over. */
  dragEnabled?: () => boolean
  /** The applet's closed-state dock glyph when it IS a single emoji glyph (see
   *  DockGlyphDescriptor). stepPanel judges on the fly whether it matches the
   *  index-0 option (same codepoint + colour) and suppresses the open
   *  cross-fade while the current step is index 0 (the disc is at rest; the
   *  identical glyph would otherwise fade out and back in at the same spot). */
  dockGlyph?: DockGlyphDescriptor
  /** Report the grown pill extent (oh) to the shared surface's region engine. */
  setPanelOh?: (oh: number) => void
}

export function stepPanel(opts: DiscreteStepOpts): Panel {
  const N = opts.steps.length
  const snap = (v: number) => clamp(Math.round(v), 0, Math.max(0, N - 1))
  const model = makeModel(opts.config, 0, Math.max(0, N - 1), opts.dockGeometry, snap)

  // On-the-fly dock-glyph == step-0 judgment: identical codepoint AND colour.
  // LockSession's dock glyph is painted [0.9,0.9,0.9] vs its step-0 colour
  // [0.92,0.92,0.92] — 0.02/channel apart — so a small per-channel tolerance
  // treats "same white icon" as same, while a real colour change (red vs
  // white, ~0.7 apart) stays different and keeps the fade.
  const sameAsStep0 = (): boolean => {
    const dg = opts.dockGlyph
    if (!dg) return false
    if (dg.emoji() !== opts.steps[0].emoji) return false
    const gc = dg.colour
    const sc = opts.getStepColour(0)
    const tol = 0.05
    for (let i = 0; i < 3; i++) {
      if (Math.abs((gc.rgb[i] ?? 0) - (sc.rgb[i] ?? 0)) > tol) return false
    }
    return true
  }

  const core = createPill({
    config: opts.config,
    model,
    externalIcon: opts.externalIcon,
    render: opts.render,
    setDragActive: opts.setDragActive,
    initialDisplay: snap(opts.initialStep),
    initialTarget: snap(opts.initialStep),
    // SAFETY: same draw_func ctx → PaintGeo contract as paintContinuous.
    paint: (cr, w, h, ctx) => paintStep(opts.config, cr, w, h, ctx as unknown as PaintGeo),
    // Emojis paint in a foreground layer ABOVE the disc, not in the pill (which
    // is beneath the disc) — otherwise the translucent disc muffles them.
    paintForeground: (cr, w, h, ctx) =>
      paintStepEmojis(
        opts.config,
        cr,
        w,
        h,
        // SAFETY: same draw_func ctx → PaintGeo contract as paintContinuous.
        ctx as unknown as PaintGeo,
        opts.steps,
        opts.getStepColour,
        model,
        spin,
        sameAsStep0,
        Math.round(state.display),
      ),
    ringFillMode: "growth",
    sameAsStep0,
    setPanelOh: opts.setPanelOh,
    dockGeometry: opts.dockGeometry,
  })

  const { state, render, scheduleFrame, clearAnim } = core

  // ── Step-emoji spin (the scan step's glyph rotates while a scan runs; on
  //    stop the angle eases back to the nearest upright, then the tick dies).
  //    Driven by the applet via handle.setSpin(stepIndex, active) — e.g. wifi
  //    spins while its local rescan flag is set, bluetooth while the adapter's
  //    Discovering property is true. ──
  const spin: { index: number; angle: number; active: boolean } = {
    index: -1,
    angle: 0,
    active: false,
  }
  interface SpinTick {
    id: number | null
    isTick: boolean
    active: boolean
  }
  let spinTick: SpinTick | null = null
  const SPIN_RPS = 1 // full turns per second while spinning
  const SPIN_EASE_MS = 250 // upright-return duration

  function ensureSpinTick(): void {
    if (spinTick) return
    const run: SpinTick = { id: null, isTick: false, active: true }
    spinTick = run
    let lastUs = GLib.get_monotonic_time()
    let easing = false
    let easeFrom = 0
    let easeTo = 0
    let easeStartUs = 0
    const step = (nowUs: number): boolean => {
      const dtSec = (nowUs - lastUs) / 1e6
      lastUs = nowUs
      if (state.destroyed) {
        run.active = false
        spinTick = null
        return false
      }
      if (spin.active) {
        easing = false
        spin.angle += SPIN_RPS * 2 * Math.PI * dtSec
      } else if (easing) {
        const t = Math.min(1, (nowUs - easeStartUs) / (SPIN_EASE_MS * 1000))
        spin.angle = easeFrom + (easeTo - easeFrom) * easeQuadInOut(t)
        if (t >= 1) {
          spin.angle = easeTo
          spin.active = false
          run.active = false // source self-removed — skip second removal
          spinTick = null
          return false
        }
      } else {
        // Spin finished — ease back to the nearest upright (shortest path).
        easing = true
        easeFrom = spin.angle
        easeTo = Math.round(easeFrom / (2 * Math.PI)) * 2 * Math.PI
        easeStartUs = nowUs
      }
      if (state.pillGrowth > 0.001) render()
      return true
    }
    const tickId = (core.foreground as any)?.add_tick_callback?.(() =>
      step(GLib.get_monotonic_time()),
    )
    if (tickId !== 0 && tickId !== undefined) {
      run.isTick = true
      run.id = tickId
    } else {
      run.isTick = false
      run.id = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        Math.round(1000 / opts.config.timing.framerate),
        () => (step(GLib.get_monotonic_time()) ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE),
      )
    }
  }

  function setSpin(stepIndex: number, active: boolean): void {
    if (active) {
      spin.index = stepIndex
      spin.active = true
      ensureSpinTick()
      render()
    } else {
      spin.active = false
      if (Math.abs(spin.angle) <= 0.001) spin.index = -1
      else ensureSpinTick() // existing tick eases it back to upright
    }
  }

  function animateIn(): void {
    animatePillIn(opts.config, core, handle, "step", false)
  }

  function animateOut(done: () => void): void {
    animatePillOut(opts.config, core, handle, done, "step", false)
  }

  // ── Gestures ──
  const geo = opts.dockGeometry
  let dragging = false
  let pressPos = 0
  let dragAnchor = 0

  // GestureDrag (not EventControllerMotion) so drag-update rides the implicit
  // grab and keeps firing after the cursor leaves the surface — see continuous
  // panel's gesture block for the full rationale.
  const drag = new Gtk.GestureDrag()
  const dragWin = (): any => panelRoot(core)
  let stepDragStart = 0
  let stepDragCancelled = false
  let pendingSnap: number | null = null // click-to-step deferred until the open anim finishes
  const cancelStepDrag = (): void => {
    if (!dragging) return
    if (DBG) print("[drag] cancel step (Escape/corner)")
    dragging = false
    stepDragCancelled = true
    clearAnim()
    state.phase = ""
    state.display = stepDragStart
    state.target = stepDragStart
    opts.setDragActive?.(false)
    releaseDragEscape(dragWin())
    render()
  }
  drag.connect("drag-begin", (_g: any, startX: number, startY: number) => {
    pressPos = geo.growAxis === "x" ? startX : startY
    dragging = false
    dragAnchor = model.centreYFor(state.display)
    stepDragStart = state.display
    stepDragCancelled = false
  })
  const ddz = opts.config.appearance.thresholds.dragDeadZone
  drag.connect("drag-update", (_g: any, offX: number, offY: number) => {
    const growOff = geo.growAxis === "x" ? offX : offY
    if (!dragging && !stepDragCancelled && Math.abs(growOff) > ddz) {
      dragging = true
      if (DBG) print("[drag] ENGAGE step")
      opts.setDragActive?.(true)
      attachDragEscape(dragWin(), cancelStepDrag) // Escape + corner-touch bail
    }
    if (!dragging) return
    const newPos = clamp(dragAnchor + growOff, model.minY, model.maxY)
    state.display = model.valueFromY(newPos)
    state.target = state.display
    render()
  })
  drag.connect("drag-end", () => {
    if (opts.dragEnabled && !opts.dragEnabled()) {
      releaseDragEscape(dragWin())
      return
    }
    if (stepDragCancelled) {
      if (DBG) print("[drag] END cancelled-bail")
      stepDragCancelled = false
      releaseDragEscape(dragWin())
      return
    }
    if (dragging) {
      state.target = snap(clamp(state.display, 0, N - 1))
    } else {
      // Click-to-step: snap to the nearest step at the pressed position.
      const clampedPos = clamp(pressPos, model.minY, model.maxY)
      state.target = snap(model.valueFromY(clampedPos))
    }
    dragging = false
    // Release the keyboard grab BEFORE clearing blockClose (see the
    // continuous drag-end note).
    releaseDragEscape(dragWin())
    opts.setDragActive?.(false)

    // Snap animation: ease display → target over 150ms, then commit. While
    // the open (growth) animation runs, defer it — clearAnim() would cancel
    // the open mid-flight and freeze the expand; onOpenSettled runs the snap
    // when the open completes.
    if (state.phase === "open") {
      pendingSnap = state.target
      return
    }
    runSnap(state.target)
  })
  drag.connect("cancel", () => {
    if (DBG) print("[drag] GESTURE-CANCEL step")
    dragging = false
    releaseDragEscape(dragWin())
    opts.setDragActive?.(false)
  })
  ;(core.widget as any).add_controller(drag)

  /** Ease display → the snapped step, then commit via onSelect (also run
   *  deferred from onOpenSettled when the click landed mid-open). */
  const runSnap = (to: number): void => {
    clearAnim()
    state.phase = "snap"
    const from = state.display
    const startUs = GLib.get_monotonic_time()
    state.animId = scheduleFrame((nowUs) => {
      if (state.destroyed) {
        state.animId = null
        state.phase = ""
        return false
      }
      const t = Math.min(1, (nowUs - startUs) / (opts.config.timing.stepSnap * 1000))
      state.display = from + (to - from) * easeQuadInOut(t)
      render()
      if (t >= 1) {
        state.display = to
        state.animId = null
        state.phase = ""
        opts.onSelect(to)
        return false
      }
      return true
    }, "step:snap")
  }

  const handle: PanelHandle = {
    setHighlight(v) {
      clearAnim()
      state.target = snap(v)
      state.display = state.target
      state.pillGrowth = 1
      render()
    },
    animateIn,
    onOpenSettled: () => {
      if (pendingSnap !== null) {
        const to = pendingSnap
        pendingSnap = null
        runSnap(to)
      }
    },
    onExternalChange: animatePillExternal(opts.config, core, {
      snap,
      guardSnap: true,
      resetRingFill: false,
      label: "step",
    }),
    animateOut,
    setHeight: (h) => {
      const [rw, rh] =
        opts.dockGeometry.growAxis === "y" ? [IS(opts.config), h] : [h, IS(opts.config)]
      ;(core.pill as any).set_size_request(rw, rh)
      ;(core.pill as any).queue_resize?.()
    },
    setSpin,
  }

  render()
  return { widget: core.widget, handle, foreground: core.foreground }
}
