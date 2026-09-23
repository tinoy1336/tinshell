/**
 * common/applets/shared/create-applet-core.ts — the unified applet state machine.
 *
 * The shared core owns everything both applet types do the same way:
 *   - one whole-window EventControllerMotion (enter → zero-delay open, leave →
 *     220ms grace close, mid-close re-enter → in-place reopen on the same panel),
 *   - the icon ↔ panel reparenting (attachIconTo / detachIcon) + the icon draw
 *     wrapper (the applet's render state + the intro group fade),
 *   - PanelHub single-open (keepOpen-aware hubClose),
 *   - the keyboard Escape bail + the corner touch-bail wiring,
 *   - the closed-state icon ring smoothing (continuous applets only).
 *
 * The panel-type-specific bits arrive as options: the buildPanel function
 * (stepPanel wiring vs the applet-provided continuous builder), the draw
 * argument sources (live channels + getState vs fixed 0/false), the external
 * push behaviour (ring-smooth + push vs plain push), and the finish reseed.
 */

import GLib from "gi://GLib"
import { type FrameRunner, runFrames } from "@common/anim/run-frames"
import type { AppletWindow } from "@common/applets/applet-window"
import type { AppletConfig } from "@common/applets/config"
import { attachPanelEscape, releasePanelEscape } from "@common/applets/panel-framework"
import {
  registerLeaveEval,
  registerOpen,
  unregisterLeaveEval,
  unregisterOpen,
} from "@common/applets/panel-hub"
import type { DrawIcon, Panel } from "@common/applets/types"
import { onCleanup } from "gnim"

const DBG = !!GLib.getenv("DOCK_DEBUG")

// ── Map-enter guard debug hooks (regression instrumentation) ──
// Each applet core registers a hook so `dock debug overflow guard [repro]`
// can dump the guard state and REPRODUCE the synthetic post-map condition
// through the REAL handler chain (no pointer injection): a suppressed
// map-enter followed by a real motion event — the motion must NOT open the
// panel.
interface MapGuardHook {
  name: string
  snapshot: () => string
  repro: () => string
}
const mapGuardHooks = new Map<string, MapGuardHook>()
export function mapGuardHooksAll(): MapGuardHook[] {
  return [...mapGuardHooks.values()]
}

export interface AppletCoreHandle {
  /** Push an external value/step into the open panel (animated). No-op if closed. */
  externalChange: (v: number) => void
  /** Force a repaint of the open panel's pill + foreground + icon. */
  redraw: () => void
  /** Close the panel from outside onSelect (e.g. the wifi/bt menus). */
  close: () => void
  /** Close INSTANTLY (skip animateOut) — used when entering move mode so the
   *  closing pill's GestureDrag can't starve the move drag. */
  closeInstant: () => void
  /** Open the panel programmatically (debug/test hook). */
  forceOpen: () => void
  /** Rotate the emoji of `stepIndex` while active (scan in flight); eases back
   *  on stop. No-op on continuous panels (no setSpin on their handle). */
  setSpin: (stepIndex: number, active: boolean) => void
}

interface AppletCoreOpts {
  drawIcon: DrawIcon
  /** The host's live config view (geometry, timing, appearance). */
  config: AppletConfig
  /** When true, the leave-grace close is suppressed (wifi/bt menu pin). */
  keepOpen?: () => boolean
  onPanelOpen?: () => void
  onPanelClosed?: () => void
  logLabel?: string
  /** Build the panel (step: stepPanel wiring; continuous: the applet's builder). */
  buildPanel: (ctx: { setDragActive: (active: boolean) => void; close: () => void }) => Panel
  /** Draw-argument sources. Continuous reads the live render state
   *  (value/skipDisc/textValue) + getState(); step passes fixed 0/false/
   *  undefined. The closed-state value is the core's own ringValue (0 for
   *  step). */
  draw: {
    state: () => boolean // continuous: opts.getState(); step: false
    channels: boolean // continuous: hand the render state's value/skipDisc/textValue
  }
  /** Continuous: re-seed the closed-state ring value on panel close. */
  onFinishReseed?: () => void
  /** Continuous: wire the applet's value subscriptions (redraw + sync). */
  setupSubscriptions?: (c: { redraw: () => void; sync: () => void }) => void
  /** Continuous: source for the closed-state ring smoothing. */
  getValue?: () => number
}

