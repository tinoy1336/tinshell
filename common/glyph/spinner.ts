/**
 * createSpinnerGlyph — the shared spinning-glyph primitive. A square
 * Gtk.DrawingArea that draws
 * a Nerd Font glyph rotated by an animated angle. While spinning it rotates
 * continuously (~one revolution per 2.5s); when the spin ends it EASES back
 * to upright (0°) over ~250ms, THEN the tick stops — the "rotate back to
 * upright before stopping" rule shared with the dock applets' scan pill.
 *
 * The glyph is drawn via Cairo showText (GJS has neither cr.showLayout nor
 * layout.showInContext here) with the given Nerd Font family. The widget is
 * non-interactive by design (set_can_target(false)) — pure visual, never
 * swallows events or glows.
 *
 * Colours are plain [r, g, b, a] tuples (0..1) — no config coupling.
 */

import GLib from "gi://GLib"
import { easeOutCubic } from "@common/anim/easings"
import { type FrameRunner, runFrames } from "@common/anim/run-frames"
import { Gtk } from "ags/gtk4"

const SPIN_PERIOD_MS = 2500 // one full revolution
const EASE_BACK_MS = 250 // upright return

export interface SpinnerHandle {
  widget: Gtk.DrawingArea
  /** Start continuous rotation; false = ease back to upright then stop. */
  setSpinning(on: boolean): void
  readonly spinning: boolean
}

interface SpinRun {
  runner: FrameRunner | null
  active: boolean
  mode: "spin" | "ease"
  startUs: number
  durationUs: number
  from: number
  to: number
}

export function createSpinnerGlyph(opts: {
  /** Square drawing-area size. */
  size: number
  /** Glyph font size (defaults to `size` — pass smaller for row parity). */
  fontSize?: number
  /** Nerd Font glyph (or emoji codepoint) to rotate. */
  emoji: string
  /** Glyph colour, rgba 0..1. */
  colour: [number, number, number, number]
  /** Nerd Font family for the glyph. */
  fontFamily: string
  /** Ease back to upright on stop (the dock's "rest upright" rule).
   *  Default true — pass false for transient spinners that just stop. */
  easeBack?: boolean
}): SpinnerHandle {
  const da = new Gtk.DrawingArea()
  da.set_size_request(opts.size, opts.size)
  da.set_can_target(false) // pure visual — never swallow events / no glow
  let angle = 0
  let spinning = false
  let run: SpinRun | null = null

  const cancelRun = (): void => {
    if (run) {
      run.active = false
      run.runner?.cancel()
      run.runner = null
    }
    run = null
  }

  const start = (): void => {
    if (run && run.active && run.mode === "spin") return // already spinning
    cancelRun()
    spinning = true
    const startUs = GLib.get_monotonic_time()
    const r: SpinRun = {
      runner: null,
      active: true,
      mode: "spin",
      startUs,
      durationUs: 0,
      from: angle,
      to: 0,
    }
    run = r
    r.runner = runFrames(da, () => {
      if (!r.active) return false
      angle = r.from + ((GLib.get_monotonic_time() - startUs) / 1000 / SPIN_PERIOD_MS) * 2 * Math.PI
      da.queue_draw()
      return true
    })
  }

  const easeTo = (target: number): void => {
    spinning = false
    if (Math.abs(target - angle) < 0.005) {
      cancelRun()
      angle = target
      da.queue_draw()
      return
    }
    cancelRun()
    const from = angle
    const startUs = GLib.get_monotonic_time()
    const r: SpinRun = {
      runner: null,
      active: true,
      mode: "ease",
      startUs,
      durationUs: EASE_BACK_MS * 1000,
      from,
      to: target,
    }
    run = r
    r.runner = runFrames(da, () => {
      if (!r.active) return false
      const t = Math.min(1, (GLib.get_monotonic_time() - startUs) / r.durationUs)
      angle = from + (target - from) * easeOutCubic(t)
      da.queue_draw()
      if (t >= 1) {
        angle = target
        r.active = false
        run = null
        da.queue_draw()
        return false
      }
      return true
    })
  }

  da.set_draw_func((_d: any, cr: any, w: number, h: number) => {
    cr.save()
    cr.translate(w / 2, h / 2)
    if (Math.abs(angle) > 0.005) cr.rotate(angle)
    cr.selectFontFace(opts.fontFamily, 0, 0)
    cr.setFontSize(opts.fontSize ?? opts.size)
    const ext = cr.textExtents(opts.emoji)
    cr.moveTo(-ext.width / 2 - ext.xBearing, -ext.height / 2 - ext.yBearing)
    cr.setSourceRGBA(opts.colour[0], opts.colour[1], opts.colour[2], opts.colour[3])
    cr.showText(opts.emoji)
    cr.restore()
  })

  // Die with the widget: a parent close destroys the DA mid-spin — without
  // this, the tick keeps firing queue_draw on a destroyed DrawingArea and GTK
  // invokes the draw with an invalid context.
  da.connect("destroy", () => cancelRun())

  return {
    widget: da,
    setSpinning: (on) => {
      if (on) start()
      else if (opts.easeBack === false) {
        // Transient spinner: stop dead, no upright ease-back.
        cancelRun()
        angle = 0
        spinning = false
        da.queue_draw()
      } else easeTo(0)
    },
    get spinning() {
      return spinning
    },
  }
}
