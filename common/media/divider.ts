/**
 * common/media/divider.ts — wires a host's `Gtk.Paned` divider to the shared
 * preview width.
 *
 * The preview preference is ONE preference shared by every host, so the wiring
 * that reads and writes it is shared too: reserving the strip the paned claims
 * for its own handle, seeding the divider from the stored width, holding a drag
 * at the pane's floor and judging the fold once it settles, persisting the
 * settled width and handing back a detach for the host's teardown. Without it
 * each host carries its own copy of that bookkeeping, which is how files and the
 * portal started out. The pane's WIDTH and mode are the shared half; whether the
 * pane is on screen is the host window's own switch (the `session` option), so a
 * fold closes the pane in the window it happened in.
 *
 * THE PANE IS EITHER AT LEAST ITS MINIMUM OR CLOSED. `GtkPaned` keeps its end
 * child at its requested width while a drag runs left (`shrink-end-child` is
 * TRUE by default), so the POSITION is what travels: a drag past the pane's
 * minimum leaves the pane at `PREVIEW_MIN_WIDTH` pushed past the paned's right
 * edge — the sliver the drag asked for, and nothing a host can use. The judgement
 * therefore runs on EVERY position change, not only on the settled one. A drag
 * that would leave the pane narrower than its floor is HELD at the floor: the
 * position stops at the pane's own edge, whatever the pointer does past it. Only
 * a drag that would leave the pane narrower than `PREVIEW_SNAP_SHUT_WIDTH`
 * (half the floor, so the fold takes a deliberate overshoot and brushing the
 * floor cannot close the pane) folds it
 * shut — the divider goes to the far end — and the pane's switch turns OFF, so
 * the pane comes back at the stored width when the user switches it on again.
 *
 * THE HOLD IS A DRAG-TIME RULE. Only the width a drag ASKS for is held: the
 * stored width is still bounded by the floor alone (`isWidth` in
 * `common/media/preview` rejects anything under it), a fold writes no width at
 * all, and a pane whose geometry cannot give it the floor at all (a window too
 * narrow to host it) is folded as the window's doing rather than the user's — see
 * `windowFitsStored`.
 *
 * THE HOST'S OWN LIST KEEPS ITS MINIMUM. `GtkPaned` gives a start child it
 * cannot fit below the divider position its MINIMUM size, anchored at the
 * divider — so the child's content slides out of the left edge of the window
 * (measured with a 630px window whose list has a 609px minimum: the list lands
 * at x = -245 and its columns disappear off the left). The consequence is not a
 * narrower list but a SHIFTED one, which is the opposite of the displacement a
 * preview slot is for. The divider therefore turns the paned's start-child
 * shrinking OFF, which is the same rule GTK enforces for a drag: the position
 * can never sit left of the child's minimum, so the list keeps its own width and
 * the pane takes what is free — and a window too small to give the pane its own
 * minimum closes the pane instead.
 *
 * THE JUDGEMENT RIDES ON THE PANED'S `notify::position` — a drag-driven width
 * change — and that is the only geometry signal this module reads: the position
 * is the LIST's width, so a drag moves it. Every change is judged by the same
 * rule once the pane has been laid out, and a RESIZE is no exception: a paned
 * that clamps a position writes the clamped value and notifies it, so a window
 * narrowed below the divider arrives here as a position change. A clamp places
 * the divider at the paned's own end, which asks for a negative pane width and
 * so folds the pane — the `fits` test keeps that fold out of the stored width
 * and out of the next window's start state when the window could not host it. A
 * resize that does not clamp the position changes no position, so it is not
 * judged at all: the pane takes the freed space and the stored width stands.
 *
 * The paned's handle is theme-drawn and the paned exposes no handle size, so the
 * SEED subtracts the separator measured from the layout once the pane has been
 * allocated. A measurement taken in the hidden-pane layout reads 0, and a pane
 * can therefore measure one separator away from the stored width; that slack
 * never rewrites the stored value, so the stored width cannot walk. The HOLD
 * needs the paned's own strip rather than that margin-inclusive figure, and takes
 * it from the widgets' measurements (`handleStrip`) rather than from the
 * allocation, which a resize pass reads mid-flight.
 *
 * THE JUDGED WIDTH IS THE PANE'S SLOT, one quantity everywhere: the width the
 * paned's position leaves for the pane minus that separator strip (`askedWidth`)
 * — what the hold writes, what the floor test reads, what gets stored. The pane's
 * own reported width is a DIFFERENT quantity: a CSS border of the pane's sits
 * inside its slot, so `pane.get_width()` reads the pane one edge narrower than
 * the slot it was given. Both hosts draw such an edge while the pane is a side
 * slot (`media-pane-split` in apps/files/style.css, apps/portal/style.css), and a
 * floor test taken on the reported width folds a pane the hold is keeping at its
 * floor.
 */
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import { log } from "@common/log/logger"
import {
  PREVIEW_MIN_WIDTH,
  PREVIEW_SNAP_SHUT_WIDTH,
  type PreviewSession,
  previewSettings,
  setPreviewWidth,
} from "./preview"

