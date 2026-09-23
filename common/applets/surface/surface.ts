/**
 * surface.ts — the SHARED applet surface: ONE renderer for every applet row.
 *
 * The dock (layer-shell band) and the greeter strip (embedded widget) both
 * mount this module and differ only in their substrate (see host.ts) — the
 * widget substrate, the compositor surface and the transport, never the
 * rendering. Everything below is substrate-independent and host-agnostic; the
 * live config arrives as a parameter.
 *
 * Structure (the renderer's own widget tree, mounted through the host port):
 *   Gtk.Fixed "rowHost" — the substrate's child
 *   ├── the pill backdrop DrawingArea (first child = bottom z-order)
 *   ├── icon DrawingAreas (one per applet, at slot positions)
 *   └── open panel Gtk.Overlays (one per open panel, at its slot)
 *
 * Geometry — ONE band engine: the grow-axis extent is CONSTANT
 * `layout.pillHeight` (the extra band hosts open panels; opening a panel never
 * resizes the row). The backdrop paints the icon strip at iconSize height,
 * flush at the icons' grow edge, tracked per frame to the LIVE slot union
 * (syncBackdropDraw) so its edges move with the applets, plus a pillHeight
 * stadium behind every open panel. The row-axis extent is the union band of
 * the displayed entries:
 *   - extend BEFORE a slide-out animation reaches beyond the current bounds
 *     (provisionSlot is called with the animation TARGET before the first
 *     animation frame), one resize at animation start;
 *   - shrink AFTER the animation settles (settle(), called at every
 *     animation/session completion) — never per frame (a per-frame resize
 *     makes the compositor re-evaluate the pointer every frame, the
 *     documented swallowed-click class of bugs);
 *   - collapseToSlot/setBandFrozen pin the band to one slot (move mode's
 *     collapsed drag handle) — the POLICY that calls them is the dock row's.
 * The row-axis margin (the band start) goes to the substrate (setRowStart).
 *
 * Backdrop paint (the frozen acceptance values): the base glass
 * (`appearance.backdrop`) over the strip + open-panel stadiums in ONE path/one
 * fill, then the LIFT (`draw-utils` backdropLiftColour) over the strip only,
 * with a hole at every disc that sits on it and never under an open panel. A
 * disc therefore composites over the base, never over the lift — its rendered
 * colour is independent of the bar's tone.
 *
 * Input region: the union of the visible discs + the open panels' stadiums +
 * the row band a bar-like substrate absorbs (common/applets/utils/row-region.ts
 * owns the shape model), re-issued whenever the geometry actually changes
 * (gated on a serialized spec comparison) and applied by the host (a layer
 * surface sets it on its wl_surface; a widget substrate uses GTK pick).
 * Everything else stays click-through.
 *
 * The SAME compiled region is the router's capture lock (`captureAt` /
 * `hit`) — see the Input region section below: a substrate that cannot install
 * a wl_surface region delivers the pointer across its whole row rect, so the
 * renderer enforces the capture geometry itself instead of trusting delivery.
 *
 * Event model: closed icons keep can_target=false, so presses land on the
 * host's pointer source; the shared router maps enter/leave/motion/press
 * GEOMETRICALLY to the applet whose slot band contains the pointer (slot range
 * on the row axis, full pillHeight band on the grow axis — the same
 * whole-applet boundary a per-applet window had). Panel-internal gestures are
 * unchanged: the pill DrawingArea stays the pick target inside the overlay
 * (pill → overlay → host pick chain).
 */

import GLib from "gi://GLib"
import { type AppletHoverHandlers, type AppletPointerHandlers } from "@common/applets/applet-window"
import { drawPillBackdrop } from "@common/applets/backdrop"
import type { AppletConfig } from "@common/applets/config"
import type { DockGeometry } from "@common/applets/layout"
import { backdropLiftColour, setDiscOverBackdrop } from "@common/applets/shared/draw-utils"
import {
  bandCaptureShape,
  type CairoRegion,
  type CaptureAxes,
  type CaptureRegion,
  type CaptureShape,
  compileCaptureRegion,
  newRegion,
  panelCaptureShape,
} from "@common/applets/utils/row-region"
import { ignore } from "@common/log/logger"
import { Gtk } from "ags/gtk4"
import type { AppletSurfaceHost } from "./host"

const DBG = !!GLib.getenv("DOCK_DEBUG")

// The renderer always paints the pill backdrop beneath the discs, and
// over-compositing would stack the alphas: a disc's composite would read more
// opaque than its configured alpha. Latch the compensation HERE — it belongs
// to the renderer that paints the backdrop, not to each host's module scope.
setDiscOverBackdrop(true)

