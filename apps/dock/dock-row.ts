/**
 * dock/dock-row.ts — per-monitor dock row coordinator (the overflow feature).
 *
 * One instance per monitor, created by Dock() for each dock generation. Owns:
 *   - the ordered window list (config order) + the overflow window,
 *   - the visibility set: status rules reported by applets, overridden by the
 *     user's overflow MODE (auto | show | hide),
 *   - compact slot math + margin animation for hide/unhide reshuffles,
 *   - the overflow reveal session (temporary show of parked hidden icons),
 *   - move mode (dock → single overflow icon, drag-to-reposition, snap to the
 *     nearest of the 12 positions),
 *   - reveal-session keepers (overflow panel open, cursor inside a revealed
 *     window, any revealed window's panel open) + the overflowIdle timer.
 *
 * Layout model (per dock geometry):
 *   start/centre-aligned rows:  [visible…, overflow, hidden-parked…]
 *     — the visible block + overflow are positioned by rowOffsets (flush-start
 *       or centred); parked hidden windows continue after the overflow slot,
 *       invisible + click-through. Reveal makes them visible in place — the
 *       visible block never moves during a reveal/collapse.
 *   end-aligned rows (corner docks): [overflow, hidden-parked…, visible…]
 *     — the whole order is computed flush-end so the visible block pins to the
 *       screen edge and the reveal extends inboard (never off-screen).
 *
 * The overflow icon is ALWAYS visible (it is the feature's entry point: the
 * reveal, the mode selector, and move mode all live behind it). Position is
 * always in overflow by rule, so the hidden set is never empty in practice.
 *
 * Visibility is tri-state per the user's MODE (persisted in this module's own
 * state store — app `"dock"`, key `overflowMode`):
 *   auto — status rules apply (wifi/bt hidden when disabled, media when no
 *          player).
 *   show — every applet is forced visible.
 *   hide — every applet is forced into overflow.
 *
 * Move mode: the dock shrinks to just the overflow icon (ghost-fade of every
 * other window — a distinct pass, NOT doHide, so slots don't change), all
 * hover-panels are suppressed (including the overflow window's), and the
 * layout freezes (visibility changes record but don't apply). A double-click
 * on the overflow icon starts a drag (both margins follow the pointer); on
 * release the dock snaps to the nearest of the 12 POSITIONS — a different
 * position writes config + rebuilds (move mode dies with the row), the same
 * position exits move mode by restoring the grow-edge margin, draining
 * visibility drift, and un-ghosting. timing.moveModeTimeout is the escape
 * hatch. The overflow applet attaches the move gestures itself (via a
 * listener callback) so no gesture controller lingers in normal mode.
 *
 * Teardown: dispose() clears the row's timers/anims. Called by rebuildDocks
 * when a dock generation is destroyed (alongside the gnim scope disposal), so
 * no overflow timers leak into a dead generation.
 */

import GLib from "gi://GLib"
import { easeOutCubic, easeQuadInOut } from "@common/anim/easings"
import { type FrameRunner, runFrames } from "@common/anim/run-frames"
import type { AppletWindow } from "@common/applets/applet-window"
import {
  type DockGeometry,
  dockGeometry,
  overflowCaretAngles,
  POSITIONS,
  rowOffsets,
} from "@common/applets/layout"
import type { AppletSurface } from "@common/applets/surface/surface"
import { easeCubicIn } from "@common/applets/utils/appear"
import { ignore } from "@common/log/logger"
import { setScrimHoleProvider } from "@common/menus/menu-framework"
import { createStateStore } from "@common/state"
import { Astal } from "ags/gtk4"
import { config, dock } from "./config"
import { safeClone } from "./config-clone"

// CYCLE-BREAK: dock-row must NOT import
// rebuildDocks from ./Dock (./Dock imports createDockRow from HERE — a
// module cycle. Top-level (island) activation tolerates it, but a RUNTIME
// dynamic import() of the dock graph (the universal host entry) deadlocks on
// the async cycle and the instance never comes up. The edge is one-way:
// Dock.tsx hands its rebuildDocks across at module scope via setRebuildDocks
// (function declarations hoist, so the assignment is safe regardless of eval
// order) and the reference is resolved before any call.
let rebuildDocksRef: (() => void) | null = null
export function setRebuildDocks(fn: () => void): void {
  rebuildDocksRef = fn
}

const DBG = !!GLib.getenv("DOCK_DEBUG")

type OverflowMode = "auto" | "show" | "hide"

function isOverflowMode(v: unknown): v is OverflowMode {
  return v === "auto" || v === "show" || v === "hide"
}

/** The dock's persisted runtime state — the row's mode. */
export const dockState = createStateStore<"overflowMode">({
  app: "dock",
  version: 1,
  keys: { overflowMode: isOverflowMode },
})

/** Single-applet band dims [w, h]: one slot wide on the row axis, the FULL
 *  pill band on the grow axis (open panels need it — the surface's grow-axis
 *  extent is always layout.pillHeight). Move mode collapses the shared
 *  surface to exactly this extent and the snap math below must match it. */
export function windowDims(g: DockGeometry): [number, number] {
  const sz = config.layout.iconSize
  const lg = config.layout.pillHeight
  return g.growAxis === "y" ? [sz, lg] : [lg, sz]
}

/** Disc top-left within a single-applet surface — the icon sits flush at the
 *  grow edge. The move-mode snap compares per-position disc centres against
 *  the dragged one. w/h are the windowDims extents (w = grow axis for
 *  left/right docks). */
export function discOrigin(g: DockGeometry, w: number, h: number): [number, number] {
  const sz = config.layout.iconSize
  if (g.growAxis === "y") {
    return [0, g.growDir < 0 ? h - sz : 0]
  }
  return [g.growDir < 0 ? w - sz : 0, 0]
}

export interface DockRow {
  readonly dg: DockGeometry
  addWindow: (name: string, aw: AppletWindow<DockRow>) => void
  setOverflowWindow: (aw: AppletWindow<DockRow>) => void
  /** Compute slots and set initial margins (no animation); park hidden
   *  windows. Called once by Dock() after all windows + the overflow window
   *  are built. */
  initialLayout: () => void
  /** Applet status-driven rule: report whether `name` should be hidden. */
  setAppletHidden: (name: string, hidden: boolean) => void
  /** Hard kill switch: force `name` hidden REGARDLESS of the overflow MODE
   *  (even "show" cannot revive it) and keep it out of the overflow reveal
   *  fan-out. Tablet-driven — used by the workspaces + keyboard applets. */
  setAppletDeactivated: (name: string, deactivated: boolean) => void
  /** Applet window's panel open state (keeper + hide deferral). */
  setPanelOpen: (name: string, open: boolean) => void
  /** Cursor entered/left an applet window (reveal-session keepers). */
  cursorEnter: (name: string) => void
  cursorLeave: (name: string) => void
  /** Any interaction with an applet window resets the reveal idle timer. */
  noteInteraction: (name: string) => void
  /** The overflow applet's panel open state (reveal-session keeper). */
  setOverflowPanelOpen: (open: boolean) => void
  /** Hovering the overflow icon → show all parked hidden icons. */
  beginReveal: () => void
  /** The overflow panel closed → the session continues until the idle timer. */
  endReveal: () => void
  isRevealed: () => boolean
  /** The overflow MODE (auto | show | hide) — the pill's first three steps. */
  getMode: () => OverflowMode
  setMode: (m: OverflowMode) => void
  /** Move mode (the pill's fourth step). */
  isMoveMode: () => boolean
  enterMoveMode: () => void
  exitMoveMode: () => void
  /** Press begins the free drag — the icon is draggable immediately on
   *  entering move mode (no arming step). */
  beginMoveDrag: () => void
  /** Drag motion: window margins follow the pointer. */
  updateMoveDrag: (ox: number, oy: number) => void
  /** Release ends the drag: the window stays where it was dropped (move mode
   *  persists — the position is committed by the double-click). Returns true
   *  when a real drag happened. */
  endMoveDrag: () => boolean
  /** Double-click commit: snap to the nearest of the 12 positions (rebuild
   *  if changed, else exit move mode) and leave move mode. */
  commitMove: () => void
  /** Applet attention (the recording red-blink): when active, the row pulses
   *  `render.attention` (0..1) on the applet's icon while it's visible, or on
   *  the overflow caret while it's parked/hidden — the blink follows the
   *  applet between the dock and the overflow menu. */
  setAppletAttention: (name: string, active: boolean) => void
  /** Hide/show the whole dock (the screengrab settings' "Show dock" toggle):
   *  a visual ghost pass + click-through; the row state continues underneath
   *  and the dock returns to exactly what it was on show. */
  setDockVisible: (visible: boolean) => void
  /** The overflow applet registers a listener to attach/detach its move
   *  gestures (so no gesture controller lingers outside move mode). */
  setMoveModeListener: (cb: ((active: boolean) => void) | null) => void
  /** Test/debug hook: the overflow applet registers its panel force-open
   *  (`debug overflow panel`). */
  setPanelForceOpen: (fn: (() => void) | null) => void
  /** Force-open the overflow pill (`debug overflow panel`). */
  forceOpenPanel: () => void
  /** Swing the overflow caret back to its resting orientation during rebuild
   *  teardown (mirrors the retract sweep). Resolves immediately when the
   *  caret is already resting (or no overflow window). */
  teardownAnim: () => Promise<void>
  /** The overflow caret's live rotation (radians) — the overflow applet's draw
   *  routine reads it every frame. */
  overflowCaretRot: () => number
  /** Per-position overflow-icon disc centres + the live one + nearest — for
   *  `ags -i shell request "dock debug overflow snap-info"` (validates the move-mode snap
   *  math without a drag). */
  debugSnapInfo: () => string
  /** Compact state line for `ags -i shell request "dock debug overflow"`. */
  debugInfo: () => string
  dispose: () => void
}

