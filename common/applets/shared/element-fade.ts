/**
 * common/applets/shared/element-fade.ts — the cross-fade of ONE element's own
 * inputs.
 *
 * An applet DECLARES the elements it wants faded: it creates a fade for each
 * of them (`createElementFade`) and paints that element through it. An applet
 * that creates none has nothing that can fade, and a change no applet declared
 * paints at once, in one ordinary paint, at full opacity.
 *
 * The transition animates the element's OWN INPUTS: on a change the element is
 * painted TWICE inside the same ordinary paint — its outgoing state at alpha
 * (1 − eased t) and its incoming state at eased t — so the frame holds moving
 * values rather than a replayed recording of an earlier frame. At t = 1 (and
 * whenever no transition runs) the element paints once at alpha 1. The rest of
 * the applet is untroubled by the fade: it paints once per frame, at full
 * opacity, exactly as it does today.
 *
 * Which changes fade is the applet's declaration, and `id` is its granularity:
 * a change fades when BOTH the element's painted state and its `id` move, so an
 * element whose painted value is also driven by an input that must NOT fade can
 * pass that input's own identity as `id` and snap on it. A declaration that
 * passes none fades on the value it paints, so every change of that value
 * cross-fades.
 *
 * A move of the painted state ALONE is adopted, but it never ends a transition
 * that `id` declared: the identity change stays the thing being animated, and
 * the move only decides what that transition's incoming side paints. Such a
 * move and an identity change can land on adjacent frames — an element whose
 * state carries a value that eases on its own does exactly that — and ending
 * the fade on the second frame would paint the incoming state at full opacity
 * one frame into it, i.e. snap the very change the applet declared as fadeable.
 *
 * Cost: a transition owns a frame source that runs only between the change and
 * t = 1 — `timing.fadeAnim` ms at `timing.framerate`. A settled element paints
 * once per ordinary paint and holds no frame source at all; `timing.fadeAnim`
 * of 0 (or a non-finite value) makes every change instant, and no tween is ever
 * created. Duration and easing are read from the live config at transition
 * start.
 *
 * Every declaration in the process is listed by the `fade status` probe
 * (element, transition state, frame and paint counters) — the same
 * side-effect-free status surface `lazy status` provides.
 */
import GLib from "gi://GLib"
import { easeCubicInOut, easeOutCubic } from "@common/anim/easings"
import { type FrameRunner, runFrames } from "@common/anim/run-frames"
import type { AppletWindow } from "@common/applets/applet-window"
import type { AppletConfig } from "@common/applets/config"
import { register } from "@common/commands/registry"

/** The easing curves `timing.fadeEasing` selects (common/anim/easings). */
const EASINGS: Record<string, (t: number) => number> = {
  linear: (t: number) => t,
  easeOut: easeOutCubic,
  easeInOut: easeCubicInOut,
}

export interface ElementFade<T> {
  /**
   * Paint the element at `state`.
   *
   * `painter` paints ONE state: it receives the state and the alpha that state
   * paints at, and must apply that alpha to the element's own colours. Call
   * this once per paint of the applet's draw function. Settled (and at
   * `timing.fadeAnim` 0) `painter` is called once with alpha 1; during a
   * transition it is called twice — the outgoing state at (1 − eased t), then
   * the incoming state at eased t.
   *
   * `id` is the change identity this element fades on; it defaults to the state
   * itself. Pass it only where the painted state moves for reasons that must
   * NOT fade.
   */
  paint: (state: T, painter: (state: T, alpha: number) => void, id?: string) => void
  /** Cancel any running transition and drop the declaration (unmount). */
  dispose: () => void
}

/** One mounted applet's declared element. Two rows can mount the same applet in
 *  one process (a per-monitor dock), so the registry is a set of per-mount
 *  entries rather than a name-keyed map. */
interface FadeEntry {
  applet: string
  element: string
  debug: () => string
}

const entries = new Set<FadeEntry & { dispose: () => void }>()

