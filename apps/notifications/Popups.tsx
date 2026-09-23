/**
 * Popups — the floating notification surface (swaync's notification window).
 *
 * ONE full-screen overlay layer surface (namespace "notifications-popup"),
 * cards stacked top-centre, newest first. The surface's INPUT REGION is the
 * union of the visible card rects — everything outside the cards is
 * click-through (swaync's layer-shell-cover-screen + set_input_region model).
 * The region only takes effect on a surface commit, so every region update is
 * followed by queue_draw() (the dock scrim's proven pattern on this machine).
 *
 * Cards are managed IMPERATIVELY (append/destroy by id) so the per-card
 * appear animation doesn't replay on unrelated list changes and the input
 * region follows exactly the mapped cards. A replaced notification (same id)
 * gets a fresh card.
 *
 * Every card sits in its own Gtk.Revealer SLOT. A dismissal collapses that
 * slot's height over `timing.transitionMs` (the revealer re-requests its height
 * every frame while its SLIDE_UP transition runs), so the column re-lays out
 * continuously and the cards below SLIDE up into the vacated gap; the slot is
 * dropped only once the collapse has finished. Nothing remaps the window: a
 * hide/show cycle re-realizes the surviving cards, and NotificationCard's
 * appear fade is bound to their `realize` signal, so every survivor would
 * replay the entry animation instead of moving.
 */

import cairo from "gi://cairo"
import GLib from "gi://GLib"
import { createEffect } from "ags"
import { Astal, Gtk } from "ags/gtk4"
import { get } from "./config"
import { ignore, log } from "./log"
import { notifications, popupIds } from "./Notifd"
import NotificationCard from "./NotificationCard"

// Astal.WindowAnchor has NO `ALL` member (enum: NONE/TOP/RIGHT/LEFT/BOTTOM) —
// the explicit OR is the full-screen form (the dock scrim's).
const FULL =
  Astal.WindowAnchor.TOP |
  Astal.WindowAnchor.BOTTOM |
  Astal.WindowAnchor.LEFT |
  Astal.WindowAnchor.RIGHT