export function createDockRow(
  _gdkmonitor: any,
  dg: DockGeometry,
  screenW: number,
  screenH: number,
  surface: AppletSurface,
): DockRow {
  const byName = new Map<string, AppletWindow<DockRow>>() // config order (insertion order)
  let overflowAw: AppletWindow<DockRow> | null = null

  const autoHidden = new Map<string, boolean>()
  const deactivated = new Map<string, boolean>()
  const panelOpen = new Set<string>()
  const cursorInside = new Set<string>()
  const pendingHide = new Set<string>() // hide deferred until panel closes
  const pendingVisible = new Set<string>() // unhide deferred until session collapses

  let mode: OverflowMode = "auto"
  let revealed = false
  let revealing = false // reveal/collapse animation in progress
  let overflowPanelOpen = false
  let collapseTimer: number | null = null
  let laidOut = false
  let disposed = false
  let sessionPromise: Promise<void> | null = null

  // Move mode state.
  let moveMode = false
  let moveDragging = false
  /** Free margins at drag begin (the reconstruction base for the drag math). */
  let moveDragBaseX = 0
  let moveDragBaseY = 0
  /** The dock position committed by the last drag-release (the magnet snap).
   *  Null until the user has dragged and released in this move session. */
  let moveSnapPos: string | null = null
  let moveTimeout: number | null = null
  // In-flight position write from endMoveDrag — commitMove awaits it so a
  // fast double-click rebuilds at the NEW position, not the stale one.
  let pendingMoveWrite: Promise<boolean> | null = null
  let moveModeListener: ((active: boolean) => void) | null = null
  let panelForceOpen: (() => void) | null = null

  // The magnet-snap fly (2D free-margin animation to the nearest dock point).
  interface FlyAnim {
    runner: FrameRunner | null
    active: boolean
  }
  let flyAnim: FlyAnim | null = null

  // Current animated row offsets (float; margins are rounded at write time).
  const currentOffsets = new Map<string, number>()

  // Overflow caret orientation (radians) — the angle applied to the caret
  // glyph by Overflow.tsx's drawIcon. Driven here because the reveal session
  // state machine owns the timing: resting→reveal on beginReveal, back on
  // collapse, synced to the parked icons' appear sweeps (same appearAnim
  // duration). Read by the applet through row.overflowCaretRot().
  const caretAngles = overflowCaretAngles(dg)

  interface RotAnim {
    runner: FrameRunner | null
    active: boolean
    /** Resolves the promise returned by animateCaretRot — called on completion
     *  AND on cancellation, so awaiters (enterMoveMode's session settle)
     *  never hang on an orphaned rotation run. */
    resolve?: () => void
  }
  let rotationAnim: RotAnim | null = null

  interface MarginAnim {
    aw: AppletWindow<DockRow>
    from: number
    to: number
    startUs: number
    durationUs: number
    runner: FrameRunner | null
    active: boolean
    ease: (t: number) => number
  }
  const marginAnims = new Map<string, MarginAnim>()

  // ── Visibility helpers ──

  /** The MODE overrides the status rules entirely.
   *  Deactivated applets are hidden REGARDLESS of the mode — the mode is
   *  only consulted for non-deactivated applets. */
  function effectiveHidden(name: string): boolean {
    if (deactivated.get(name)) return true
    if (mode === "show") return false
    if (mode === "hide") return true
    return autoHidden.get(name) ?? false
  }

  function hiddenNames(): string[] {
    return [...byName.keys()].filter((n) => effectiveHidden(n))
  }

  function visibleNames(): string[] {
    return [...byName.keys()].filter((n) => !effectiveHidden(n))
  }

  // ── Slot math ──

  /** Map every key ("name" | "overflow") → its row-axis offset for a given
   *  geometry, per the layout model in the file header. Hidden applets REST
   *  AT the overflow slot — they slide INTO the overflow icon on hide (their
   *  final position is always the overflow icon's own position, so the
   *  hide/unhide slide target never drifts) and emerge from it on unhide.
   *  While the reveal session is open (`revealed`) they fan out into their
   *  own column, away from the visible block, so the hidden icons are
   *  reachable without the visible row moving. The visibility set is the
   *  row's live state; the geometry is parameterized so the move-mode snap
   *  can compute where the overflow icon would sit at every position. */
  function computeOffsetsFor(dg2: DockGeometry, revealed = false): Map<string, number> {
    const m = new Map<string, number>()
    const sz = config.layout.iconSize
    const spacing = config.layout.spacing
    const hidden = hiddenNames()
    const visible = visibleNames()

    if (dg2.rowAlign === "end") {
      // Corner dock: overflow at the reading-order START of the flush-end
      // block, the visible block flush to the screen edge. Hidden windows
      // take no slots at rest — they sit under the overflow; while revealed
      // they fan out INBOARD of it (the visible block never moves).
      const total = visible.length + 1
      const offs = rowOffsets(dg2, total, screenW, screenH, config)
      m.set("overflow", offs[0])
      visible.forEach((n, i) => {
        m.set(n, offs[1 + i])
      })
      if (revealed) {
        // Deactivated applets never fan out (beginReveal excludes them) — do
        // NOT reserve reveal slots for them, or the spread leaves gaps where
        // they'd have sat.
        let next = offs[0] - (sz + spacing)
        hidden
          .filter((n) => !deactivated.get(n))
          .forEach((n) => {
            m.set(n, next)
            next -= sz + spacing
          })
      } else {
        hidden.forEach((n) => {
          m.set(n, offs[0])
        })
      }
      return m
    }

    // Start/centre: visible block + overflow positioned by rowOffsets
    // (flush-start or centred); hidden windows rest under the overflow (or
    // fan out after it while revealed).
    const visCount = visible.length + 1
    const visOffs = rowOffsets(dg2, visCount, screenW, screenH, config)
    visible.forEach((n, i) => {
      m.set(n, visOffs[i])
    })
    const ov = visOffs[visCount - 1]
    m.set("overflow", ov)
    if (revealed) {
      // Deactivated applets never fan out (beginReveal excludes them) — do
      // NOT reserve reveal slots for them, or the spread leaves gaps where
      // they'd have sat.
      let next = ov + (sz + spacing)
      hidden
        .filter((n) => !deactivated.get(n))
        .forEach((n) => {
          m.set(n, next)
          next += sz + spacing
        })
    } else {
      hidden.forEach((n) => {
        m.set(n, ov)
      })
    }
    return m
  }

  function computeOffsets(): Map<string, number> {
    return computeOffsetsFor(dg)
  }

  /** Point the shared surface at the applet's slot: one fixed.move + region
   *  re-issue (the discs track the moving icons), and band bookkeeping. */
  function setRowOffset(aw: AppletWindow<DockRow>, offset: number): void {
    surface.setSlot(aw.name, offset)
  }

  /** Defer any pending band shrink until the running animations settle. */
  function settleBand(): void {
    if (!moveMode) surface.settle()
  }

  /** Restore the window's grow-edge margin (the one that pins it to the screen
   *  edge) from config — the move-mode drag moves it freely. */
  function restoreGrowMargin(aw: AppletWindow<DockRow> | null): void {
    if (!aw) return
    const m = dg.margin
    const win = aw.window as any
    if (dg.growAxis === "y") {
      if (dg.growDir < 0) win.set_margin_bottom?.(m.bottom)
      else win.set_margin_top?.(m.top)
    } else if (dg.growDir < 0) win.set_margin_right?.(m.right)
    else win.set_margin_left?.(m.left)
  }

  // ── Margin animation ──

  function cancelMarginAnim(anim: MarginAnim): void {
    anim.active = false
    anim.runner?.cancel()
    anim.runner = null
  }

  function animateOffset(
    key: string,
    aw: AppletWindow<DockRow>,
    to: number,
    ease: (t: number) => number = easeQuadInOut,
    durationMs?: number,
  ): void {
    const existing = marginAnims.get(key)
    if (existing) cancelMarginAnim(existing)
    const from = currentOffsets.get(key) ?? 0
    currentOffsets.set(key, from)
    if (Math.abs(from - to) < 0.5) {
      currentOffsets.set(key, to)
      setRowOffset(aw, to)
      return
    }
    // Eager-extend: the shared surface must be resized to cover the animation
    // TARGET before the first slide frame, or the sliding icon clips at the
    // surface edge.
    surface.provisionSlot(key, to)
    const durationUs = Math.max(1, durationMs ?? config.timing.pillAnim) * 1000
    const startUs = GLib.get_monotonic_time()
    const anim: MarginAnim = { aw, from, to, startUs, durationUs, runner: null, active: true, ease }
    anim.runner = runFrames(
      aw.window,
      () => {
        const t = Math.min(1, (GLib.get_monotonic_time() - anim.startUs) / anim.durationUs)
        const v = anim.from + (anim.to - anim.from) * anim.ease(t)
        currentOffsets.set(key, v)
        setRowOffset(aw, v)
        if (t >= 1) {
          currentOffsets.set(key, anim.to)
          setRowOffset(aw, anim.to)
          anim.active = false // self-removed via the false return — runner no-ops
          marginAnims.delete(key)
          settleBand()
          return false
        }
        return true
      },
      config.timing.framerate,
    )
    marginAnims.set(key, anim)
  }

  /** Recompute every window's target offset and animate the shifts. */
  function recomputeAndAnimate(): void {
    const offs = computeOffsetsFor(dg, revealed)
    for (const [key, off] of offs) {
      const aw = key === "overflow" ? overflowAw : byName.get(key)
      if (!aw) continue
      animateOffset(key, aw, off)
    }
    if (DBG) {
      const summary = [...offs.entries()].map(([k, v]) => `${k}=${Math.round(v)}`).join(" ")
      print(`[overflow:row] offsets → ${summary}`)
    }
  }

  // ── Collapse timer / keepers ──

  function clearCollapseTimer(): void {
    if (collapseTimer !== null) {
      GLib.source_remove(collapseTimer)
      collapseTimer = null
    }
  }

  function hasKeeper(): boolean {
    if (overflowPanelOpen) return true
    for (const name of hiddenNames()) {
      if (panelOpen.has(name) || cursorInside.has(name)) return true
    }
    return false
  }

  function refreshSession(): void {
    if (disposed || moveMode) return
    clearCollapseTimer()
    if (!revealed || revealing) return
    if (hasKeeper()) return
    collapseTimer = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(0, config.timing.overflowIdle),
      () => {
        collapseTimer = null
        if (disposed || moveMode || !revealed || hasKeeper()) {
          refreshSession()
          return GLib.SOURCE_REMOVE
        }
        collapse()
        return GLib.SOURCE_REMOVE
      },
    )
  }

  // ── Overflow caret rotation (resting ↔ reveal-facing) ──

  /** The caret's live rotation (radians), read by the overflow applet's draw
   *  (Overflow.tsx via row.overflowCaretRot()). */
  let overflowRot = caretAngles.resting

  /** Set the caret rotation instantly (no animation). */
  function setCaretRot(rad: number): void {
    if (!overflowAw) return
    overflowRot = rad
    overflowAw.icon.queue_draw()
  }

  function cancelRotationAnim(): void {
    if (rotationAnim && rotationAnim.active) {
      rotationAnim.active = false
      rotationAnim.runner?.cancel()
      rotationAnim.runner = null
      // The run is superseded/cancelled — release any awaiter (e.g. move-mode
      // entry awaiting the reveal's Promise.all) instead of leaving it hung.
      rotationAnim.resolve?.()
    }
    rotationAnim = null
  }

  /** Animate the caret from its current rotation to `to` over appearAnim ms
   *  (cubic ease-out forward, ease-in reverse — mirrors the appear sweep
   *  curves so caret and sweeps read as one motion). Resolves when done. */
  function animateCaretRot(to: number, reverse: boolean): Promise<void> {
    if (!overflowAw) return Promise.resolve()
    const icon = overflowAw.icon
    const from = overflowRot
    if (DBG)
      print(`[overflow:rot] ${reverse ? "back" : "forward"} ${from.toFixed(3)} → ${to.toFixed(3)}`)
    if (Math.abs(to - from) < 0.001) return Promise.resolve()
    const duration = Math.max(0, config.timing.appearAnim)
    if (duration <= 0) {
      overflowRot = to
      icon.queue_draw()
      return Promise.resolve()
    }
    cancelRotationAnim()
    const ease = reverse ? easeCubicIn : easeOutCubic
    const startUs = GLib.get_monotonic_time()
    const durationUs = duration * 1000
    const anim: RotAnim = { runner: null, active: true }
    rotationAnim = anim
    return new Promise<void>((resolve) => {
      anim.resolve = resolve
      anim.runner = runFrames(
        overflowAw!.window,
        () => {
          const t = Math.min(1, (GLib.get_monotonic_time() - startUs) / durationUs)
          overflowRot = from + (to - from) * ease(t)
          icon.queue_draw()
          if (t >= 1) {
            overflowRot = to
            icon.queue_draw()
            anim.active = false // self-removed via the false return — runner no-ops
            rotationAnim = null
            resolve()
            return false
          }
          return true
        },
        config.timing.framerate,
      )
    })
  }

  function teardownAnim(): Promise<void> {
    return animateCaretRot(caretAngles.resting, true)
  }

  // ── Reveal session ──

  function beginReveal(): void {
    if (revealed || revealing || !dockVisible) return
    // Deactivated applets stay parked — they never fan out in the reveal
    // (hidden at all times until re-activated).
    const hidden = hiddenNames().filter((n) => !deactivated.get(n))
    if (hidden.length === 0) return
    revealed = true
    revealing = true
    if (DBG) print(`[overflow] BEGIN REVEAL: ${hidden.join(",")}`)
    const offs = computeOffsetsFor(dg, true)
    const anims: Promise<void>[] = hidden.map((name) => {
      const aw = byName.get(name)!
      aw.setHiddenState(false) // restore disc input region + unlock intro
      animateOffset(name, aw, offs.get(name)!, easeOutCubic) // spread fast
      return aw.playAppear(false, easeCubicIn) // fade in slow (transparent while stacked)
    })
    // Swing the caret to face the reveal direction, synced with the sweeps.
    anims.push(animateCaretRot(caretAngles.reveal, false))
    sessionPromise = Promise.all(anims).then(() => {
      revealing = false
      sessionPromise = null
      settleBand()
      refreshSession()
    })
  }

  function endReveal(): void {
    if (!revealed) return
    refreshSession()
  }

  function collapse(): void {
    if (!revealed || revealing) return
    revealed = false
    revealing = true
    // Deactivated applets were never fanned out — nothing to converge.
    const hidden = hiddenNames().filter((n) => !deactivated.get(n))
    if (DBG) print(`[overflow] COLLAPSE: ${hidden.join(",")}`)
    const offs = computeOffsetsFor(dg, false)
    const anims: Promise<void>[] = hidden.map(async (name) => {
      const aw = byName.get(name)!
      aw.setInputEmpty() // stop capturing input immediately
      // Fan back in: slide toward the overflow slot WHILE fading out. Both run
      // over appearOutAnim with the SAME cubic-out ease, so opacity and slide
      // progress stay anti-synced (they sum to 1): the icons remain spread
      // while opaque and converge only as they reach full transparency, so no
      // translucent discs pile at the slot (a sequenced fade-then-slide would
      // hide the slide entirely — a "fade out in place" with no fan-in).
      const slideMs = Math.max(config.timing.appearOutAnim, config.timing.pillAnim)
      animateOffset(name, aw, offs.get(name)!, easeOutCubic, slideMs)
      return aw.playAppear(true, easeOutCubic)
    })
    // Swing the caret back to resting, synced with the sweeps.
    anims.push(animateCaretRot(caretAngles.resting, true))
    sessionPromise = Promise.all(anims).then(() => {
      revealing = false
      sessionPromise = null
      // Park every effectively-hidden applet — including deactivated ones an
      // in-session hide left displayed. Deactivated applets never fan out, so
      // the anim list above excludes them; they still must be parked here or
      // they'd linger visible after the session.
      for (const name of hiddenNames()) {
        byName.get(name)?.setHiddenState(true) // finalize: lock intro + empty region
      }
      settleBand()
      applyPendingVisible()
    })
  }

  /** Applets whose status flipped visible mid-session move to the dock only
   *  after the session fully closes ("close fully before being eligible to
   *  fade out and reappear"). No-op in move mode — the exit drain reconciles. */
  function applyPendingVisible(): void {
    if (moveMode) return
    if (pendingVisible.size === 0) return
    const names = [...pendingVisible]
    pendingVisible.clear()
    for (const name of names) {
      if (effectiveHidden(name)) continue // flipped back to hidden — skip
      doUnhide(name)
    }
  }

  // ── Visibility changes ──

  /** Fade out + park a VISUALLY-visible applet that is effectively hidden,
   *  re-homing it to the overflow slot (non-revealed geometry) so it never
   *  lingers at a visible position. Used for deactivated applets an in-session
   *  hide left displayed, and stranded fan-out displays. Does NOT recompute
   *  the whole row (no fan-out collapse side effect). */
  function parkInPlace(name: string): void {
    const aw = byName.get(name)
    if (!aw || aw.isHiddenState()) return
    aw.setInputEmpty()
    void aw.playAppear(true).then(() => {
      if (effectiveHidden(name) && !moveMode) {
        const target = computeOffsetsFor(dg, false).get(name) ?? 0
        currentOffsets.set(name, target)
        setRowOffset(aw, target)
        aw.setHiddenState(true)
        settleBand()
      }
    })
  }

  function doHide(name: string): void {
    recomputeAndAnimate()
    const aw = byName.get(name)
    if (!aw) return
    if (revealed) {
      // Deactivated applets never belong in the fan-out — an in-session
      // deactivation parks them immediately (fade in place) instead of
      // keeping them visible until the session collapses.
      if (deactivated.get(name)) {
        parkInPlace(name)
        return
      }
      // In-session hide (auto rule fired while revealed): the icon stays
      // visible in the menu at its parked slot — pure slide, no fade.
      if (DBG) print(`[overflow] HIDE ${name} (in-session, slide only)`)
      return
    }
    if (DBG) print(`[overflow] HIDE ${name} (fade out)`)
    aw.setInputEmpty()
    void aw.playAppear(true).then(() => {
      if (effectiveHidden(name) && !moveMode) {
        aw.setHiddenState(true)
        settleBand()
      }
    })
  }

  function doUnhide(name: string): void {
    recomputeAndAnimate()
    const aw = byName.get(name)
    if (!aw) return
    if (revealed) {
      if (DBG) print(`[overflow] UNHIDE ${name} (in-session, slide only)`)
      return
    }
    // Dock ghosted (Show dock off): the hidden-state bookkeeping continues
    // underneath, but nothing re-appears — restoreDockVisuals reconciles the
    // visuals when the dock is shown again. Without this gate, any status
    // flip (media player appears, wifi reconnects…) popped the icon back.
    if (!dockVisible) return
    if (DBG) print(`[overflow] UNHIDE ${name} (sweep in)`)
    aw.setHiddenState(false)
    void aw.playAppear(false)
  }

  /** Route a visibility change with the deferral rules:
   *   - hide while the applet's panel is open → deferred to panel close,
   *   - unhide while the session is revealed → deferred to collapse,
   *   - any change while move mode is frozen → recorded only; the exit drain
   *     reconciles actual window state against effectiveHidden. */
  function applyVisibilityChange(name: string, nowHidden: boolean): void {
    if (moveMode) return
    if (nowHidden) {
      if (panelOpen.has(name)) {
        pendingHide.add(name)
        return
      }
      doHide(name)
    } else {
      if (revealed) {
        pendingVisible.add(name)
        return
      }
      doUnhide(name)
    }
  }

  // ── Public API ──

  function setAppletHidden(name: string, hidden: boolean): void {
    if (autoHidden.get(name) === hidden) return
    const prevEff = effectiveHidden(name)
    autoHidden.set(name, hidden)
    const newEff = effectiveHidden(name)
    if (prevEff === newEff) return // no effective change (mode overrides, or the
    // first registration matches the default)
    if (DBG) print(`[overflow] auto rule ${name} → ${hidden ? "hidden" : "visible"}`)
    if (!laidOut) return
    applyVisibilityChange(name, newEff)
  }

  function setAppletDeactivated(name: string, d: boolean): void {
    if (deactivated.get(name) === d) return
    const prevEff = effectiveHidden(name)
    deactivated.set(name, d)
    const newEff = effectiveHidden(name)
    if (DBG) print(`[overflow] deactivate ${name} → ${d ? "deactivated (hidden)" : "active"}`)
    if (!laidOut) return
    if (prevEff === newEff) {
      // Effective visibility unchanged — but if the applet is now effectively
      // hidden while still VISUALLY visible, park it (a deactivation can land
      // while an in-session hide left the applet displayed).
      if (newEff && !moveMode) {
        const aw = byName.get(name)
        if (aw && !aw.isHiddenState()) {
          if (panelOpen.has(name)) {
            pendingHide.add(name)
            return
          }
          doHide(name)
        }
      }
      return
    }
    applyVisibilityChange(name, newEff)
  }

  /** The band's keyboard interactivity follows the OPEN PANEL, never the
   *  surface's lifetime: the band itself is pointer-only, and a layer surface
   *  whose interactivity is not NONE takes the seat's keyboard focus the
   *  moment it maps (Hyprland CLayerSurface::onMap) and again on every pointer
   *  motion over it (InputManager mouseMoveUnified) — so a standing ON_DEMAND
   *  took the user's keys on every dock spawn, restart and rebuild. An open
   *  panel is the one state that needs them: its Escape drag-bail is the only
   *  key consumer here (see panel-framework `attachPanelEscape`). */
  function applyKeyboardInteractivity(wanted: boolean): void {
    const win = surface.window as any
    if (!win) return
    win.keymode = wanted ? Astal.Keymode.ON_DEMAND : Astal.Keymode.NONE
  }

  function setPanelOpen(name: string, open: boolean): void {
    if (open) panelOpen.add(name)
    else {
      panelOpen.delete(name)
      // Deferred hide (status flipped while the panel was open) applies now.
      if (pendingHide.has(name)) {
        pendingHide.delete(name)
        if (effectiveHidden(name) && !moveMode) doHide(name)
      }
    }
    applyKeyboardInteractivity(panelOpen.size > 0)
    refreshSession()
  }

  function cursorEnter(name: string): void {
    cursorInside.add(name)
    refreshSession()
  }

  function cursorLeave(name: string): void {
    cursorInside.delete(name)
    refreshSession()
  }

  function noteInteraction(name: string): void {
    if (!revealed || moveMode) return
    if (!effectiveHidden(name)) return
    refreshSession()
  }

  // ── MODE (auto | show | hide) ──

  function setMode(m: OverflowMode): void {
    if (mode === m) return
    const prev = new Map<string, boolean>()
    for (const name of byName.keys()) prev.set(name, effectiveHidden(name))
    mode = m
    saveMode()
    if (DBG) print(`[overflow] mode → ${m}`)
    if (!laidOut) return
    const toHide: string[] = []
    const toUnhide: string[] = []
    for (const name of byName.keys()) {
      const now = effectiveHidden(name)
      if (prev.get(name) !== now) (now ? toHide : toUnhide).push(name)
    }
    // Bulk hide (e.g. "Hide all"): fade the to-be-hidden discs out IN PLACE
    // and park them at their layout target invisibly — no margin slide
    // toward the overflow slot. N translucent discs converging on one slot
    // at once composited toward an opaque white blob at the overflow icon
    // ("the pile"). Single status-rule hides keep the slide-into-overflow
    // (one disc parking under the caret reads fine). The row compacts in
    // ONE pass over the final layout so the fading discs are never
    // re-targeted by later hides.
    if (toHide.length > 0) {
      // Applets with an open panel defer to pendingHide (drains via the
      // single-hide path on panel close — same as a status-rule hide).
      const hideNow = toHide.filter((n) => {
        if (panelOpen.has(n)) {
          pendingHide.add(n)
          return false
        }
        return true
      })
      // Applets ALREADY hidden in the previous mode (auto rules) are not in
      // toHide, but a live reveal session displays them fanned out — without
      // this they'd stay stranded on screen until the session idle-collapses
      // (the auto → hide-all stranding: everything else fades, the fan-out
      // lingers for the overflowIdle period).
      const alreadyHidden = [...byName.keys()].filter(
        (n) => prev.get(n) === true && effectiveHidden(n),
      )
      const wasRevealed = revealed
      // Hide-all ends the reveal session — unless an already-hidden applet's
      // panel is open (that keeper keeps the session alive; the collapse
      // parks it on panel close). Everything parks at the overflow slot, so
      // the final layout is computed with the session closed (the park
      // targets below must be the slot, not the fan-out).
      const sessionEnding = wasRevealed && !alreadyHidden.some((n) => panelOpen.has(n))
      if (sessionEnding) {
        revealed = false
        revealing = false
        clearCollapseTimer()
        void animateCaretRot(caretAngles.resting, true)
      }
      const offs = computeOffsetsFor(dg, revealed)
      for (const [key, off] of offs) {
        if (hideNow.includes(key) || alreadyHidden.includes(key)) continue
        const aw = key === "overflow" ? overflowAw : byName.get(key)
        if (aw) animateOffset(key, aw, off)
      }
      // Fade out in place + park invisibly at the layout target (the final
      // snap re-reads the target so a reveal slide-out starts from the slot).
      const park = (name: string): void => {
        const aw = byName.get(name)
        if (!aw) return
        const existing = marginAnims.get(name)
        if (existing) cancelMarginAnim(existing)
        aw.setInputEmpty()
        void aw.playAppear(true).then(() => {
          if (effectiveHidden(name) && !moveMode) {
            const target = computeOffsetsFor(dg, revealed).get(name) ?? 0
            currentOffsets.set(name, target)
            setRowOffset(aw, target)
            aw.setHiddenState(true)
            settleBand()
          }
        })
      }
      for (const name of hideNow) park(name)
      for (const name of alreadyHidden) {
        const aw = byName.get(name)
        if (!aw) continue
        if (!aw.isHiddenState() && deactivated.get(name)) {
          // Deactivated applets never belong in the fan-out — park one the
          // reveal-branch left displayed immediately, even mid-session (it
          // must not "stick around" when the mode hides everything).
          parkInPlace(name)
        } else if (sessionEnding && !aw.isHiddenState()) {
          // Was displayed in the fan-out — fade it out with the bulk hide.
          park(name)
        } else if (sessionEnding || !wasRevealed) {
          // Parked invisibly (or no session was ever open) — re-home it to
          // the new slot so the next reveal slide-out starts from it.
          const target = computeOffsetsFor(dg, false).get(name) ?? 0
          currentOffsets.set(name, target)
          setRowOffset(aw, target)
        }
        // Session alive with an open panel: leave the displayed ones until
        // the collapse parks them on panel close.
      }
      if (sessionEnding) applyPendingVisible()
    }
    for (const name of toUnhide) applyVisibilityChange(name, false)
  }

  function loadMode(): void {
    const m = dockState.get("overflowMode")
    if (isOverflowMode(m)) {
      mode = m
      if (DBG) print(`[overflow] loaded mode: ${m}`)
    }
  }

  function saveMode(): void {
    dockState.set("overflowMode", mode)
  }

  // ── Move mode ──

  /** The two margins that position the window freely (the row-axis margin and
   *  the grow-edge margin). The drag moves both so the window follows the
   *  pointer in 2D. */
  function freeMargins(): { xKey: "left" | "right"; yKey: "top" | "bottom" } {
    if (dg.growAxis === "y") {
      return { xKey: "left", yKey: dg.growDir < 0 ? "bottom" : "top" }
    }
    return { xKey: dg.growDir < 0 ? "right" : "left", yKey: "top" }
  }

  function getFreeMargin(key: "left" | "right" | "top" | "bottom"): number {
    const win = overflowAw!.window as any
    switch (key) {
      case "left":
        return win.get_margin_left?.() ?? 0
      case "right":
        return win.get_margin_right?.() ?? 0
      case "top":
        return win.get_margin_top?.() ?? 0
      case "bottom":
        return win.get_margin_bottom?.() ?? 0
    }
  }

  function setFreeMargin(key: "left" | "right" | "top" | "bottom", v: number): void {
    const win = overflowAw!.window as any
    const r = Math.round(v)
    switch (key) {
      case "left":
        win.set_margin_left?.(r)
        break
      case "right":
        win.set_margin_right?.(r)
        break
      case "top":
        win.set_margin_top?.(r)
        break
      case "bottom":
        win.set_margin_bottom?.(r)
        break
    }
  }

  function beginMoveDrag(): void {
    if (!moveMode || !overflowAw) return
    cancelMoveFly()
    // Do NOT mark moveDragging here: in GTK 4.22.4 GestureDrag::drag-begin
    // fires on PRESS (no threshold), so a plain click would be treated as a
    // drag. moveDragging is set in updateMoveDrag only once the pointer
    // actually moves past the dead zone. This is what keeps a click a click
    // (so the GestureClick double-click commit is reachable).
    clearMoveTimeout() // suspend the auto-exit while the button is held
    const { xKey, yKey } = freeMargins()
    moveDragBaseX = getFreeMargin(xKey)
    moveDragBaseY = getFreeMargin(yKey)
    if (DBG)
      print(
        `[move] beginMoveDrag base ${xKey}=${moveDragBaseX} ${yKey}=${moveDragBaseY} (not yet a drag)`,
      )
  }

  function updateMoveDrag(ox: number, oy: number): void {
    const ddz = config.appearance.thresholds.dragDeadZone
    if (!moveDragging && Math.abs(ox) <= ddz && Math.abs(oy) <= ddz) {
      if (DBG) print(`[move] updateMoveDrag (within dead zone, still a click) ox=${ox} oy=${oy}`)
      return
    }
    moveDragging = true
    // GestureDrag offsets are SURFACE-LOCAL: every margin step moves the
    // window under the pointer and shifts the surface coords by the same
    // amount. Reconstruct the pointer's SCREEN travel since the drag began
    // (k accounts for the far-edge margin keys whose screen position moves
    // OPPOSITE to the margin value):
    //   S = surface offset + k·(current margin - base margin)
    // Integrating the surface-local deltas instead made the margin command
    // cancel its own window motion every update — the icon never left the
    // begin point. S is applied 1:1 — the item follows the cursor exactly
    // (N cursor px → N item px); any gain factor would let the drag outrun the
    // cursor.
    const { xKey, yKey } = freeMargins()
    const kx = xKey === "right" ? -1 : 1
    const ky = yKey === "bottom" ? -1 : 1
    const sx = ox + kx * (getFreeMargin(xKey) - moveDragBaseX)
    const sy = oy + ky * (getFreeMargin(yKey) - moveDragBaseY)
    setFreeMargin(xKey, moveDragBaseX + sx * kx)
    setFreeMargin(yKey, moveDragBaseY + sy * ky)
    if (DBG) print(`[move] updateMoveDrag REAL sx=${sx.toFixed(0)} sy=${sy.toFixed(0)}`)
  }

  /** Inverse of overflowDiscCentreLive: the two free margins that place the
   *  disc centre at (cx, cy). */
  function freeMarginsForDiscCentre(cx: number, cy: number): { xVal: number; yVal: number } {
    const sz = config.layout.iconSize
    const [w, h] = windowDims(dg)
    const [dx, dy] = discOrigin(dg, w, h)
    let xVal: number, yVal: number
    if (dg.growAxis === "y") {
      xVal = cx - dx - sz / 2
      yVal = dg.growDir < 0 ? screenH - h + dy + sz / 2 - cy : cy - dy - sz / 2
    } else {
      yVal = cy - dy - sz / 2
      xVal = dg.growDir < 0 ? screenW - w + dx + sz / 2 - cx : cx - dx - sz / 2
    }
    return { xVal, yVal }
  }

  function cancelMoveFly(): void {
    if (flyAnim) {
      flyAnim.active = false
      flyAnim.runner?.cancel()
      flyAnim.runner = null
    }
    flyAnim = null
  }

  /** The magnet: fly the icon's free margins so its disc centre lands on
   *  `target` over timing.moveSnap ms (eased). */
  function flyTo(target: { x: number; y: number }): void {
    if (!overflowAw) return
    cancelMoveFly()
    const to = freeMarginsForDiscCentre(target.x, target.y)
    const { xKey, yKey } = freeMargins()
    const fromX = getFreeMargin(xKey)
    const fromY = getFreeMargin(yKey)
    const dur = Math.max(0, config.timing.moveSnap)
    if (dur <= 0 || (Math.abs(to.xVal - fromX) < 0.5 && Math.abs(to.yVal - fromY) < 0.5)) {
      setFreeMargin(xKey, to.xVal)
      setFreeMargin(yKey, to.yVal)
      return
    }
    const startUs = GLib.get_monotonic_time()
    const anim: FlyAnim = { runner: null, active: true }
    flyAnim = anim
    anim.runner = runFrames(
      overflowAw!.window,
      () => {
        const t = Math.min(1, (GLib.get_monotonic_time() - startUs) / (dur * 1000))
        const e = easeQuadInOut(t)
        setFreeMargin(xKey, fromX + (to.xVal - fromX) * e)
        setFreeMargin(yKey, fromY + (to.yVal - fromY) * e)
        if (t >= 1) {
          setFreeMargin(xKey, to.xVal)
          setFreeMargin(yKey, to.yVal)
          anim.active = false // self-removed via the false return — runner no-ops
          flyAnim = null
          return false
        }
        return true
      },
      config.timing.framerate,
    )
  }

  /** Nearest of the 12 positions to a point, plus its overflow disc centre. */
  function nearestDockPoint(cur: { x: number; y: number }): {
    pos: string
    centre: { x: number; y: number }
    dist: number
  } {
    let best = dg.position
    let bestCentre = overflowDiscCentreFor(dg)
    let bestDist = Infinity
    for (const p of POSITIONS) {
      const centre = overflowDiscCentreFor(dockGeometry(p, config))
      const d = Math.hypot(centre.x - cur.x, centre.y - cur.y)
      if (d < bestDist) {
        bestDist = d
        best = p
        bestCentre = centre
      }
    }
    return { pos: best, centre: bestCentre, dist: bestDist }
  }

  /** Drag-release = the COMMIT: magnet-snap the icon to the nearest dock
   *  point and persist the position immediately. Move mode persists — the
   *  double-click (or timing.moveModeTimeout) restores the full dock.
   *  Returns true only for a REAL drag (the pointer moved past the dead
   *  zone); a click returns false and re-arms the auto-exit. */
  function endMoveDrag(): boolean {
    if (!moveDragging) {
      if (DBG) print(`[move] endMoveDrag → click (not a drag); re-arm auto-exit`)
      armMoveTimeout()
      return false
    }
    moveDragging = false
    const cur = overflowDiscCentreLive()
    const snap = nearestDockPoint(cur)
    if (DBG)
      print(
        `[move] endMoveDrag → REAL drag; RELEASE commit → ${snap.pos} (${snap.dist.toFixed(0)}px)`,
      )
    moveSnapPos = snap.pos
    flyTo(snap.centre)
    // Persist "then and there": serialized through the shared config queue so
    // a later position change can't be clobbered on disk by this in-flight
    // write; skip the live apply only when a NEWER snap already queued its own
    // write (pendingMoveWrite was reassigned synchronously by that endMoveDrag,
    // so `pendingMoveWrite === write` is exactly the "still latest" test — the
    // position latched at row build is NOT, it never changes across the
    // session).
    const clone = safeClone(config)
    // snap.pos always names one of the 12 POSITIONS (nearestDockPoint loops
    // over POSITIONS) — the cast narrows the plain-string field to the
    // layout.position enum union from the config schema.
    clone.layout.position = snap.pos as (typeof POSITIONS)[number]
    const write = dock.queueWrite(clone)
    pendingMoveWrite = write
    void write.then((ok) => {
      if (ok && pendingMoveWrite === write) dock.applyToLive(clone)
      if (pendingMoveWrite === write) pendingMoveWrite = null
    })
    // Re-arm the auto-exit: without a double-click the dock leaves move mode
    // after timing.moveModeTimeout (applying the committed position).
    armMoveTimeout()
    return true
  }

  /** Double-click = exit move mode immediately. The position was already
   *  committed at release — rebuild at it if it changed, else restore in
   *  place. A double-click with no prior drag restores without moving.
   *  Waits for the release's queued config write to land first, so the
   *  rebuild reads the NEW position from live config (a fast double-click
   *  otherwise rebuilt at the stale position while the write was in flight). */
  async function commitMove(): Promise<void> {
    if (DBG) print(`[move] commitMove moveMode=${moveMode} moveSnapPos=${moveSnapPos}`)
    if (!moveMode) return
    cancelMoveFly()
    if (moveSnapPos && moveSnapPos !== dg.position) {
      if (pendingMoveWrite) await pendingMoveWrite.catch((e) => ignore("move-mode config write", e))
      // Exit the move state + detach the move gestures BEFORE the rebuild's
      // async teardown. Without this the dying windows keep their controllers
      // attached through the reverse-appear, and an event dispatch on a dying
      // window reads a controller that the destroy + gnim scope dispose free —
      // the gtk_event_controller_get_propagation_phase UAF. moveMode=false also turns the gesture handlers into
      // no-ops for the teardown window.
      clearMoveTimeout()
      detachForRebuild()
      return
    }
    exitMoveMode()
  }

  function clearMoveTimeout(): void {
    if (moveTimeout !== null) {
      GLib.source_remove(moveTimeout)
      moveTimeout = null
    }
  }

  function armMoveTimeout(): void {
    clearMoveTimeout()
    moveTimeout = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(0, config.timing.moveModeTimeout),
      () => {
        moveTimeout = null
        if (moveMode && !moveDragging) {
          // Auto-exit: apply any committed position, then restore the dock.
          // Same detach-before-teardown as commitMove's rebuild branch — the
          // timeout fires while the cursor may still be over the dock, so the
          // dying windows must not keep their move controllers attached.
          if (moveSnapPos && moveSnapPos !== dg.position) {
            detachForRebuild()
          } else exitMoveMode()
        }
        return GLib.SOURCE_REMOVE
      },
    )
  }

  /** Exit move state + detach the move gestures BEFORE a rebuild's async
   *  teardown — the dying windows must not keep their controllers attached
   *  through the reverse-appear (shared by commitMove and the auto-exit
   *  timeout). */
  function detachForRebuild(): void {
    moveMode = false
    moveDragging = false
    moveModeListener?.(false)
    rebuildDocksRef?.()
  }

  function enterMoveMode(): void {
    if (moveMode) return
    moveMode = true
    moveDragging = false
    moveSnapPos = null
    if (DBG) print(`[overflow] MOVE MODE ON`)
    clearCollapseTimer()
    cancelRotationAnim()
    cancelMoveFly()
    setCaretRot(caretAngles.resting)
    // Freeze the layout: no margin anims may move windows under the drag.
    for (const anim of marginAnims.values()) cancelMarginAnim(anim)
    marginAnims.clear()
    moveModeListener?.(true)
    void (async () => {
      // Settle any in-flight reveal/collapse before the ghost-fade (a
      // completion's applyPendingVisible would otherwise animate mid-freeze).
      if (sessionPromise) await sessionPromise.catch((e) => ignore("move-mode reveal session", e))
      if (!moveMode) return
      // The session is over; the ghost-fade is the visual close. Deferred
      // transitions are moot — the exit drain reconciles from live state.
      revealed = false
      revealing = false
      pendingVisible.clear()
      pendingHide.clear()
      for (const [, aw] of byName) {
        aw.setInputEmpty()
        // Park AFTER the ghost-fade completes: a parked icon LEAVES the
        // Gtk.Fixed (setEntryHidden), and the collapse below can only take
        // effect once no off-band icon pins the fixed's minimum size.
        void aw.playAppear(true).then(() => {
          if (moveMode && !disposed) aw.setHiddenState(true)
        })
      }
      // Collapse the shared surface to the single overflow icon (one resize);
      // the drag then moves its two free layer margins.
      surface.collapseToSlot("overflow")
      armMoveTimeout()
    })()
  }

  function exitMoveMode(): void {
    if (!moveMode) return
    moveMode = false
    moveDragging = false
    moveSnapPos = null
    if (DBG) print(`[overflow] MOVE MODE OFF`)
    clearMoveTimeout()
    cancelMoveFly()
    moveModeListener?.(false)
    // Unfreeze the band BEFORE the restore recompute (the frozen collapse
    // pinned it to the overflow slot).
    surface.setBandFrozen(false)
    // Restore the grow-edge margin the free drag moved (recomputeAndAnimate
    // only restores the row-axis margin).
    restoreGrowMargin(overflowAw)
    // Reconcile the frozen layout: final slot margins + visual states — the
    // visibility drain (auto rules may have drifted while frozen).
    recomputeAndAnimate()
    for (const [name, aw] of byName) {
      if (effectiveHidden(name)) {
        aw.setHiddenState(true)
      } else if (dockVisible) {
        aw.setHiddenState(false)
        void aw.playAppear(false)
      }
      // Ghosted (Show dock off): leave the visible windows parked;
      // restoreDockVisuals reconciles them on show.
    }
    settleBand()
    refreshSession()
  }

  /** The overflow window's current on-screen disc centre (the move drag's
   *  release reference). */
  function overflowDiscCentreLive(): { x: number; y: number } {
    const win = overflowAw!.window as any
    const sz = config.layout.iconSize
    const [w, h] = windowDims(dg)
    const ml = win.get_margin_left?.() ?? 0
    const mt = win.get_margin_top?.() ?? 0
    const mr = win.get_margin_right?.() ?? 0
    const mb = win.get_margin_bottom?.() ?? 0
    let wx: number, wy: number
    if (dg.growAxis === "y") {
      wx = ml
      wy = dg.growDir < 0 ? screenH - mb - h : mt
    } else {
      wx = dg.growDir < 0 ? screenW - mr - w : ml
      wy = mt
    }
    const [dx, dy] = discOrigin(dg, w, h)
    return { x: wx + dx + sz / 2, y: wy + dy + sz / 2 }
  }

  /** Where the overflow icon's disc centre would sit at a given position,
   *  given the current visibility set. */
  function overflowDiscCentreFor(dg2: DockGeometry): { x: number; y: number } {
    const sz = config.layout.iconSize
    const offs = computeOffsetsFor(dg2)
    const slot = offs.get("overflow") ?? 0
    const [w, h] = windowDims(dg2)
    const m = dg2.margin
    let wx: number, wy: number
    if (dg2.growAxis === "y") {
      wx = slot
      wy = dg2.growDir < 0 ? screenH - m.bottom - h : m.top
    } else {
      wy = slot
      wx = dg2.growDir < 0 ? screenW - m.right - w : m.left
    }
    const [dx, dy] = discOrigin(dg2, w, h)
    return { x: wx + dx + sz / 2, y: wy + dy + sz / 2 }
  }

  // ── Applet attention (the recording red-blink) ──

  const attention = new Map<string, boolean>()
  interface AttentionTick {
    runner: FrameRunner | null
    active: boolean
  }
  let attentionTick: AttentionTick | null = null
  let attentionLastTarget: AppletWindow<DockRow> | null = null

  function attentionActive(): boolean {
    for (const v of attention.values()) if (v) return true
    return false
  }

  /** Where the blink lives: the applet's icon while its window is visible
   *  (visible block OR revealed in the session), else the overflow caret
   *  (parked, or the whole dock is in move mode / hidden). */
  function attentionTarget(): AppletWindow<DockRow> | null {
    if (moveMode) return overflowAw
    for (const [name, active] of attention) {
      if (!active) continue
      const aw = byName.get(name)
      if (!aw) continue
      if (!effectiveHidden(name) || revealed) return aw
      return overflowAw ?? aw
    }
    return null
  }

  /** Clear the blink target's attention value (stop the blink wherever it was). */
  function clearAttentionTarget(): void {
    if (attentionLastTarget) {
      attentionLastTarget.render.attention = 0
      attentionLastTarget.icon.queue_draw()
      attentionLastTarget = null
    }
  }

  function stopAttentionTick(): void {
    if (attentionTick) {
      attentionTick.active = false
      attentionTick.runner?.cancel()
      attentionTick.runner = null
      attentionTick = null
    }
    clearAttentionTarget()
  }

  function ensureAttentionTick(): void {
    if (attentionTick) return
    const startUs = GLib.get_monotonic_time()
    const periodUs = Math.max(1, config.timing.recordingBlink) * 1000
    const anim: AttentionTick = { runner: null, active: true }
    attentionTick = anim
    const step = (): boolean => {
      if (!attentionActive()) {
        // Self-stop: clear the target, let the `return false` self-remove.
        clearAttentionTarget()
        anim.active = false
        attentionTick = null // self-removed via the false return — runner no-ops
        return false
      }
      const t = (GLib.get_monotonic_time() - startUs) / periodUs
      const pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * t)
      if (DBG) print(`[attention] t=${t.toFixed(2)} pulse=${pulse.toFixed(3)}`)
      const target = attentionTarget()
      if (target !== attentionLastTarget) {
        clearAttentionTarget()
        attentionLastTarget = target
      }
      if (target) {
        target.render.attention = pulse
        target.icon.queue_draw()
      }
      return true
    }
    anim.runner = runFrames(overflowAw!.window, step, config.timing.framerate)
  }

  function setAppletAttention(name: string, active: boolean): void {
    attention.set(name, active)
    if (active) ensureAttentionTick()
    else if (!attentionActive()) stopAttentionTick()
  }

  // ── Dock visibility (the screengrab settings' "Show dock" toggle) ──

  let dockVisible = true

  /** Reconcile every window's visual state against the live effective set
   *  (used on dock re-show and move-mode exit — the visibility drain). */
  function restoreDockVisuals(): void {
    recomputeAndAnimate()
    for (const [name, aw] of byName) {
      if (effectiveHidden(name)) aw.setHiddenState(true)
      else {
        aw.setHiddenState(false)
        void aw.playAppear(false)
      }
    }
    if (overflowAw) {
      overflowAw.setHiddenState(false)
      void overflowAw.playAppear(false)
    }
    settleBand()
  }

  function setDockVisible(visible: boolean): void {
    if (dockVisible === visible) return
    dockVisible = visible
    if (DBG) print(`[overflow] dock visible → ${visible}`)
    if (visible) {
      restoreDockVisuals()
      refreshSession()
    } else {
      // Ghost the whole dock (visual hide + click-through). The session is
      // force-closed — the ghost covers the visual; the row state (mode,
      // auto rules) continues underneath and restoreDockVisuals reconciles.
      revealed = false
      revealing = false
      pendingVisible.clear()
      pendingHide.clear()
      clearCollapseTimer()
      ghostAll()
    }
  }

  /** Park every window invisible (intro suppressed + alpha 0 + empty input).
   *  Uses setHiddenState, NOT playAppear(true): the intro suppression stops a
   *  window that maps AFTER the ghost (the overflow caret, late applets at
   *  boot) from auto-playing its birth appear — playAppear only fades
   *  already-appeared windows, so a boot-time ghost would let late-mapping
   *  windows pop straight back in. */
  function ghostAll(): void {
    for (const [, aw] of byName) aw.setHiddenState(true)
    if (overflowAw) overflowAw.setHiddenState(true)
  }

  // ── Boot / teardown ──

  function initialLayout(): void {
    laidOut = true
    const offs = computeOffsets()
    for (const [key, off] of offs) {
      const aw = key === "overflow" ? overflowAw : byName.get(key)
      if (!aw) continue
      currentOffsets.set(key, off)
      setRowOffset(aw, off)
    }
    // Park hidden windows: invisible (intro 0, birth intro suppressed) +
    // click-through. Async auto rules (wifi/bt/media polls) animate in after
    // boot; Position is synchronous so it parks from the first frame.
    for (const name of hiddenNames()) {
      byName.get(name)?.setHiddenState(true)
    }
    setCaretRot(caretAngles.resting)
    // The band was provisioned slot by slot above; apply the settled extent
    // (the parked applets don't count) once before the surface ever maps.
    surface.settle()
    if (DBG)
      print(
        `[overflow:row] initial layout: ${[...offs.entries()].map(([k, v]) => `${k}=${Math.round(v)}`).join(" ")}`,
      )
    // Apply the persisted mode — one microtask later so this synchronous
    // initial layout settles first — then recompute the layout for it.
    void Promise.resolve().then(() => {
      loadMode()
      const offs2 = computeOffsets()
      for (const [key, off] of offs2) {
        const aw = key === "overflow" ? overflowAw : byName.get(key)
        if (!aw) continue
        // Cancel any in-flight margin animation first — this direct write must
        // win. Without it, a concurrent auto-rule recompute (media/screengrab
        // parking) can leave orphaned animations that complete AFTER this write
        // and re-clobber these windows with stale slots.
        const existing = marginAnims.get(key)
        if (existing) cancelMarginAnim(existing)
        currentOffsets.set(key, off)
        setRowOffset(aw, off)
      }
      // Reconcile the visual states for the applied mode: park the hidden, and
      // restore any applet a pre-mode auto-rule recompute parked while the
      // persisted mode was still unknown (e.g. mode=show makes media/screengrab
      // visible again — they must actually appear, not stay invisible ghosts).
      for (const [name, aw] of byName) {
        if (effectiveHidden(name)) {
          aw.setHiddenState(true)
        } else if (dockVisible && aw.isHiddenState()) {
          aw.setHiddenState(false)
          void aw.playAppear(false)
        }
      }
      settleBand()
    })
  }

  function debugSnapInfo(): string {
    if (!overflowAw) return "no overflow window"
    const cur = overflowDiscCentreLive()
    const lines: string[] = [`live=(${cur.x.toFixed(0)},${cur.y.toFixed(0)})`]
    let best = dg.position
    let bestDist = Infinity
    for (const p of POSITIONS) {
      const c = overflowDiscCentreFor(dockGeometry(p, config))
      const d = Math.hypot(c.x - cur.x, c.y - cur.y)
      lines.push(`${p}=(${c.x.toFixed(0)},${c.y.toFixed(0)}) d=${d.toFixed(0)}`)
      if (d < bestDist) {
        bestDist = d
        best = p
      }
    }
    lines.push(`nearest=${best} (${bestDist.toFixed(0)}px)`)
    return lines.join("\n")
  }

  function debugInfo(): string {
    const hidden = hiddenNames()
    const offStr = [...currentOffsets.entries()].map(([k, v]) => `${k}=${Math.round(v)}`).join(" ")
    return [
      `pos=${dg.position}`,
      `mode=${mode}`,
      `moveMode=${moveMode} dragging=${moveDragging}`,
      `revealed=${revealed} revealing=${revealing}`,
      `overflowPanel=${overflowPanelOpen}`,
      `hidden=[${hidden.join(",")}]`,
      `pendingVisible=[${[...pendingVisible].join(",")}]`,
      `cursorInside=[${[...cursorInside].join(",")}]`,
      `panelOpenSet=[${[...panelOpen].join(",")}]`,
      `offsets=${offStr}`,
    ].join(" | ")
  }

  function dispose(): void {
    disposed = true
    moveMode = false
    moveDragging = false
    attention.clear()
    stopAttentionTick()
    clearCollapseTimer()
    clearMoveTimeout()
    cancelMoveFly()
    cancelRotationAnim()
    for (const anim of marginAnims.values()) cancelMarginAnim(anim)
    marginAnims.clear()
    pendingHide.clear()
    pendingVisible.clear()
    moveModeListener = null
  }

  // The click-off dismissal scrim's keepOpen exception: while a wifi/bt menu
  // is open, that applet must stay interactive (its on/off/scan steps
  // are meant to be used in tandem with the menu). Report the applet's
  // monitor-relative rect from the row math: the absolute slot (row axis) +
  // the grow-edge margin (grow axis), extent iconSize × pillHeight — the same
  // band the shared surface hosts the applet (or its open panel) in.
  setScrimHoleProvider((kind) => {
    const aw = kind === "wifi" || kind === "bluetooth" ? byName.get(kind) : null
    if (!aw) return null
    try {
      const slot = surface.slotOf(aw.name)
      const sz = config.layout.iconSize
      const ph = config.layout.pillHeight
      if (dg.growAxis === "y") {
        return {
          x: Math.round(slot),
          y: dg.growDir < 0 ? Math.round(screenH - dg.margin.bottom - ph) : dg.margin.top,
          w: sz,
          h: ph,
        }
      }
      return {
        x: dg.growDir < 0 ? Math.round(screenW - dg.margin.right - ph) : dg.margin.left,
        y: Math.round(slot),
        w: ph,
        h: sz,
      }
    } catch (e) {
      ignore("dock row slot geometry", e)
      return null
    }
  })

  const row: DockRow = {
    dg,
    addWindow: (name, aw) => {
      byName.set(name, aw)
      // A window registered after the ghost (the overflow caret is created
      // after the screengrab applet's mount) must park immediately, or its
      // birth intro plays it straight back into view.
      if (!dockVisible) aw.setHiddenState(true)
    },
    setOverflowWindow: (aw) => {
      overflowAw = aw
      if (!dockVisible) aw.setHiddenState(true)
    },
    initialLayout,
    setAppletHidden,
    setAppletDeactivated,
    setPanelOpen,
    cursorEnter,
    cursorLeave,
    noteInteraction,
    setOverflowPanelOpen: (open) => {
      overflowPanelOpen = open
      refreshSession()
    },
    beginReveal,
    endReveal,
    isRevealed: () => revealed,
    getMode: () => mode,
    setMode,
    isMoveMode: () => moveMode,
    enterMoveMode,
    exitMoveMode,
    beginMoveDrag,
    updateMoveDrag,
    endMoveDrag,
    commitMove,
    setAppletAttention,
    setDockVisible,
    setMoveModeListener: (cb) => {
      moveModeListener = cb
    },
    setPanelForceOpen: (fn) => {
      panelForceOpen = fn
    },
    forceOpenPanel: () => panelForceOpen?.(),
    teardownAnim,
    overflowCaretRot: () => overflowRot,
    debugSnapInfo,
    debugInfo,
    dispose,
  }

  return row
}