/** Every declared fade element in this process (status/debug). */
function fadeEntries(): FadeEntry[] {
  return [...entries]
}

register(["fade", "status"], (_args, res) => {
  const list = fadeEntries()
  res(
    list.length
      ? list.map((e) => e.debug()).join("\n")
      : "no fade-eligible element declared by any mounted applet",
  )
})

/** Declare `element` of the applet `aw` as fade-eligible and return its fade. */
export function createElementFade<T>(
  aw: AppletWindow,
  config: AppletConfig,
  element: string,
): ElementFade<T> {
  const icon = aw.icon
  // The element's last painted state and the identity it fades on. `outgoing`
  // is the state the running transition is fading away from.
  let incoming: T | null = null
  let incomingId: string | null = null
  let outgoing: T | null = null
  // 1 = settled (one paint at alpha 1); < 1 = the eased fraction painted from
  // the outgoing state.
  let progress = 1
  let startUs = 0
  let runner: FrameRunner | null = null
  let transitions = 0
  let frames = 0
  let paints = 0

  function settle(): void {
    progress = 1
    outgoing = incoming
    runner = null // the frame source self-removes on the step's false return
  }

  /** Start the transition toward the current incoming state. */
  function startTween(): void {
    runner?.cancel()
    runner = null
    const ms = config.timing.fadeAnim
    if (!(ms > 0)) {
      // No transition configured (0, absent or non-finite): paint at once.
      settle()
      return
    }
    const ease = EASINGS[config.timing.fadeEasing] ?? ((t: number) => t)
    const durationUs = ms * 1000
    startUs = GLib.get_monotonic_time()
    transitions++
    runner = runFrames(
      icon,
      (nowUs: number): boolean => {
        const t = Math.min(1, (nowUs - startUs) / durationUs)
        progress = ease(t)
        frames++
        icon.queue_draw()
        if (t >= 1) {
          settle()
          return false
        }
        return true
      },
      config.timing.framerate,
    )
  }

  function paint(state: T, painter: (state: T, alpha: number) => void, id?: string): void {
    const stateId = id ?? String(state)
    if (incoming === null) {
      // First paint after mount: nothing to fade from.
      incoming = state
      incomingId = stateId
      outgoing = state
      painter(state, 1)
      paints++
      return
    }
    const idChanged = stateId !== incomingId
    const valueChanged = String(state) !== String(incoming)
    if (idChanged && valueChanged) {
      outgoing = incoming
      incoming = state
      incomingId = stateId
      progress = 0
      startTween()
    } else if (idChanged) {
      // The identity moved on its own: a change the applet did not declare as
      // fadeable for this element. Adopt it and paint it at once.
      runner?.cancel()
      runner = null
      incoming = state
      incomingId = stateId
      settle()
    } else if (valueChanged) {
      // The painted state moved while its identity held: adopt the new state. A
      // transition already running KEEPS RUNNING — it is the identity change's
      // animation, and this move only changes what its incoming side paints.
      incoming = state
      if (runner === null) settle()
    }
    if (progress >= 1) {
      painter(state, 1)
      paints++
      return
    }
    painter(outgoing as T, 1 - progress)
    painter(state, progress)
    paints += 2
  }

  const entry = {
    applet: aw.name,
    element,
    debug: () =>
      `${aw.name}.${element} running=${runner !== null} progress=${progress.toFixed(3)}` +
      ` transitions=${transitions} frames=${frames} paints=${paints}`,
    dispose: () => {
      runner?.cancel()
      runner = null
      entries.delete(entry)
    },
  }
  entries.add(entry)

  return {
    paint,
    dispose: entry.dispose,
  }
}

/** The canvas alpha an element's own colours are multiplied by — the ONE
 *  spelling of the crossfade's weight so a painter of a multi-part element
 *  (glyph + shadow) applies the same number to every part. */
export function withFadeAlpha(
  colour: [number, number, number, number],
  alpha: number,
): [number, number, number, number] {
  return [colour[0], colour[1], colour[2], colour[3] * alpha]
}