export default function Popups(): Astal.Window {
  let win: Astal.Window
  let column: Gtk.Box
  // Last input-region geometry written, so the log line fires on a real
  // change instead of on every layout pass (this call is the 150ms tick's
  // whole body while popups are up).
  let lastInputRegion = ""
  /** Live cards by notification id. An id leaves this map when its exit starts,
   *  so a reconcile running during that exit can never remove it twice. */
  const cards = new Map<number, Gtk.Widget>()
  /** Each live card's animated slot, by notification id. */
  const slots = new Map<number, Gtk.Revealer>()
  /** Slots collapsing on their way out. They stay in the column until the
   *  collapse ends — their shrinking height IS the gap the cards below slide
   *  into. */
  const exiting = new Set<Gtk.Revealer>()

  const exitMs = (): number => get<number>("timing.transitionMs", 200)

  /** Map the overlay while any card is shown OR any exit is still collapsing: a
   *  dismissed card's own exit has to stay visible, and the surface must not
   *  blink out from under the cards that are sliding. */
  function syncVisibility(): void {
    if (!win) return
    const up = popupIds().length > 0 || exiting.size > 0
    if (up && !win.visible) win.visible = true
    else if (!up && win.visible) win.visible = false
  }

  /** Wrap a card in its slot. The card's bottom margin carries the stack
   *  spacing INSIDE the revealer, so a collapse takes the gap with it and
   *  removing the spent slot afterwards moves nothing. */
  function makeSlot(card: Gtk.Widget): Gtk.Revealer {
    const slot = new Gtk.Revealer()
    // A SLIDE_* transition is required, not CROSSFADE: GtkRevealer scales the
    // child's measured size by the transition position only for the slide (and
    // swing/fade-slide) types — CROSSFADE's scale is 1.0, so a crossfading slot
    // hides its card but keeps the vacated height, and the column would then
    // SNAP when the spent slot is dropped. SLIDE_UP collapses the height on
    // every frame, which is what carries the cards below up into the gap.
    slot.set_transition_type(Gtk.RevealerTransitionType.SLIDE_UP)
    card.set_margin_bottom(get<number>("popup.spacing", 8))
    slot.set_child(card)
    // Revealed while the duration is still 0: the slot must appear at full size
    // (the card's own realize fade is the entry animation) and must not slide
    // in on its own account.
    slot.set_transition_duration(0)
    slot.set_reveal_child(true)
    return slot
  }

  /** Collapse one card's slot, then drop it. The collapse IS the reflow: the
   *  revealer reports a shrinking height on every frame, so the column
   *  re-allocates the cards below it continuously while the card fades out. */
  function startExit(id: number): void {
    const slot = slots.get(id)
    const card = cards.get(id)
    if (!slot || !card) return
    slots.delete(id)
    cards.delete(id)
    const dur = exitMs()
    slot.set_transition_duration(dur)
    exiting.add(slot)
    slot.set_reveal_child(false)
    // The slot's transition collapses the HEIGHT the dismissed card occupies,
    // but a revealer still paints the child it is collapsing, so the card would
    // keep its full face while the cards below slide up underneath it. Fading
    // it over the same interval is what takes the card itself off the screen.
    const durUs = dur * 1000
    if (dur > 0) {
      const t0 = GLib.get_monotonic_time()
      const runner = (card as any).add_tick_callback(() => {
        const t = Math.min(1, (GLib.get_monotonic_time() - t0) / durUs)
        card.opacity = 1 - t
        return t < 1
      })
      if (runner === 0) card.opacity = 0
    } else {
      card.opacity = 0
    }
    log(`popup exiting card id=${id} collapse=${dur}ms`)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, dur + 40, () => {
      exiting.delete(slot)
      try {
        column.remove(slot)
      } catch (e) {
        // The column (and the window with it) is already gone.
        ignore("popup slot removal", e)
      }
      syncVisibility()
      updateInputRegion()
      return GLib.SOURCE_REMOVE
    })
  }

  function updateInputRegion(): void {
    if (!win || !win.visible) return // unmapped surface commits nothing
    try {
      const surface = win.get_surface()
      if (!surface) return
      const region: any = new (cairo as any).Region()
      // The column's allocation IS the bounding box of the cards (vertical
      // box, fixed width) — and it self-corrects on every reflow (card
      // add/remove/height change). Per-card rects went stale: the idle
      // recompute after a removal ran BEFORE the layout reflow, so clicks
      // landed outside the region (the ✕/action “dead click” bug).
      const [ok, x, y] = column.translate_coordinates(win, 0, 0)
      if (ok) {
        const alloc = column.get_allocation()
        if (alloc.width > 0 && alloc.height > 0) {
          region.unionRectangle({
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(alloc.width),
            height: Math.round(alloc.height),
          })
        }
        const geometry = `${Math.round(x)}x${Math.round(y)} ${Math.round(alloc.width)}x${Math.round(alloc.height)}`
        if (geometry !== lastInputRegion) {
          lastInputRegion = geometry
          log(`input region set: ${geometry}`)
        }
      }
      surface.set_input_region(region)
      // Region changes apply on the next committed frame — force the commit.
      win.queue_draw()
    } catch (e) {
      log(`updateInputRegion failed: ${e}`)
    }
  }

  // Recompute when the column reflows (the layout-corrected pass).
  function watchColumn(): void {
    column.connect("notify::allocation", () => {
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        updateInputRegion()
        return GLib.SOURCE_REMOVE
      })
    })
  }

  // Race-proof region: a periodic refresh while popups are visible. The idle
  // recompute after a reconcile runs BEFORE layout (the column's allocation
  // is still 0-height), and the notify::allocation watcher can miss the
  // real height — the click region then doesn't cover the cards and every
  // click falls through (eaten by surfaces below, e.g. the dock scrim). A
  // 150ms tick while popupIds is non-empty keeps the region on the cards.
  let regionTick: number | null = null
  function armRegionTick(): void {
    if (regionTick !== null) return
    regionTick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
      if (popupIds().length === 0 && exiting.size === 0) {
        regionTick = null
        return GLib.SOURCE_REMOVE
      }
      updateInputRegion()
      return GLib.SOURCE_CONTINUE
    })
  }

  // Reconcile the card children against popupIds().
  createEffect(() => {
    const ids = popupIds()
    // A card no longer shown EXITS first (fade + height collapse) instead of
    // being detached: detaching it re-lays out the column in one step, which is
    // the jump this window must not have.
    for (const id of [...cards.keys()]) {
      if (!ids.includes(id)) {
        log(`popup removing card id=${id}`)
        startExit(id)
      }
    }
    // Map the full-screen overlay while cards are shown or an exit is running —
    // an unmapped surface commits nothing, so it can't damage the compositor
    // when idle.
    syncVisibility()
    // Diagnostics: does the column still hold widgets after reconciliation?
    let children = 0
    let child = column.get_first_child()
    while (child) {
      children++
      child = child.get_next_sibling()
    }
    log(`popup reconcile: popupIds=${ids.length} cards=${cards.size} columnChildren=${children}`)
    // Append new cards in popup order (newest first — append keeps that order).
    for (const id of ids) {
      if (cards.has(id)) continue
      const noti = notifications().find((n) => n.id === id)
      if (!noti) {
        log(`popup id=${id} has no notification object — skipping`)
        continue
      }
      const card = NotificationCard({ noti, variant: "popup" })
      const slot = makeSlot(card)
      cards.set(id, card)
      slots.set(id, slot)
      column.append(slot)
      // Armed only now: the slot above is already fully revealed, so this is
      // the duration its eventual EXIT collapses over, never an entry slide.
      slot.set_transition_duration(exitMs())
      armRegionTick()
    }
    syncVisibility()
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      updateInputRegion()
      return GLib.SOURCE_REMOVE
    })
  })

  // @ts-expect-error runtime object is typed as Type 'Object' is missing the following p by @girs; safe cast
  return (
    <window
      namespace="notifications-popup"
      class="notifications-popup"
      name="notifications-popup"
      layer={Astal.Layer.OVERLAY}
      keymode={Astal.Keymode.NONE}
      exclusivity={Astal.Exclusivity.IGNORE}
      anchor={FULL}
      resizable
      visible={false}
      $={(self) => {
        win = self
        self.connect("map", () => {
          self.get_surface?.()?.set_opaque_region?.(null)
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            updateInputRegion()
            return GLib.SOURCE_REMOVE
          })
        })
        self.connect("notify::allocation", () => {
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            updateInputRegion()
            return GLib.SOURCE_REMOVE
          })
        })
        // Stale-frame insurance: after a suspend/resume an idle EMPTY surface
        // never repaints, leaving the last painted frame (a ghost card that's
        // untracked + click-through — the "Pi: Hibernating" case). Nudge a
        // repaint every 15s while no popups are shown; the repaint clears any
        // stale frame (a repaint of an empty surface is a no-op otherwise).
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
          if (popupIds().length === 0) self.queue_draw()
          return GLib.SOURCE_CONTINUE
        })
      }}
    >
      <box
        $={(ref) => {
          column = ref
          ref.set_size_request(get<number>("popup.width", 360), -1)
          watchColumn()
        }}
        class="popup-column"
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.START}
        orientation={Gtk.Orientation.VERTICAL}
        spacing={0}
        marginTop={8}
      />
    </window>
  )
}
