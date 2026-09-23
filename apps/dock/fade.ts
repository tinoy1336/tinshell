/**
 * Whole-window opacity fades for the dock surface: fade-in on map (first
 * show at startup, and each rebuild's fresh surface) and fade-out on the
 * quit path. Fast ~200ms fades driven by the shared per-frame primitive
 * (@common/anim/run-frames — owns the add_tick_callback/unrealized-widget
 * bookkeeping) + easeOutCubic.
 *
 * The quit fade is SYNCHRONOUS (fadeOutAllSync): the shim's quit path
 * (App.quit → g_application_quit → exit(code)) hard-exits before the main
 * loop ever returns, so nothing async would paint a frame. The sync helper
 * instead pumps the default main context by hand so the frame clock can
 * paint each step. Bounded by a wall-clock deadline: never blocks past
 * ms + 250ms.
 *
 * Opt-in per-frame sampling: set DOCK_FADE_DEBUG=1 to print the opacity
 * trajectory (probe hook for headless verification).
 */
import GLib from "gi://GLib"
import type Gtk from "gi://Gtk?version=4.0"
import { easeOutCubic } from "@common/anim/easings"
import { type FrameRunner, runFrames } from "@common/anim/run-frames"

/** The fast fade the dock uses for both directions. */
const FADE_MS = 200

const FADE_DEBUG = !!GLib.getenv("DOCK_FADE_DEBUG")
if (FADE_DEBUG) print("[fade] module loaded")

// One live fade per widget — a new fade cancels the previous runner so an
// overlapping map/quit fade can never fight over the opacity property.
const runners = new WeakMap<Gtk.Widget, FrameRunner>()

function killPrevious(widget: Gtk.Widget): void {
  runners.get(widget)?.cancel()
}

/** Animate widget opacity → `to` over `ms` (easeOutCubic). */
function animateOpacity(widget: Gtk.Widget, to: number, ms: number, onDone?: () => void): void {
  killPrevious(widget)
  const from = widget.opacity
  const start = GLib.get_monotonic_time()
  const runner = runFrames(widget, (nowUs: number): boolean => {
    const t = Math.min(1, (nowUs - start) / (ms * 1000))
    widget.opacity = from + (to - from) * easeOutCubic(t)
    if (FADE_DEBUG) print(`[fade] ${t.toFixed(3)} → opacity ${widget.opacity.toFixed(3)}`)
    if (t >= 1) {
      runners.delete(widget)
      onDone?.()
      return false
    }
    return true
  })
  runners.set(widget, runner)
}

/** Fade-in on map. The surface is created at opacity 0 (see DockSurface). */
export function fadeIn(widget: Gtk.Widget, ms = FADE_MS): void {
  if (FADE_DEBUG) print(`[fade] fadeIn: mapped=${widget.get_mapped?.()} opacity=${widget.opacity}`)
  if (widget.opacity >= 1) return
  animateOpacity(widget, 1, ms)
}

/**
 * Fade EVERY given window out concurrently and return only when all fades
 * finished (or the deadline fired). Unmapped windows just snap to 0 — there
 * is no visible to animate. Used by `dock quit`; do not call this from
 * interactive code (it blocks the caller by design).
 */
export function fadeOutAllSync(widgets: Gtk.Widget[], ms = FADE_MS): void {
  if (FADE_DEBUG)
    print(
      `[fade] fadeOutAllSync: n=${widgets.length} mapped=${widgets.map((w) => !!w.get_mapped?.()).join(",")}`,
    )
  let pending = 0
  const fading: Gtk.Widget[] = []
  for (const w of widgets) {
    if (!w.get_mapped?.() || w.opacity <= 0) {
      // Unmapped = nothing visible to animate; opacity 0 = already faded.
      w.opacity = 0
      continue
    }
    pending++
    fading.push(w)
    animateOpacity(w, 0, ms, () => {
      pending--
    })
  }
  if (pending === 0) return
  const deadlineUs = GLib.get_monotonic_time() + (ms + 250) * 1000
  const ctx = GLib.main_context_default()
  while (pending > 0 && GLib.get_monotonic_time() < deadlineUs) {
    try {
      ctx.iteration(true)
    } catch (_) {
      break
    }
  }
  // Deadline guard / clock-starved fallback: never leave a dock half-faded.
  for (const w of fading) if (w.opacity > 0) w.opacity = 0
}