/** One hosted applet's render state inside the surface. */
interface SurfaceEntry {
  name: string
  icon: Gtk.DrawingArea
  /** The open panel overlay (null when the panel is closed). */
  overlay: Gtk.Overlay | null
  /** The panel pill's current grown extent (oh) — drives the stadium REGION. */
  panelOh: number
  /** Latched stadium extent for the INPUT REGION: grows with the panel, but
   *  never shrinks mid-close. The paint reads the LIVE panelOh (so the
   *  expanded-applet backdrop eases down with the pill), while the region
   *  stays at its last open-frame extent until detach — re-issuing a shrinking
   *  region per close-frame would make the compositor re-evaluate the pointer
   *  under the finger (the swallowed-click race). */
  regionOh: number
  /** Parked hidden state (invisible + excluded from band + region). */
  hidden: boolean
  /** Input suppression during a hide/collapse fade (excluded from region,
   *  still counts for the band until parked). */
  suppressed: boolean
  /** Absolute slot position on the row axis (screen coords, from rowOffsets). */
  slot: number
  /** Routed handlers. enter/leave/motion are LISTS (the applet core owns the
   *  primary set via setPointerHandlers). */
  onEnter: ((x: number, y: number) => void)[]
  onLeave: (() => void)[]
  onMotion: ((x: number, y: number) => void)[]
  /** Indicator-level hover listeners (addHoverListener — e.g. the overflow
   *  clock): delivered on EVERY routed enter regardless of open suppression
   *  (the leaveGrace gates panel opens, not pure hover indicators), with a
   *  matching onHoverLeave on every hoverTarget transition — no stuck state. */
  onHoverEnter: ((x: number, y: number) => void)[]
  /** Pairwise indicator-level leave (addHoverListener). Kept in its own array
   *  (like onHoverEnter) so setPointerHandlers replacing onLeave — which the
   *  applet core owns — never clobbers an indicator's onHoverLeave. Without
   *  this split, an indicator registered before the core's setPointerHandlers
   *  saw its leave handler erased, and clock/hover state latched true
   *  forever. */
  onHoverLeave: (() => void)[]
  onPressOpen: ((x: number, y: number) => void)[]
  onMap: (() => void)[]
}

/** Router snapshot for `dock debug overflow route` (per-surface replay). */
interface SurfaceRouteState {
  name: string
  active: boolean
  hoverTarget: string | null
  bd: [number, number]
  bandLen: number
  bandApplied: [number, number]
  panels: { name: string; slot: number; oh: number; regionOh: number }[]
}

export interface AppletSurface {
  /** The substrate's window (the applet bindings hand it to the applet cores). */
  readonly window: Gtk.Window
  readonly dg: DockGeometry
  /** The live config view every paint and timing read uses. */
  readonly config: AppletConfig
  /** Register an applet entry (called by createSurfaceApplet). */
  addEntry: (name: string, icon: Gtk.DrawingArea, onMap: () => void) => void
  /** Replace the routed handler set for an applet (the applet core). */
  setPointerHandlers: (name: string, handlers: AppletPointerHandlers) => void
  /** Append indicator-level hover listeners for an applet (e.g. the overflow
   *  clock). Delivered on every routed enter — NOT gated by the open
   *  suppression grace; onLeave always fires on the hover transition. */
  addHoverListener: (name: string, handlers: AppletHoverHandlers) => void
  /** Set an entry's absolute slot; moves the icon in the row. */
  setSlot: (name: string, absSlot: number) => void
  /** The row coordinator calls this with an animation TARGET before the slide
   *  starts: eager-extends the band to cover the target without moving the
   *  icon. */
  provisionSlot: (name: string, absSlot: number) => void
  /** Park/unpark an entry (invisible + out of band + out of region). */
  setEntryHidden: (name: string, hidden: boolean) => void
  /** Region-only input suppression (hide/collapse fade). */
  setEntrySuppressed: (name: string, suppressed: boolean) => void
  /** Reparent the icon into the panel overlay and host it in the row. */
  attachPanel: (name: string, overlay: Gtk.Overlay) => void
  /** Remove the panel overlay; the icon returns to the row. */
  detachPanel: (name: string) => void
  /** Track the open panel's grown extent per frame (stadium region). */
  setPanelOh: (name: string, oh: number) => void
  /** Current absolute slot of an entry (for scrim-hole rects etc.). */
  slotOf: (name: string) => number
  /** Band extent: [start, end) in absolute row coords. */
  band: () => { start: number; end: number }
  /** Apply any pending band shrink/shift (the row calls this at settle). */
  settle: () => void
  /** Move mode: collapse the band to the named slot's single icon. */
  collapseToSlot: (name: string) => void
  /** Pin the band against recomputes (move mode) — collapseToSlot sets
   *  this; the row clears it on exit so the restore can recompute. */
  setBandFrozen: (frozen: boolean) => void
  /** Whole-row ghost state (region empty regardless of entries). */
  setGhosted: (ghosted: boolean) => void
  /** The substrate calls this once its window is mapped: plays the birth
   *  intros and (re)issues the input region. */
  notifyMapped: () => void
  /** Invalidate the surface's paints (the live-config redraw response). */
  repaint: () => void
  /** Debug dump (`dock debug region`). */
  debugInfo: () => string
  /** Capture-lock probe (`dock debug region capture <x> <y>`): is this surface
   *  position inside the capture region, and which applet does the router route
   *  it to? Debug evidence for the region semantics — no pointer injection. */
  captureAt: (x: number, y: number) => { captured: boolean; applet: string | null }
  /** Replay a routed pointer event through the REAL router (debug/repro — no
   *  compositor pointer injection). */
  route: (evt: "enter" | "motion" | "leave", x: number, y: number) => void
  /** Router snapshot for the route debug command. */
  routeState: () => SurfaceRouteState
}

interface AppletSurfaceOptions {
  geometry: DockGeometry
  /** The host's LIVE config view (geometry, timings, appearance). */
  config: AppletConfig
  host: AppletSurfaceHost
}

