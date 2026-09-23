/**
 * The dock "appear" animation (icon birth / teardown).
 *
 * When a dock window is born (startup, rebuild after config reload, dock edge
 * change) the WHOLE
 * composition alpha-fades in — disc, rings, glyph/text, shadows, the overflow
 * caret + clock — uniformly: the factory draw wrappers paint the full drawIcon
 * into a cairo group and paint that group at `render.intro` alpha
 * (cr.pushGroup → drawIcon → popGroupToSource → paintWithAlpha(intro)).
 *
 * Forward (birth) runs over config.timing.appearAnim ms; reverse (teardown) over
 * config.timing.appearOutAnim ms (0 disables → instant). The progress is written to
 * the applet's render state (`render.intro`, 0..1) — the draw trampoline reads
 * it as the group alpha; the 9th DrawIcon param (`intro`) remains in the
 * signature but the wrappers pass 1 so the per-applet glyph
 * multiplication never double-fades against the group alpha.
 *
 * Reversible: startAppear(icon, { reverse: true }) eases toward 0 from the
 * icon's CURRENT progress (so a window that is itself mid-forward-intro
 * retracts from where it is — never a 1→0 snap), with the duration scaled by
 * the remaining distance (a fully-appeared icon retracts over the full
 * appearAnim). AppletWindow auto-plays forward on first map and exposes
 * playAppear(reverse) so rebuildDocks can retract the old dock before
 * destroying it.
 */

import GLib from "gi://GLib"
import { easeOutCubic } from "@common/anim/easings"
import { type FrameRunner, runFrames } from "@common/anim/run-frames"
import type { AppletConfig } from "@common/applets/config"
import type { RenderState } from "@common/applets/render-state"
import type { Gtk } from "ags/gtk4"

type AppearDone = () => void

/** Cubic ease-in (t³) — the time-mirror of easeOutCubic, used for the reverse. */
export const easeCubicIn = (t: number): number => t * t * t

interface AppearRun {
  startUs: number
  durationUs: number
  from: number
  to: number
  runner: FrameRunner | null
  onDone?: AppearDone
}

// Per-icon active run. startAppear supersedes any previous run for the same
// icon (its onDone fires immediately — "complete", since the new run takes over).
const runs = new Map<Gtk.DrawingArea, AppearRun>()

function clearRun(icon: Gtk.DrawingArea, run: AppearRun): void {
  run.runner?.cancel()
  run.runner = null
  if (runs.get(icon) === run) runs.delete(icon)
  run.onDone?.()
}

/** Completion-time cleanup: the runner source self-removes on the step's
 *  false return — do NOT cancel() it mid-callback (the runner marks itself
 *  inactive, making a later cancel a no-op). */
function finishRun(icon: Gtk.DrawingArea, run: AppearRun): void {
  run.runner = null // source is self-removing — nothing to cancel
  if (runs.get(icon) === run) runs.delete(icon)
  run.onDone?.()
}

/**
 * Cancel any in-progress appear run for the icon (used on widget destroy so a
 * tick callback can't fire on a destroyed surface).
 */
export function cancelAppear(icon: Gtk.DrawingArea): void {
  const run = runs.get(icon)
  if (run) clearRun(icon, run)
}

/**
 * Animate the icon's appear progress toward 0 (reverse) or 1 (forward) over
 * config.timing.appearAnim (forward) / appearOutAnim (reverse), scaled by the
 * remaining distance. Writes the eased
 * value to `render.intro` each frame and redraws. A previous run for the same
 * icon is superseded (its onDone fires immediately).
 */
export function startAppear(
  icon: Gtk.DrawingArea,
  render: RenderState,
  config: AppletConfig,
  opts: { reverse?: boolean; onDone?: AppearDone; ease?: (t: number) => number } = {},
): void {
  const prev = runs.get(icon)
  if (prev) clearRun(icon, prev)

  const duration = Math.max(
    0,
    opts.reverse ? config.timing.appearOutAnim : config.timing.appearAnim,
  )
  const to = opts.reverse ? 0 : 1
  const from = Math.max(0, Math.min(1, render.intro))

  if (duration <= 0 || Math.abs(to - from) < 0.001) {
    render.intro = to
    icon.queue_draw()
    opts.onDone?.()
    return
  }

  const durationUs = duration * Math.abs(to - from) * 1000
  const startUs = GLib.get_monotonic_time()
  const ease = opts.ease ?? (opts.reverse ? easeCubicIn : easeOutCubic)
  const run: AppearRun = { startUs, durationUs, from, to, runner: null, onDone: opts.onDone }

  const step = (nowUs: number): boolean => {
    const t = Math.min(1, (nowUs - startUs) / durationUs)
    const p = from + (to - from) * ease(t)
    render.intro = p
    icon.queue_draw()
    if (t >= 1) {
      render.intro = to
      icon.queue_draw()
      finishRun(icon, run)
      return false
    }
    return true
  }

  run.runner = runFrames(icon, step, config.timing.framerate)
  runs.set(icon, run)
}