export function createAppletCore(aw: AppletWindow, opts: AppletCoreOpts): AppletCoreHandle {
  const icon = aw.icon
  const render = aw.render
  const drawIcon = opts.drawIcon

  let panel: Panel | null = null
  let ringValue = opts.getValue?.() ?? 0 // smoothed icon value when closed (continuous)
  let ringRunner: FrameRunner | null = null
  let closeTimer: number | null = null
  let panelOpen = false
  let closing = false // true while animateOut is running (mid-close)
  let closeToken = 0 // increments per close; finish() bails if stale
  let blockClose = false // true while dragging (prevents grace close)
  let pointerInside = false
  // motionOpens: panels opened by a pointer-motion path — no such path
  // exists (motion never opens); the counter stays at 0 and the repro hook
  // proves it. pressOpens/forceOpens = the explicit paths.
  let syntheticEnters = 0
  let motionOpens = 0
  let pressOpens = 0
  let forceOpens = 0

  // ── Map-enter suppression (the boot/move-commit spontaneous-open bug) ──
  // A dock window that maps under a RESTING pointer — fresh boot, or a
  // rebuild/move-commit reflow where the pointer is guaranteed to sit on the
  // overflow icon the user just double-clicked — receives a synthetic
  // wl_pointer enter from the compositor. Without a guard that enter
  // hover-opens the panel with zero user intent (and the overflow's
  // onPanelOpen then begins the reveal fan-out). A panel may open only after
  // (a) a REAL pointer motion over this window (genuine hover), or (b) the
  // post-map arming grace elapsed, so a LATER enter is a real approach.
  // Explicit taps (pressOpen) bypass the guard.

  // ── Icon ring-value smoothing (continuous closed state) ──

  function clearRingAnim(): void {
    ringRunner?.cancel()
    ringRunner = null
  }

  /** Ease the icon's displayed value toward the current backend value. */
  function startRingAnim(): void {
    if (!opts.getValue) return
    clearRingAnim()
    ringRunner = runFrames(
      icon,
      () => {
        const target = opts.getValue!()
        const diff = target - ringValue
        if (Math.abs(diff) < 0.3) {
          ringValue = target
          icon.queue_draw()
          ringRunner = null // self-removing via the false return
          return false
        }
        ringValue += diff * 0.3
        icon.queue_draw()
        return true
      },
      opts.config.timing.framerate,
    )
  }

  function clearClose(): void {
    if (closeTimer !== null) {
      GLib.source_remove(closeTimer)
      closeTimer = null
    }
  }

  function setDragActive(active: boolean): void {
    blockClose = active
  }

  function refreshDraw(): void {
    icon.queue_draw()
  }

  /** External value arrived (volume key etc.): smooth the closed icon and let
   *  the open panel handle the change too (deferred while animating). */
  function refreshAndSync(): void {
    startRingAnim()
    panel?.handle.onExternalChange?.(opts.getValue?.() ?? 0)
  }

  // ── Motion: one controller on the window, whole-window boundary ──

  function onEnter(x: number, y: number, bypassMapGuard = false): void {
    pointerInside = true
    if (DBG) print(`[core] onEnter ${aw.name} x=${x} y=${y}`)
    render.cursor = { x, y, over: 1 }
    clearClose()
    // Reveal-session keepers: entering any window keeps the overflow reveal
    // alive; entering a revealed (parked) window also resets the idle timer.
    aw.row?.cursorEnter?.(aw.name)
    aw.row?.noteInteraction?.(aw.name)
    if (panelOpen) return
    if (closing) {
      reopen()
      return
    }
    if (!bypassMapGuard && !mapArmed) {
      syntheticEnters++
      if (DBG) print(`[core] enter suppressed (map-enter guard) ${aw.name}`)
      return
    }
    open()
  }

  function onLeave(): void {
    pointerInside = false
    if (DBG) print(`[core] onLeave ${aw.name}`)
    const c = render.cursor
    if (c) c.over = 0
    aw.row?.cursorLeave?.(aw.name)
    maybeScheduleClose()
  }

  /** Pointer motion over the window: updates the cursor position ONLY. It
   *  deliberately does NOT open the panel — motion is not a boundary crossing.
   *  When a window maps under a resting pointer (fresh boot, move-commit
   *  reflow), the compositor's synthetic enter marks the pointer inside even
   *  though it never crossed the window's edge; treating the
   *  user's next real mouse twitch as "genuine hover" would open the panel
   *  (the spontaneous overflow-open regression). Suppression lifts only when
   *  the pointer LEAVES and genuinely RE-ENTERS once the arming grace has
   *  passed (a fresh onEnter with mapArmed=true), or via the explicit
   *  pressOpen tap. Extracted so the debug hook can drive the same chain. */
  function onMotion(x: number, y: number): void {
    render.cursor = { x, y, over: 1 }
  }

  // ── Open / close / reopen ──

  function open(): void {
    clearClose()
    if (panelOpen || closing) return
    // Suppress hover-open while a rebuild teardown is retracting this window —
    // opening a panel on a window that is about to be destroyed is wasted work
    // and leaves a stale PanelHub registration for the new dock to clean up.
    if (aw.isTearingDown()) return
    // Move mode: everything is frozen — no panel opens on any window,
    // including the overflow window itself (it is the drag handle).
    if (aw.row?.isMoveMode?.()) return
    panelOpen = true
    panel = opts.buildPanel({ setDragActive, close: doClose })
    // Bridge the panel's growth animation to its visible height (the window-
    // size driver in render() consumes this; kept for API compatibility).
    panel.handle.onGrowth = (growth: number) => {
      const h = Math.round(
        opts.config.layout.iconSize +
          growth * (opts.config.layout.pillHeight - opts.config.layout.iconSize),
      )
      panel?.handle.setHeight?.(h)
    }
    aw.attachIconTo(panel.widget)
    // Add the foreground (step emojis) AFTER the icon so GtkOverlay stacks it
    // on top of the disc (later-added = on top). attachIconTo just added the
    // icon; without this the disc would cover the emojis. Continuous panels
    // have no foreground (null) — nothing to raise.
    if (panel.foreground) (panel.widget as any).add_overlay(panel.foreground)
    panel.handle.animateIn?.()
    attachPanelEscape(aw.window) // Escape cancels a held drag (keyboard bail)
    // The PanelHub force-closes the current panel when another applet opens —
    // but a menu-pinned panel (keepOpen, e.g. the wifi/bt pill next to its
    // GUI) must STAY open so the on/off/scan steps stay reachable
    // while browsing other applets. The hub calls this wrapper; the pin
    // suppresses the close. For continuous applets keepOpen is always absent,
    // so hubClose ≡ doClose.
    registerOpen(hubClose)
    // Panel fully opened — let the applet (and the dock row) react.
    opts.onPanelOpen?.()
    // Row keeper: any open panel on a revealed (parked) window keeps the
    // overflow session alive; also defers hides while the panel is open.
    aw.row?.setPanelOpen(aw.name, true)
  }

  /** Reverse a close in-place: called when the cursor re-enters the window
   *  while animateOut is running. Re-animates the EXISTING panel open from its
   *  current pillGrowth — no rebuild, so the icon stays put and the panel
   *  grows back up smoothly. */
  function reopen(): void {
    if (!panel || !closing) return
    // Invalidate any in-flight close so its finish() callback bails out.
    closing = false
    closeToken++
    panelOpen = true
    // animateIn picks up state.pillGrowth and reverses from there.
    panel.handle.animateIn?.()
    registerOpen(hubClose)
  }

  /** The PanelHub's close callback: closes the panel UNLESS it is menu-pinned. */
  function hubClose(): void {
    if (!opts.keepOpen?.()) doClose()
  }

  function doClose(instant = false): void {
    clearClose()
    if (!panelOpen) return
    panelOpen = false

    // Token guards finish() against stale invocation: if the panel is reopened
    // mid-close, the old animateOut's done callback sees a mismatched token and
    // bails instead of tearing down the now-reopened panel.
    const myToken = ++closeToken
    closing = true

    const finish = () => {
      if (myToken !== closeToken) return // superseded by a reopen — bail
      closing = false
      // Drop the panel-driven values back to unset: the draw trampoline then
      // falls back to the smoothed ringValue / its own defaults.
      render.value = undefined
      render.ringFill = undefined
      if (opts.draw.channels) render.skipDisc = undefined
      render.textValue = undefined
      aw.detachIcon()
      // Tear down the panel widget tree deterministically: detachIcon already
      // unparented the overlay (the icon is back on the window root), so
      // unparent() is a safe no-op that makes the intent explicit — GTK4 has no
      // widget destroy(); finalization is refcount/GC-based and the JS ref is
      // dropped below. Per-open trees must not linger until the next GC.
      panel?.widget.unparent()
      opts.onFinishReseed?.()
      refreshDraw()
      panel = null
      unregisterOpen(hubClose)
      releasePanelEscape()
      opts.onPanelClosed?.()
      aw.row?.setPanelOpen(aw.name, false)
    }

    if (panel?.handle.animateOut && !instant) {
      panel.handle.animateOut(finish)
    } else {
      finish()
    }
  }

  function maybeScheduleClose(): void {
    if (pointerInside || blockClose) return
    if (!panelOpen) return
    if (opts.keepOpen?.()) return
    clearClose()
    closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, opts.config.timing.leaveGrace, () => {
      closeTimer = null
      if (pointerInside || blockClose || !panelOpen || opts.keepOpen?.()) return GLib.SOURCE_REMOVE
      doClose()
      return GLib.SOURCE_REMOVE
    })
  }

  /** The leave-grace evaluation the tablet watchdog simulates on tabletCloseMs
   *  expiry: re-run the "cursor left the window" evaluation. NOT a full onLeave
   *  — it deliberately does NOT touch pointerInside (the real pointer state must
   *  be preserved: a stylus still hovering the panel keeps it open, exactly like
   *  laptop) and does NOT call row.cursorLeave (the row cascade is driven by the
   *  panel close: doClose → finish → setPanelOpen(false) → refreshSession, and
   *  for the overflow, onPanelClosed → endReveal → refreshSession; an
   *  unconditional cursorLeave would re-arm the overflowIdle collapse on every
   *  timer fire — a fan-out never collapses — and delete cursorInside keepers
   *  under a real resting pointer). The guards make it faithful: real pointer
   *  inside → no close; drag held (blockClose) → no close; keepOpen pin → no
   *  close. */
  function evaluateLeave(): void {
    maybeScheduleClose()
  }

  // ── Pointer handling: routed by the shared surface ──
  // The DockSurface routes enter/leave/motion/press GEOMETRICALLY to the
  // applet whose slot band contains the pointer (the input region is the
  // discs + stadium union, so the delivery boundary equals the drawn
  // geometry — the same per-applet window boundary).
  // The core registers its handlers instead of attaching window controllers.
  let mapArmed = true // false only during the post-map grace (see below)

  // ── Map-enter guard ──
  // The shared surface maps ONCE per dock generation; the guard covers that
  // single boot-time map (a fresh surface mapping under a resting pointer).
  ;(aw.window as any).connect("map", () => {
    mapArmed = false
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, opts.config.timing.leaveGrace), () => {
      mapArmed = true
      return GLib.SOURCE_REMOVE
    })
  })
  // A factory attaching to an ALREADY-mapped surface (late mount): no grace
  // needed — the surface has been up, enters are real.
  if ((aw.window as any).get_mapped?.()) mapArmed = true

  // Press-to-open fallback (touch): the dock opens panels on pointer ENTER
  // (hover-open). A touchscreen user cannot hover — and after a select-close
  // the emulated pointer can already be "inside" this applet's band, so no
  // new enter fires and the applet stays dead to touch until the pointer
  // leaves (touching elsewhere). A press is the touch analogue of hover-open:
  // tap a closed applet to open it. Guards: never while a panel is open (the
  // open panel's own gestures own presses) and never mid-close (let the close
  // finish, then a fresh tap opens a clean panel).
  aw.setPointerHandlers({
    onEnter,
    onLeave,
    onMotion,
    onPressOpen: (x: number, y: number) => {
      if (panelOpen || closing) return
      pressOpens++
      onEnter(x, y, true) // explicit tap: bypasses the map-enter guard
    },
  })

  // ── Map-guard debug hook (see MapGuardHook above) ──
  mapGuardHooks.set(aw.name, {
    name: aw.name,
    snapshot: () =>
      `${aw.name}: pointerInside=${pointerInside} mapArmed=${mapArmed} panelOpen=${panelOpen}` +
      ` suppressedEnters=${syntheticEnters} motionOpens=${motionOpens} pressOpens=${pressOpens} forceOpens=${forceOpens}`,
    repro: () => {
      const wasOpen = panelOpen
      // Restore the post-map condition exactly: pointer not inside, guard
      // unarmed (as the map handler leaves it), fresh counters.
      pointerInside = false
      mapArmed = false
      syntheticEnters = 0
      motionOpens = 0
      pressOpens = 0
      forceOpens = 0
      onEnter(4, 4) // the synthetic map-enter, through the REAL enter handler
      const suppressed = !panelOpen && pointerInside
      onMotion(5, 5) // the user's next real mouse twitch — the hole under test
      const openedByMotion = panelOpen
      if (openedByMotion) doClose(true) // the bug: clean up the opened panel
      // Undo the keeper side effects onEnter registered: cursorEnter put this
      // window into the row's cursorInside set — without the matching
      // cursorLeave the reveal session can never idle-collapse (hasKeeper
      // stays true forever).
      aw.row?.cursorLeave?.(aw.name)
      // Restore steady-state arming (the real map timer's end state).
      mapArmed = true
      pointerInside = false
      return (
        `${aw.name}: enterSuppressed=${suppressed} openedByMotion=${openedByMotion}` +
        ` suppressedEnters=${syntheticEnters} motionOpens=${motionOpens} (wasOpen=${wasOpen})`
      )
    },
  })

  // ── Icon draw: reads the render state's panel value/ring fill during
  //    animation, otherwise the smoothed ringValue (continuous) or 0 (step).
  //    `render.intro` alpha-fades the whole composition via a cairo group —
  //    disc, rings, glyph and text uniformly (no radial sweep). ──

  icon.set_draw_func((_, cr, w, h) => {
    const v = render.value ?? ringValue
    const rf = render.ringFill ?? 1
    // While the panel is open the pill paints the disc as part of its disc+fill
    // shape; skip the icon's own disc so it isn't painted twice (double-paint
    // doubles the alpha at the overlap → a bright seam). Cleared on close.
    const skipDisc = opts.draw.channels ? !!render.skipDisc : undefined
    // Step-quantized text value (== v when no step): for % text that should tick
    // in step increments while the slider glides on the float `v`. Cleared on close.
    const tv = opts.draw.channels ? (render.textValue ?? v) : undefined
    // Appear progress: the group is painted at `intro` alpha; 1 = steady state
    // (no group, zero overhead). The 9th DrawIcon param is passed 1 so the
    // applets' per-glyph intro multiplication doesn't double-fade.
    const intro = render.intro
    if (intro >= 1) {
      drawIcon(cr, w, h, v, opts.draw.state(), rf, skipDisc, tv)
    } else {
      cr.save()
      cr.pushGroup()
      drawIcon(cr, w, h, v, opts.draw.state(), rf, skipDisc, tv)
      cr.popGroupToSource()
      cr.paintWithAlpha(intro)
      cr.restore()
    }
  })

  opts.setupSubscriptions?.({ redraw: refreshDraw, sync: refreshAndSync })
  registerLeaveEval(evaluateLeave)
  onCleanup(() => {
    unregisterLeaveEval(evaluateLeave)
    clearRingAnim()
    mapGuardHooks.delete(aw.name)
  })

  return {
    externalChange: (v) => panel?.handle.onExternalChange?.(v),
    redraw: () => {
      panel?.foreground?.queue_draw()
      icon.queue_draw()
    },
    close: () => doClose(),
    closeInstant: () => doClose(true),
    forceOpen: () => {
      forceOpens++
      open()
    },
    setSpin: (index, active) => panel?.handle.setSpin?.(index, active),
  }
}