interface PaneDividerOptions {
  /** The split holding the pane as its END child. */
  paned: Gtk.Paned
  /** The pane widget whose measured width is what gets persisted. */
  pane: Gtk.Widget
  /** The widget whose `map` seeds the divider — normally the host window. */
  display: Gtk.Widget
  /** The host WINDOW's preview switch: the fold turns it off, and only the
   *  window it belongs to reacts. */
  session: PreviewSession
}

/** A drag emits one position change per pixel; the settle pass waits for the
 *  geometry to stop moving. */
const SETTLE_DEBOUNCE_MS = 250

/** Space the list side keeps clear of its own right edge. `GtkPaned` claims a
 *  press anywhere in its handle area, which it computes as the separator's
 *  rectangle grown by 6px on EVERY side (`HANDLE_EXTRA_SIZE` in gtkpaned.c, the
 *  mouse drag path, at the capture phase). A list's overlay scrollbar sits at
 *  exactly that edge, so the claim swallowed the scrollbar's presses and the
 *  pointer dragged the divider instead of the scrollbar while the pane was
 *  open. This margin is the claimed strip plus 2px of slack. */
const GRAB_RESERVE = 8

/** The start child's minimum width — the floor the divider may not go below, or
 *  the paned hands the child its minimum anchored at the divider and the list's
 *  content slides out of the left edge (see the module note). Measured per call:
 *  a list's minimum tracks its content. */
function measureStartMinimum(paned: Gtk.Paned): number {
  const start = paned.get_start_child()
  if (!start) return 0
  const measured = start.measure(Gtk.Orientation.HORIZONTAL, -1) as unknown as number[]
  return Math.max(0, Math.ceil(measured[0] ?? 0))
}

/** The paned's own minimum width. Its end child is shrinkable (see
 *  `attachPaneDivider`), so what is left is the start child's minimum — margin
 *  included, the way the paned's position counts it — plus the strip the paned
 *  reserves between its children. */
function measurePanedMinimum(paned: Gtk.Paned): number {
  const measured = paned.measure(Gtk.Orientation.HORIZONTAL, -1) as unknown as number[]
  return Math.max(0, Math.ceil(measured[0] ?? 0))
}

/** The separator strip the paned reserves between its children, measured from a
 *  layout with the pane on screen: with the pane hidden the start child owns the
 *  whole allocation and the difference reads 0. */
function measureSeparator(paned: Gtk.Paned): number {
  const start = paned.get_start_child()
  const end = paned.get_end_child()
  if (!start || !end || end.get_width() <= 0) return 0
  return Math.max(0, paned.get_width() - start.get_width() - end.get_width())
}

