import type Gtk from "gi://Gtk?version=4.0"
import { type FrameRunner, runFrames } from "@common/anim/run-frames"
import type { AppletConfig } from "@common/applets/config"

/**
 * Per-frame value smoother. Lerps toward a target each frame and stops when
 * close enough. Designed for ring values (0–100) updated by polls — use in
 * draw functions via peek() and kick() from poll subscriptions.
 *
 * Uses widget.add_tick_callback (frame-synced, fast) with GLib.timeout_add
 * fallback for unrealized widgets.
 *
 * @param durationMs  Span of the easing so the ring is always in motion
 *                    between poll ticks. Omit or pass 0 for default factor.
 */
interface Smoother {
  peek: () => number
  kick: () => void
}

export function createSmoother(
  getTarget: () => number,
  widget: Gtk.Widget,
  config: AppletConfig,
  factorOrDurationMs: number = 0,
  deadband: number = 2,
  isVisible: () => boolean = () => true,
): Smoother {
  // If > 1, treat as duration in ms; otherwise raw factor.
  const factor =
    factorOrDurationMs > 1
      ? 1 - 0.01 ** (1 / ((factorOrDurationMs * config.timing.framerate) / 1000))
      : factorOrDurationMs || 0.3

  // Captured on the FIRST kick, never at construction: a poll-backed target is
  // still reading its placeholder (the poll's init) when the smoother is built,
  // and a smoother seeded there holds that placeholder until an animation
  // happens to run — a ring painting a value it never sampled. Where the kick is
  // additionally gated on visibility (Performance's rings), the first real
  // sample can be dropped entirely and the ring stays on the placeholder. Until
  // the first kick, peek() reports the live target, so the first paint is real.
  let current = getTarget()
  let seeded = false
  let running = false
  let runner: FrameRunner | null = null

  function clearAnim(): void {
    runner?.cancel()
    runner = null
    running = false
  }

  function step(): boolean {
    // Hidden (e.g. dock ghosted): stop the frame loop entirely — no redraw,
    // no 60fps burn. The next kick (on the next poll while visible) restarts.
    if (!isVisible()) {
      running = false
      runner = null
      return false
    }
    const target = getTarget()
    const diff = target - current
    if (Math.abs(diff) < 0.8) {
      current = target
      // Self-removal via the false return — null the runner without
      // cancel() (the source is mid-dispatch; the runner marks itself
      // inactive so a later cancel no-ops).
      running = false
      runner = null
      return false
    }
    current += diff * factor
    widget.queue_draw()
    return true
  }

  function start(): void {
    if (running) return
    running = true
    runner = runFrames(widget, step, config.timing.framerate)
  }

  return {
    peek: () => (seeded ? current : getTarget()),
    kick: () => {
      if (!seeded) {
        // First kick: adopt the live value (nothing to animate from).
        seeded = true
        current = getTarget()
      }
      const target = getTarget()
      if (Math.abs(target - current) > deadband) start()
    },
  }
}