export function createAppletSurface(opts: AppletSurfaceOptions): AppletSurface {
  const g = opts.geometry
  const config = opts.config
  const host = opts.host
  const sz = () => config.layout.iconSize
  const lg = () => config.layout.pillHeight
  // Does this substrate's bar BAND absorb pointer input across the row? (see
  // host.ts: the dock's layer band does, an embedded strip's does not).
  const captureBand = host.captureBand !== false
  // The surface's row/grow orientation, handed to the region compilation so
  // every stadium is laid along the axis it actually runs on — the shapes below
  // place a CORNER only (see row-region.ts).
  const axes: CaptureAxes = { row: g.rowAxis, grow: g.growAxis }

  const entries = new Map<string, SurfaceEntry>()
  // Current band in absolute row coords. Starts as one slot at 0; the row's
  // initialLayout provisions the real band before the window ever maps.
  let bandStart = 0
  let bandLen = sz()
  let bandAppliedStart = bandStart
  let bandAppliedLen = bandLen
  let ghosted = false
  let mapped = false
  // Move mode: the band is pinned to the collapsed overflow slot (set by
  // collapseToSlot, cleared by the row on exit).
  let bandFrozen = false
  const fixed = new Gtk.Fixed()
  // The pill backdrop (behind every applet; first child = bottom z-order).
  // Spans the icon row's band at iconSize height, flush at the icons' grow
  // edge; the draw func paints the strip + the open panels' stadiums + the
  // lift. Its extent never exceeds the row's, so it cannot pin the fixed's
  // minimum size (the parked-icon min-size class).
  const backdrop = new Gtk.DrawingArea()
  // The entry the pointer currently hovers (null = not over any applet).
  let hoverTarget: SurfaceEntry | null = null

  // ── Fixed coordinate helpers (fixed coords = abs slot - band start) ──

  /** Closed icon: flush at the grow edge, centred nowhere (explicit coords).
   *  The flush offset uses the CURRENT grow extent (growDim): with every
   *  applet closed the surface is iconSize thick, so an offset measured
   *  against the open pillHeight canvas would inflate the fixed's natural
   *  size and pin the row at pillHeight. */
  function iconXY(e: SurfaceEntry): { x: number; y: number } {
    const fx = e.slot - bandStart
    const flush = g.growDir < 0 ? growDim() - sz() : 0
    return g.growAxis === "y"
      ? { x: Math.round(fx), y: Math.round(flush) }
      : { x: Math.round(flush), y: Math.round(fx) }
  }

  /** Open panel overlay: occupies the FULL band at the applet's slot (the
   *  pill inside it is pinned to the grow edge by its own valign/halign) —
   *  NOT the icon's flush coordinate, which would push the overlay past the
   *  band and inflate the fixed's minimum size (the surface-height bug). */
  function overlayXY(e: SurfaceEntry): { x: number; y: number } {
    const fx = e.slot - bandStart
    return g.growAxis === "y" ? { x: Math.round(fx), y: 0 } : { x: 0, y: Math.round(fx) }
  }

  function childXY(e: SurfaceEntry): { x: number; y: number } {
    return e.overlay ? overlayXY(e) : iconXY(e)
  }

  function repositionAll(): void {
    for (const e of entries.values()) {
      // Parked icons are intentionally OUT of the fixed (setEntryHidden) —
      // re-adding them here would pin the fixed's minimum size again.
      if (e.hidden && !e.overlay) continue
      const child = e.overlay ?? e.icon
      if (!child) continue
      const { x, y } = childXY(e)
      try {
        if (child.get_parent() !== fixed) fixed.put(child, x, y)
        else fixed.move(child, x, y)
      } catch (e) {
        ignore("surface entry child place", e)
      }
    }
  }

  /** Grow-axis band dimension: ALWAYS pillHeight — the band must host an open
   *  panel's full extent, so the surface stays lg thick even with every applet
   *  closed (the idle surface is one slot wide on the ROW axis, never on the
   *  grow axis). The backdrop paints the icon strip inside this band plus a
   *  stadium behind every open panel (see the draw func). The input region
   *  stays the discs+stadiums union, so unpainted areas stay click-through (no
   *  hover-grow resize, no enter replays from one). */
  function growDim(): number {
    return lg()
  }

  /** The backdrop DrawingArea spans the row (bandLen × pillHeight at (0,0)).
   *  What it PAINTS is asserted per frame by syncBackdropDraw: the icon strip
   *  at iconSize height flush at the icons' grow edge over the LIVE icon
   *  extent, plus a full pillHeight stadium behind every open panel. */
  function applyBackdropGeom(): void {
    backdrop.set_size_request(
      g.growAxis === "y" ? Math.round(bandLen) : Math.round(lg()),
      g.growAxis === "y" ? Math.round(lg()) : Math.round(bandLen),
    )
    try {
      if (backdrop.get_parent() !== fixed) fixed.put(backdrop, 0, 0)
      else fixed.move(backdrop, 0, 0)
    } catch (e) {
      ignore("surface backdrop place", e)
    }
    backdrop.queue_draw()
  }

  // The DRAWN strip extent (row axis, band-local coords). NOT a time tween:
  // it is tracked per frame from the LIVE slot union (computeBand) — the same
  // loop that animates the applets (fan-out/fan-in drive setSlot per frame →
  // updateRegion → syncBackdropDraw), so the band's edges move at exactly the
  // applets' speed in BOTH directions (a duration-tweened band lags the
  // fan-out and starts only once the close slide has finished). Clamped to
  // the APPLIED band: the extent eagerly extends to the animation target
  // before the first frame, and the painted band must never lead the icons.
  let drawnRow = { a: 0, b: bandLen }

  function syncBackdropDraw(): void {
    const live = computeBand()
    if (!live) {
      // Everything parked: the band stays as-is (the region goes empty).
      drawnRow = { a: 0, b: Math.max(0, Math.round(bandLen)) }
      return
    }
    const a = Math.max(0, Math.min(bandLen, live.start - bandStart))
    const b = Math.max(a, Math.min(bandLen, live.end - bandStart))
    drawnRow = { a, b }
  }

  /** (Re)assert the surface extent through the host: band length on the row
   *  axis, growDim() on the grow axis. Called by applyBand and on panel
   *  attach/detach (the band length may not change there, but the thickness
   *  does). The grow-axis extent is the growDim() source of truth — when it
   *  changes, the flush offset of every closed icon moves, so re-flush them
   *  here too (repositionAll), else a pure hover-grow leaves them at their old
   *  coords = top-aligned in a thicker row. */
  function applyGrowSize(): void {
    host.setExtent(Math.round(bandLen), growDim())
    // The backdrop tracks the icon row's geometry (it is the row's floor:
    // flush + iconSize == pillHeight, so it never inflates the fixed).
    applyBackdropGeom()
    repositionAll()
  }

  /** Apply the band: one extent change + one row-axis start write + a full
   *  reposition (the host is anchored at the row-start edge, so the extent
   *  extends/shrinks in the reading-order direction). */
  function applyBand(start: number, len: number): void {
    bandStart = start
    bandLen = len
    bandAppliedStart = start
    bandAppliedLen = len
    noteGeometryCommit()
    applyGrowSize()
    host.setRowStart(start)
    repositionAll()
  }

  /** The band union over every displayed entry (visible icons + open panels;
   *  suppressed-but-still-fading entries count — they slide INTO the band).
   *  Null when everything is parked: the band stays as-is (the region is what
   *  goes empty). */
  function computeBand(): { start: number; end: number } | null {
    let start = Infinity
    let end = -Infinity
    for (const e of entries.values()) {
      if (e.hidden) continue
      if (e.slot < start) start = e.slot
      if (e.slot + sz() > end) end = e.slot + sz()
    }
    if (end <= start) return null
    return { start, end }
  }

  /** Eager-extend (apply now if the band must grow) / lazy-shrink (defer to
   *  settle()). Resizing mid-animation would clip sliding icons; shrinking
   *  per frame would re-evaluate the pointer every frame. */
  function recomputeBand(): void {
    // Frozen in move mode: the ghost-fading (suppressed) entries must NOT
    // re-extend the band over the collapsed slot — the parks that follow the
    // collapse each recompute, and without the freeze every park would snap
    // the band back to the full row extent.
    if (bandFrozen) return
    const band = computeBand()
    if (!band) return
    const start = band.start
    const len = band.end - band.start
    if (start < bandAppliedStart || start + len > bandAppliedStart + bandAppliedLen) {
      applyBand(start, len)
      updateRegion()
    }
    // Pure shrink / in-extent shift: deferred to settle().
  }

  // ── Input region / capture lock ──
  // ONE shape list feeds two consumers (row-region.ts owns the model): the
  // wl_surface input region a layer substrate installs, and this renderer's
  // own router, which enforces the SAME geometry for a substrate that cannot
  // clip delivery itself. The dock installs a region on its layer surface; the
  // greeter's embedded strip cannot (its surface is the whole greeter
  // window), so without the router's capture test the band above its icons and
  // the discs' square corners captured hover/click input there.
  let lastRegionSpec = ""

  /** The row band as a capture shape — only when this substrate's bar absorbs
   *  input across it (host.captureBand): a layer band sits over the desktop,
   *  so a press on the bar must land on the surface; an embedded strip's band
   *  lives inside the host's own window and stays inert. Geometry (placement
   *  AND orientation) belongs to row-region's builder. */
  function bandShape(): CaptureShape | null {
    if (ghosted || !captureBand) return null
    return bandCaptureShape(axes, {
      growDir: g.growDir,
      growDim: lg(),
      bandLen,
      thickness: sz(),
    })
  }

  /** One entry's own capture shape: its LATCHED panel stadium while the panel
   *  is open, else its disc at the current slot (the disc's square corners stay
   *  click-through). The clamp and the entry's own row coordinate are live
   *  state; the stadium's geometry belongs to row-region's builder. */
  function entryShape(e: SurfaceEntry): CaptureShape {
    const { x, y } = iconXY(e)
    if (!e.overlay) return { kind: "disc", x, y, d: sz() }
    const oh = Math.max(sz(), Math.min(lg(), Math.round(e.regionOh)))
    return panelCaptureShape(axes, {
      growDir: g.growDir,
      growDim: lg(),
      rowOffset: g.growAxis === "y" ? x : y,
      oh,
      thickness: sz(),
    })
  }

  /** The capture region at the CURRENT geometry: the band (when this substrate
   *  absorbs it) + every displayed entry's shape. Empty while ghosted —
   *  everything click-through, region and router alike. */
  function captureRegion(): CaptureRegion {
    if (ghosted) return compileCaptureRegion([], axes)
    const shapes: CaptureShape[] = []
    const band = bandShape()
    if (band) shapes.push(band)
    for (const e of entries.values()) {
      if (e.hidden || e.suppressed) continue
      shapes.push(entryShape(e))
    }
    return compileCaptureRegion(shapes, axes)
  }

  function updateRegion(): void {
    // Track the painted strip from the live slot union FIRST — every caller
    // of updateRegion is a geometry change (per-frame setSlot during the fan
    // loops included), so the drawn band rides the applets' own animation.
    // Must run before the spec-equality early return.
    syncBackdropDraw()
    // Serialize the spec; re-issue only on actual change.
    const specParts: string[] = []
    if (!ghosted && captureBand) {
      // The pill backdrop ABSORBS mouse events across the whole band
      // (iconSize thick, flush at the icons' grow edge) — clicks land on the
      // row instead of passing through to the layers below. Sized to the
      // surface's band (the extent source of truth), not the eased paint
      // length; the extra pillHeight band above the icons stays click-through.
      // Same chord-stadium silhouette as the paint.
      const flush = g.growDir < 0 ? lg() - sz() : 0
      specParts.push(`BD:${Math.round(bandLen)}@${Math.round(flush)}`)
    }
    if (!ghosted) {
      for (const e of entries.values()) {
        if (e.hidden || e.suppressed) continue
        const { x, y } = iconXY(e)
        specParts.push(
          e.overlay ? `${e.name}:S:${x},${y},${Math.round(e.regionOh)}` : `${e.name}:D:${x},${y}`,
        )
      }
    }
    const spec = ghosted ? "GHOST" : specParts.join("|")
    if (spec === lastRegionSpec) return
    try {
      const region: CairoRegion | null = newRegion()
      if (!region) return
      captureRegion().unionInto(region)
      // Latch the spec only once the host actually took the region: a host
      // without a surface yet (the dock's window before realize) must have it
      // re-issued on the next geometry change — the map leg included.
      if (!host.setInputRegion(region)) return
      lastRegionSpec = spec
      host.repaint() // commit the region change to the compositor
      backdrop.queue_draw() // panel grow/fade repaints the backdrop too
      if (DBG) print(`[surface:region] ${spec || "EMPTY"}`)
    } catch (e) {
      ignore("surface input region apply", e)
    }
  }

  // ── Event routing ──
  // The host's pointer source feeds enter/motion/leave/press, routed
  // GEOMETRICALLY to the applet whose slot band contains the pointer. The
  // input region (discs + stadiums) is the delivery boundary, so events only
  // arrive inside drawn geometry — the same per-applet boundary semantics an
  // applet had as its own window.
  // Last pointer position seen in an in-bounds event (surface coords). Slot
  // animations move applet bands UNDER a stationary pointer: the compositor
  // re-evaluates and may deliver an enter for a band that then slides away —
  // with no further commits there is no leave, so the routed hover target
  // goes stale. settle() re-evaluates against this position.
  let lastPointer: { x: number; y: number } | null = null
  // GDK REPLAYS enter events with cached in-bounds coordinates after our own
  // geometry commits (band resize / margin move / panel attach) — a
  // cached-coords enter routed as a real hover RE-OPENS a panel under a
  // pointer that is actually outside the row (the spontaneous-open class
  // again, now post-map). Hover-open routing stays suppressed for a bounded
  // window (timing.leaveGrace) after each commit — replays arrive within a
  // frame and stay blocked; a genuine crossing arriving later opens on the
  // enter alone (openSuppressed below), and one inside the grace window is
  // parked as pendingOpen for the next real motion to promote.
  let lastGeometryCommitAt = 0
  let lastInBoundsMotionAt = 0
  // A suppressed enter parks its target here; the next real in-bounds motion
  // over the SAME applet (which clears the suppression) promotes it to a
  // genuine enter so the panel opens. Replayed stationery enters carry no
  // motion and never reach the promote branch.
  let pendingOpen: SurfaceEntry | null = null
  function noteGeometryCommit(): void {
    lastGeometryCommitAt = GLib.get_monotonic_time() / 1000
  }
  /** Suppressed until the first REAL in-bounds motion event after the last
   *  geometry commit — no time window. A replayed enter carries cached coords
   *  and arrives before any fresh motion, so it stays suppressed; a genuine
   *  crossing always has motion events behind it and opens immediately. */
  function openSuppressed(): boolean {
    // Fresh in-bounds motion always lifts the suppression immediately.
    if (lastInBoundsMotionAt >= lastGeometryCommitAt) return false
    // Bounded arm window (timing.leaveGrace): GDK's cached-coord replays land
    // within a frame of the commit, so a crossing arriving later than the
    // grace is genuine and must open on the enter ALONE — the pointer often
    // stops dead on the icon (a lone disc in hide mode) and no motion event
    // ever follows; requiring motion behind the enter would starve exactly
    // those hovers.
    return (
      GLib.get_monotonic_time() / 1000 - lastGeometryCommitAt <
      Math.max(0, config.timing.leaveGrace)
    )
  }

  /** May indicator-level hover listeners (onHoverEnter — the overflow clock)
   *  latch on this enter? An enter landing inside the open-suppression grace
   *  is either a GENUINE crossing (the pointer physically moved onto the
   *  applet — fresh coords, different from the last pointer position seen
   *  before the enter) or a GDK REPLAY (cached coords = the pointer's
   *  previous in-bounds position, re-delivered after OUR geometry commit).
   *  Only genuine crossings may latch indicator state: a replay re-latches
   *  cursor state AFTER the real leave and updateClockState then cancels the
   *  armed reappear timer — with no further events the clock never returns.
   *  No previous position (boot / right after a leave) cannot prove freshness
   *  → conservative: don't latch; a genuine hover still hides the clock via
   *  the pendingOpen promotion (first real motion over the disc). */
  function indicatorsMayLatch(x: number, y: number): boolean {
    if (!openSuppressed()) return true
    if (!lastPointer) return false
    return Math.abs(x - lastPointer.x) >= 0.5 || Math.abs(y - lastPointer.y) >= 0.5
  }

  /** Hyprland delivers SYNTHETIC wl_pointer.enter events on map/geometry
   *  commits even when the pointer is outside the surface — with the pointer's
   *  actual position projected onto the surface (out-of-bounds coordinates,
   *  e.g. y=-169 on a 140px band). A real hover always delivers coordinates
   *  inside the surface (the input region is a subset of the bounds), so
   *  out-of-bounds coordinates identify the synthetic event class: routing
   *  them as hovers hover-opened panels under a resting pointer once the
   *  map-guard's arming grace had expired. */
  function inBounds(x: number, y: number): boolean {
    const { w, h } = host.bounds()
    return x >= 0 && y >= 0 && x < w && y < h
  }

  /** Pointer is NOT over the surface (synthetic enter / out-of-bounds
   *  motion): any current hover target must see a leave. */
  function forceLeave(): void {
    pendingOpen = null
    if (hoverTarget) {
      for (const cb of hoverTarget.onLeave) cb()
      for (const cb of hoverTarget.onHoverLeave) cb()
      hoverTarget = null
      applyGrowSize()
    }
  }

  function hit(x: number, y: number): SurfaceEntry | null {
    // The slot coordinate lives on the ROW axis (x for top/bottom docks,
    // y for left/right). Testing x unconditionally hit-tested left/right
    // docks on the wrong axis — a hover at surface y=100 routed to the
    // applet parked at slot 100 regardless of where the pointer actually
    // was (the left/right input-flip bug).
    //
    // Capture lock: the position must also be inside the capture region. A
    // substrate that installs that region on its own surface only ever gets
    // captured positions delivered (the dock); one that cannot — the greeter's
    // embedded strip, where GTK pick delivers the whole row rect — relies on
    // this test, which is what keeps the band above the icons and the discs'
    // square corners from hovering/opening a panel.
    if (!captureRegion().contains(x, y)) return null
    const rc = g.rowAxis === "x" ? x : y
    for (const e of entries.values()) {
      if (e.hidden || e.suppressed) continue
      const fc = e.slot - bandStart
      if (rc >= fc && rc < fc + sz()) return e
    }
    return null
  }

  function routeEnter(x: number, y: number): void {
    if (!inBounds(x, y)) {
      forceLeave()
      return
    }
    const allowOpen = !openSuppressed()
    hoverTarget = hit(x, y)
    applyGrowSize() // hover grows the surface to full pill height immediately
    lastPointer = { x, y }
    // A suppressed enter (after a geometry commit, the pointer arriving from
    // the gap/off-dock with no in-bounds motion behind it) must NOT be
    // orphaned to onMotion forever — park it as pending so the next real
    // motion over the same applet promotes it to a genuine open. Accepted
    // enters supersede any pending.
    pendingOpen = allowOpen ? null : hoverTarget
    if (DBG)
      print(
        `[surface] enter ${hoverTarget?.name ?? "null"} x=${x} y=${y}${allowOpen ? "" : " (open-suppressed)"}`,
      )
    if (hoverTarget) {
      // Indicator-level hover listeners run on every GENUINE enter — the
      // open suppression grace gates panel opens, not hover indicators (the
      // overflow clock hid late whenever the enter landed inside the grace:
      // a pointer resting on the disc never generated the promoting motion).
      // Replayed enters are excluded (indicatorsMayLatch) or their latch is
      // deferred to the pendingOpen promotion.
      if (indicatorsMayLatch(x, y)) for (const cb of hoverTarget.onHoverEnter) cb(x, y)
      for (const cb of allowOpen ? hoverTarget.onEnter : hoverTarget.onMotion) cb(x, y)
    }
  }

  function routeMotion(x: number, y: number): void {
    if (!inBounds(x, y)) {
      forceLeave()
      return
    }
    lastPointer = { x, y }
    lastInBoundsMotionAt = GLib.get_monotonic_time() / 1000
    const t = hit(x, y)
    if (t !== hoverTarget) {
      // Crossed a per-applet boundary (or left all drawn geometry).
      if (hoverTarget) {
        for (const cb of hoverTarget.onLeave) cb()
        for (const cb of hoverTarget.onHoverLeave) cb()
      }
      hoverTarget = t
      pendingOpen = null // no longer over the pending target
      applyGrowSize()
      if (t) {
        for (const cb of t.onHoverEnter) cb(x, y)
        if (!openSuppressed()) for (const cb of t.onEnter) cb(x, y)
      }
    } else if (t) {
      if (pendingOpen === t && !openSuppressed()) {
        // Fresh in-bounds motion over the same applet corroborates a previously
        // suppressed enter — promote it to a genuine hover-open (and latch
        // indicator state if the enter itself was not fresh enough to).
        pendingOpen = null
        if (DBG) print(`[surface] promote pending-enter ${t.name}`)
        for (const cb of t.onHoverEnter) cb(x, y)
        for (const cb of t.onEnter) cb(x, y)
      } else {
        for (const cb of t.onMotion) cb(x, y)
      }
    }
  }

  function routeLeave(): void {
    if (DBG) print(`[surface] leave ${hoverTarget?.name ?? "null"}`)
    pendingOpen = null
    if (hoverTarget) {
      for (const cb of hoverTarget.onLeave) cb()
      for (const cb of hoverTarget.onHoverLeave) cb()
    }
    hoverTarget = null
    lastPointer = null
    applyGrowSize()
  }

  /** Row-level press → touch tap-to-open (pressOpen). Presses over an OPEN
   *  panel's pill arrive here too — the routed handler (the applet core)
   *  no-ops when its panel is open, and the pill's own gestures own the
   *  pointer exactly as with a per-applet window. */
  function routePress(x: number, y: number): void {
    if (!inBounds(x, y)) return // synthetic — a real press is always in-bounds
    const t = hit(x, y)
    if (t) for (const cb of t.onPressOpen) cb(x, y)
  }

  host.connectPointer({
    enter: routeEnter,
    motion: routeMotion,
    leave: routeLeave,
    press: routePress,
  })

  // ── The surface's widget tree ──
  backdrop.set_draw_func((_da: any, cr: any, _w: number, _h: number) => {
    drawPillBackdrop(cr, {
      geometry: {
        growAxis: g.growAxis,
        growDir: g.growDir,
        iconSize: sz(),
        pillHeight: lg(),
      },
      strip: { a: drawnRow.a, b: drawnRow.b },
      panels: Array.from(entries.values())
        .filter((e) => e.overlay && !e.hidden)
        .map((e) => ({ slot: e.slot - bandStart, panelOh: e.panelOh })),
      colour: [
        config.appearance.backdrop.rgb[0],
        config.appearance.backdrop.rgb[1],
        config.appearance.backdrop.rgb[2],
        config.appearance.backdrop.alpha,
      ],
      lift: {
        colour: backdropLiftColour(config) as [number, number, number, number],
        // The discs ON the strip: every displayed applet whose panel is
        // closed (an open panel's own surface paints the lift).
        discSlots: Array.from(entries.values())
          .filter((e) => !e.hidden && !e.suppressed && !e.overlay)
          .map((e) => e.slot - bandStart),
      },
    })
  })
  fixed.put(backdrop, 0, 0)
  applyBackdropGeom()
  host.mountRow(fixed)
  host.setExtent(Math.round(bandLen), growDim())
  host.setRowStart(bandStart)

  // ── Public API ──

  const api: AppletSurface = {
    window: host.window,
    dg: g,
    config,
    addEntry(name, icon, onMap) {
      const entry: SurfaceEntry = {
        name,
        icon,
        overlay: null,
        panelOh: sz(),
        regionOh: sz(),
        hidden: false,
        suppressed: false,
        slot: 0,
        onEnter: [],
        onLeave: [],
        onMotion: [],
        onHoverEnter: [],
        onHoverLeave: [],
        onPressOpen: [],
        onMap: [onMap],
      }
      entries.set(name, entry)
      const { x, y } = iconXY(entry)
      fixed.put(icon, x, y)
      if (mapped) onMap()
    },
    setPointerHandlers(name, handlers) {
      const e = entries.get(name)
      if (!e) return
      e.onEnter = handlers.onEnter ? [handlers.onEnter] : []
      e.onLeave = handlers.onLeave ? [handlers.onLeave] : []
      e.onMotion = handlers.onMotion ? [handlers.onMotion] : []
      e.onPressOpen = handlers.onPressOpen ? [handlers.onPressOpen] : []
    },
    addHoverListener(name, handlers) {
      const e = entries.get(name)
      if (!e) return
      // onEnter here = indicator-level (NOT open-capable): delivered on every
      // routed enter, unsuppressed. Panel opens belong to setPointerHandlers.
      // onLeave goes into the DEDICATED onHoverLeave array (NOT onLeave) so
      // setPointerHandlers' later replacement of onLeave can't erase it.
      if (handlers.onEnter) e.onHoverEnter.push(handlers.onEnter)
      if (handlers.onLeave) e.onHoverLeave.push(handlers.onLeave)
      if (handlers.onMotion) e.onMotion.push(handlers.onMotion)
    },
    setSlot(name, absSlot) {
      const e = entries.get(name)
      if (!e) return
      e.slot = absSlot
      repositionAll()
      // Per-frame slot moves inside an unchanged band don't resize anything
      // — the segmented backdrop must still track the moving gaps.
      backdrop.queue_draw()
      recomputeBand()
      updateRegion()
    },
    provisionSlot(name, absSlot) {
      const e = entries.get(name)
      if (!e) return
      const prev = e.slot
      e.slot = absSlot
      recomputeBand() // eager-extend to cover the animation target
      e.slot = prev // the icon stays put until the first animation frame
    },
    setEntryHidden(name, hidden) {
      const e = entries.get(name)
      if (!e) return
      e.hidden = hidden
      // Either transition ends a fade-suppression window (unhide restores the
      // disc; park makes it moot) — move-mode exit relies on the unhide leg.
      e.suppressed = false
      // Park = pull the icon OUT of the fixed. A parked icon left in the
      // fixed pins its minimum size (union of child extents), and a clamped
      // minimum defeats every band shrink — collapseToSlot (move mode)
      // silently stayed at the full row extent whenever any applet rested
      // off the collapse slot. Restore re-puts at the current position.
      if (hidden && !e.overlay) {
        if (e.icon.get_parent() === fixed) {
          try {
            fixed.remove(e.icon)
          } catch (err) {
            ignore("surface hidden icon remove", err)
          }
        }
      } else if (!hidden) {
        const child = e.overlay ?? e.icon
        try {
          if (child.get_parent() !== fixed) {
            const { x, y } = childXY(e)
            fixed.put(child, x, y)
          }
        } catch (err) {
          ignore("surface hidden icon replace", err)
        }
      }
      recomputeBand()
      updateRegion()
      // Re-assert the extent against the new fixed minimum: the removal path
      // must let an already-applied shrink (collapseToSlot) take effect.
      applyGrowSize()
    },
    setEntrySuppressed(name, suppressed) {
      const e = entries.get(name)
      if (!e) return
      e.suppressed = suppressed
      updateRegion()
    },
    attachPanel(name, overlay) {
      const e = entries.get(name)
      if (!e) return
      // The icon leaves the fixed and rides INSIDE the overlay (spatial
      // continuity — the same reparent dance as a per-applet window).
      try {
        fixed.remove(e.icon)
      } catch (err) {
        ignore("surface icon reparent", err)
      }
      e.overlay = overlay
      const { x, y } = overlayXY(e)
      noteGeometryCommit()
      fixed.put(overlay, x, y)
      e.panelOh = sz()
      e.regionOh = sz()
      recomputeBand()
      applyGrowSize()
      updateRegion()
    },
    detachPanel(name) {
      const e = entries.get(name)
      if (!e) return
      if (e.overlay) {
        try {
          fixed.remove(e.overlay)
        } catch (err) {
          ignore("surface overlay reparent", err)
        }
      }
      e.overlay = null
      const { x, y } = iconXY(e)
      noteGeometryCommit()
      // A parked entry must not return to the fixed (minimum-size pinning —
      // see setEntryHidden); its slot is restored on unpark instead.
      if (!e.hidden) fixed.put(e.icon, x, y)
      recomputeBand()
      applyGrowSize()
      updateRegion()
    },
    setPanelOh(name, oh) {
      const e = entries.get(name)
      if (!e) return
      // Live panelOh: the paint's stadium follows the pill's eased oh every
      // frame (open AND close) — the expanded-applet backdrop shrinks with
      // the pill. Latched regionOh: the INPUT REGION only grows (never
      // shrinks mid-close), so a close never re-issues a shrinking region
      // under the pointer (the swallowed-click race). On detach the overlay
      // is removed and the region re-issues at the DISC extent.
      e.panelOh = oh
      if (oh > e.regionOh) e.regionOh = oh
      // Repaint the backdrop even when the region is frozen: the equal-spec
      // early return in updateRegion skips the queue_draw, and the paint's
      // stadium must still follow the live (easing) panelOh during close.
      backdrop.queue_draw()
      updateRegion()
    },
    slotOf(name) {
      return entries.get(name)?.slot ?? 0
    },
    band() {
      return { start: bandStart, end: bandStart + bandLen }
    },
    settle() {
      if (bandFrozen) return
      const band = computeBand()
      if (!band) return
      const start = band.start
      const len = band.end - band.start
      if (start !== bandAppliedStart || len !== bandAppliedLen) {
        applyBand(start, len)
        // The band extent is now part of the input region (the backdrop
        // absorbs events across it) — a settle-time shrink must re-issue it.
        updateRegion()
      }
      // Geometry just changed under the (possibly stationary) pointer: the
      // routed hover target may be stale (an enter routed to a band that has
      // since slid away — with no motion there is no leave). Re-evaluate.
      if (lastPointer) {
        const t = inBounds(lastPointer.x, lastPointer.y) ? hit(lastPointer.x, lastPointer.y) : null
        if (t !== hoverTarget) {
          if (hoverTarget) {
            for (const cb of hoverTarget.onLeave) cb()
            for (const cb of hoverTarget.onHoverLeave) cb()
          }
          hoverTarget = t
          applyGrowSize()
          if (t) {
            if (indicatorsMayLatch(lastPointer.x, lastPointer.y))
              for (const cb of t.onHoverEnter) cb(lastPointer.x, lastPointer.y)
            if (!openSuppressed()) for (const cb of t.onEnter) cb(lastPointer.x, lastPointer.y)
          }
        }
      }
    },
    collapseToSlot(name) {
      const e = entries.get(name)
      if (!e) return
      noteGeometryCommit()
      bandFrozen = true
      applyBand(e.slot, sz())
      updateRegion()
    },
    setBandFrozen(v) {
      bandFrozen = v
    },
    setGhosted(v) {
      ghosted = v
      if (v) noteGeometryCommit()
      updateRegion()
    },
    notifyMapped() {
      if (mapped) return
      mapped = true
      // Birth intros: every entry's forward appear plays ONCE per surface
      // lifetime (a rebuild creates a fresh surface, so reload replays).
      for (const e of entries.values()) {
        for (const cb of e.onMap) cb()
      }
      updateRegion()
      host.repaint()
    },
    repaint() {
      backdrop.queue_draw()
      host.repaint()
    },
    debugInfo() {
      const region = captureRegion()
      const ex = region.extents()
      const parts = [
        `band=[${Math.round(bandStart)},${Math.round(bandStart + bandLen)})` +
          ` applied=[${Math.round(bandAppliedStart)},${Math.round(bandAppliedStart + bandAppliedLen)})` +
          ` ghost=${ghosted}` +
          ` bd=[${Math.round(drawnRow.a)},${Math.round(drawnRow.b)}) region=${lastRegionSpec || ""}` +
          ` capture=[rects=${region.rectCount}` +
          (ex ? ` x=${ex.x}..${ex.x + ex.width} y=${ex.y}..${ex.y + ex.height}` : " empty") +
          ` band=${captureBand ? "absorbed" : "click-through"}]`,
      ]
      for (const e of entries.values()) {
        parts.push(
          `${e.name}: slot=${Math.round(e.slot)} hidden=${e.hidden} supp=${e.suppressed}` +
            ` panel=${e.overlay ? `oh=${Math.round(e.panelOh)}` : "no"}`,
        )
      }
      return parts.join(" | ")
    },
    captureAt(x, y) {
      return { captured: captureRegion().contains(x, y), applet: hit(x, y)?.name ?? null }
    },
    route(evt, x, y) {
      if (evt === "enter") routeEnter(x, y)
      else if (evt === "motion") routeMotion(x, y)
      else routeLeave()
    },
    routeState() {
      return {
        name: "surface",
        active: hoverTarget !== null,
        hoverTarget: hoverTarget?.name ?? null,
        bd: [Math.round(drawnRow.a), Math.round(drawnRow.b)],
        bandLen: Math.round(bandLen),
        bandApplied: [Math.round(bandAppliedStart), Math.round(bandAppliedLen)],
        panels: Array.from(entries.values())
          .filter((e) => e.overlay && !e.hidden)
          .map((e) => ({
            name: e.name,
            slot: Math.round(e.slot - bandStart),
            oh: Math.round(e.panelOh),
            regionOh: Math.round(e.regionOh),
          })),
      }
    },
  }
  return api
}
