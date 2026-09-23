/**
 * common/applets/shared/value-tick.ts — the animated numeric READOUT.
 *
 * A poll-backed reading (the CPU temperature in °C, the battery wattage in W)
 * does not jump to its new value: its digits walk there. ONE tick per readout
 * is that walk — it follows the applet's poll and eases the number the applet
 * paints frame by frame (`utils/smoother`), so the frames between the old and
 * the new reading carry intermediate values and the digits count through them
 * instead of snapping.
 *
 * The walk lasts `timing.tickAnim` ms at `timing.framerate`, and it ends at the
 * reading by itself: a settled tick holds no frame source and does no per-frame
 * work. A span of 0 (or a non-finite one) means the readout does not animate —
 * `peek()` answers the reading itself and no frame source is ever created.
 *
 * What starts a walk:
 *   - a reading that moved by more than `deadband` — the smallest change worth
 *     animating, in the reading's own unit (°C, W) — so poll jitter below it
 *     neither animates nor restarts the frame loop;
 *   - ONLY while the applet reports itself visible (`isVisible`): a hidden
 *     applet burns no frames, and the next reading while visible restarts the
 *     walk;
 *   - the reading that starts the FIRST walk is ADOPTED, never walked from
 *     nothing: the tick is built before its poll has answered once (or on the
 *     poll's own seed), so it holds no earlier reading to walk from — the first
 *     change paints at once and every later one walks.
 * A reading the source reports as ABSENT (`read` returns null — a failed read,
 * the pre-poll seed) is not a value: it neither animates nor moves the target,
 * so the digits stay where the last real reading left them.
 *
 * The tick formats nothing: the applet paints `peek()` with its own unit,
 * precision, placement and colour, exactly as it paints any other reading.
 */
import type Gtk from "gi://Gtk?version=4.0"
import type { AppletConfig } from "@common/applets/config"
import { createSmoother } from "@common/applets/utils/smoother"

/** The poll a tick follows: an applet backend's reactive or an ags Accessor. */
interface ValueTickSource<T> {
  peek: () => T
  subscribe: (callback: () => void) => () => void
}

interface ValueTickOpts<T> {
  /** The poll whose readings the readout follows. */
  source: ValueTickSource<T>
  /** The reading a source value carries, or null when it carries none. */
  read: (value: T) => number | null
  /** The widget whose frame clock drives the walk (the applet's icon). */
  widget: Gtk.Widget
  /** The host's live config view: `timing.tickAnim` + `timing.framerate`. */
  config: AppletConfig
  /** Smallest change worth animating, in the reading's own unit. */
  deadband: number
  /** Whether the applet is on screen; omitted = always visible. */
  isVisible?: () => boolean
}

interface ValueTick {
  /** The reading to paint this frame, eased toward the newest one. */
  peek: () => number
  /** Release the poll subscription (applet unmount). */
  dispose: () => void
}

export function createValueTick<T>(opts: ValueTickOpts<T>): ValueTick {
  const first = opts.read(opts.source.peek())
  // `target` is the reading the digits head to: it follows the poll even when a
  // change is too small to animate, so a walk already running absorbs it.
  // `kicked` is the reading that last started or adopted a walk — the deadband
  // is measured against it rather than against the moving target, so drift that
  // never exceeds the deadband in a single step still animates once it does.
  let target = first ?? 0
  let kicked = first
  const isVisible = opts.isVisible ?? (() => true)

  const smoother =
    opts.config.timing.tickAnim > 0
      ? createSmoother(
          () => target,
          opts.widget,
          opts.config,
          opts.config.timing.tickAnim,
          opts.deadband,
          isVisible,
        )
      : null

  const unsubscribe = opts.source.subscribe(() => {
    const reading = opts.read(opts.source.peek())
    if (reading === null) return
    target = reading
    if (!isVisible()) return
    if (kicked !== null && Math.abs(reading - kicked) <= opts.deadband) return
    kicked = reading
    smoother?.kick()
  })

  return {
    peek: () => (smoother ? smoother.peek() : target),
    dispose: () => unsubscribe(),
  }
}