/** Attach the divider wiring and return its detach for the host's teardown. */
export function attachPaneDivider(opts: PaneDividerOptions): () => void {
  const { paned, pane, display, session } = opts
  const list = paned.get_start_child()
  list?.set_margin_end(GRAB_RESERVE)
  // The paned must never allocate the host's own list below its minimum — that
  // is the shift (see the module note) — neither for the seed below nor for a
  // drag: with this FALSE the paned refuses a position left of the child's
  // minimum. The pane side stays shrinkable, which is what keeps a drag able to
  // fold the pane shut.
  paned.set_shrink_start_child(false)

  let settleId: number | null = null
  let dead = false
  let seeded = false
  let lastSeparator = 0

  /** The separator strip the paned reserves between its children. The theme
   *  owns its width, so it is measured from the allocation — and only from a
   *  layout with the pane on screen: with the pane hidden the start child owns
   *  the whole allocation and the difference reads 0, which would seed the
   *  divider a separator wide. The last real measurement is kept. */
  function separatorSize(): number {
    const measured = measureSeparator(paned)
    if (measured > 0) lastSeparator = measured
    return lastSeparator
  }

  /** A pane measurement and the stored width can differ by up to one separator
   *  (see the module note), so a difference inside that slack IS the stored
   *  width and must not be written back as a new one. */
  function sameWidth(measured: number, stored: number): boolean {
    return Math.abs(measured - stored) <= separatorSize()
  }

  /** The paned's OWN separator strip — its handle. Taken from the widgets'
   *  MEASUREMENTS, never from an allocation: a resize pass runs this module's
   *  handlers with the paned's new width already in place and its children still
   *  the ones the previous pass left, so a strip read from the allocation there
   *  would count the whole resize delta as handle — and a hold measured with that
   *  mistake would let a later drag close the pane far too early. The paned's own
   *  minimum is the list's minimum plus that strip, and the list's minimum is
   *  measured with the grab margin its position also counts, so the difference is
   *  the strip. */
  function handleStrip(): number {
    return Math.max(0, measurePanedMinimum(paned) - measureStartMinimum(paned))
  }

  /** The pane width a divider position leaves room for: the paned gives its end
   *  child what the position leaves it, minus the paned's own separator strip. */
  function askedWidth(position: number): number {
    return paned.get_width() - position - handleStrip()
  }

  /** Does the window have room for the width the user stored? When it does not,
   *  a fold here is the window's doing rather than the user's choice — so it must
   *  not overwrite the stored width, and it must not make the pane's absence the
   *  setting a new window inherits. */
  function windowFitsStored(): boolean {
    return (
      paned.get_width() - previewSettings().width - separatorSize() >= measureStartMinimum(paned)
    )
  }

  /** Fold the pane shut: the divider goes to the far end as well, so the pane is
   *  closed rather than held open at zero width. `fits` says whether the window
   *  could host the width the user stored (see `windowFitsStored`). */
  function fold(fits: boolean): void {
    session.setEnabled(false, fits)
    const total = paned.get_width()
    if (total > 0) paned.position = total
  }

  /** Seed the divider from the stored width. A pane that is not on screen has
   *  no width to measure, so this runs on map and whenever the pane comes back
   *  on screen (after a fold, or after the switch was off). The stored width is
   *  honoured only as far as the start child keeps its own minimum. */
  function apply(): void {
    if (dead) return
    const total = paned.get_width()
    if (total <= 0) return
    const want = total - previewSettings().width - separatorSize()
    paned.position = Math.max(1, Math.max(want, measureStartMinimum(paned)))
    seeded = true
  }

  /** Judge a DRAG as it moves: the divider may not take the pane below its floor,
   *  and a drag that goes clearly past it closes the pane.
   *
   *  The floor is HELD rather than merely respected on the way through: the
   *  position stops where the pane's own edge is, so the pane keeps the floor's
   *  slot however far the pointer travels past it, and the pane is closed only
   *  once the width the drag ASKS for is under half the floor — the drag has to
   *  be deliberately driven past the pane's floor to close it. A pane already at
   *  its floor asks for exactly the floor width, so the hold is idempotent and
   *  cannot loop on its own write.
   *
   *  Only a drag that starts from a LAID-OUT pane is judged: on the way in, the
   *  seed's position and the paned's clamp of it both arrive before the pane has
   *  ever been allocated, so the pane measures 0 and there is no width to hold
   *  against. A window too narrow for the pane therefore does not close it before
   *  it has been on screen — it closes it when the user drags. */
  function resist(): void {
    if (dead || !seeded) return
    if (!session.enabled() || !pane.get_visible()) return
    const total = paned.get_width()
    if (total <= 0) return
    if (pane.get_width() <= 0) return // not laid out yet — there is no width to hold against
    const asked = askedWidth(paned.position)
    if (asked >= PREVIEW_MIN_WIDTH) return // the drag is inside the pane's own width
    if (asked < PREVIEW_SNAP_SHUT_WIDTH) {
      log(
        `[preview] drag asks for a ${asked}px pane, under the ${PREVIEW_SNAP_SHUT_WIDTH}px snap width — closing it`,
      )
      fold(windowFitsStored())
      return
    }
    paned.position = total - PREVIEW_MIN_WIDTH - handleStrip()
  }

  /** Judge the pane once a drag has settled: at or above its floor the SLOT
   *  width becomes the stored width, below it the pane folds shut and the
   *  window's switch turns off. The judgement reads the same quantity the hold
   *  writes (`askedWidth`), not the width the pane reports about itself: the
   *  pane's own CSS edge sits inside that slot (see the module note), so a test
   *  on the reported width folds a pane the drag is holding at its floor.
   *  `resist` holds a drag at the floor, so this is the window that cannot give
   *  the pane its floor, and any other allocation that lands under it. */
  function settle(): void {
    if (dead) return
    if (!seeded) {
      apply() // first geometry event — the divider has not been seeded yet
      return
    }
    if (!session.enabled() || !pane.get_visible()) return
    if (pane.get_width() <= 0) return // not allocated yet — there is nothing to judge
    const width = askedWidth(paned.position)
    const settings = previewSettings()
    const fits = windowFitsStored()
    if (width < PREVIEW_MIN_WIDTH) {
      log(`[preview] pane ${width}px is below its ${PREVIEW_MIN_WIDTH}px minimum — closing it`)
      fold(fits)
      return
    }
    // The stored width is a SIDE-SLOT width, so the write needs the pane to be
    // sitting beside a visible list: in `full` mode the pane IS the body, and
    // the body's width coming back as the side-slot width would reopen the pane
    // window-wide with the list at a sliver. The list's own visibility is the
    // layout fact (the hosts hide it exactly when the pane takes the body), so a
    // host that keeps a side slot keeps storing it.
    const besideList = paned.get_start_child()?.get_visible() ?? false
    if (besideList && fits && !sameWidth(width, settings.width)) setPreviewWidth(width)
  }

  function scheduleSettle(): void {
    if (dead) return
    if (settleId !== null) GLib.source_remove(settleId)
    settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_DEBOUNCE_MS, () => {
      settleId = null
      settle()
      return GLib.SOURCE_REMOVE
    })
  }

  const positionId = paned.connect("notify::position", () => {
    resist() // a drag may not take the pane below its floor
    scheduleSettle()
  })
  const mapId = display.connect("map", () => apply())
  const visibleId = pane.connect("notify::visible", () => {
    if (pane.get_visible()) apply()
  })

  return () => {
    if (dead) return
    dead = true
    if (settleId !== null) {
      GLib.source_remove(settleId)
      settleId = null
    }
    paned.disconnect(positionId)
    display.disconnect(mapId)
    pane.disconnect(visibleId)
  }
}
