/**
 * Fully-charged counter — how long the pack has been sitting plugged-and-idle,
 * as the text the battery applet paints on its glyph.
 *
 * The state is the one the colour policy already encodes (AC present with the
 * pack neither filling nor draining: sysfs `Full` or `Not charging`). This
 * module owns the OTHER half of that: when the state BEGAN, and the text for how
 * long ago that was.
 *
 * The start time is durable (the caller passes its store in — the battery
 * domain's MACHINE-level `pluggedSinceStore`, so the session and the pre-login
 * greeter read the SAME start time), because the state began when the pack
 * BECAME idle, not when the process started: a host restart while the machine is
 * still plugged-and-idle must RESUME the count, not restart it. Two consequences
 * the applet relies on:
 *
 *   - a stamp of 0 means NO start time is on record (epoch 0 is not an
 *     observation), which is also how leaving the state is recorded;
 *   - a machine that BOOTS already in the state has no record of when it began,
 *     so the first observation becomes the start — a boot already topped-out
 *     reads from boot, never from an invented earlier time.
 *
 * Pure: no gi, no GTK, no config — the store arrives as two functions, so the
 * probe beside this module drives it under plain Node.
 */
import { formatElapsed } from "@common/applets/shared/elapsed"

/** The durable start-time record. `read()` answers 0 when nothing is on record;
 *  `write(0)` clears it. */
interface ChargeStampStore {
  read: () => number
  write: (epochSeconds: number) => void
}

interface ChargeCounter {
  /** Feed the plugged-and-idle state at `now` (epoch SECONDS). True when that
   *  changed whether the counter runs — the caller repaints on it. */
  observe: (pluggedIdle: boolean, now: number) => boolean
  /** The text to paint at `now`, or "" while the state is not running. */
  text: (now: number) => string
  /** True while the pack is being counted. */
  active: () => boolean
}

export function createChargeCounter(store: ChargeStampStore): ChargeCounter {
  // The state is only entered when it is OBSERVED, so a stored stamp waits here:
  // it is the resume point for the first observation that finds the pack idle,
  // and it paints nothing until such an observation arrives.
  const stored = store.read()
  let resumeAt: number | null = Number.isFinite(stored) && stored > 0 ? stored : null
  let since: number | null = null
  return {
    observe(pluggedIdle: boolean, now: number): boolean {
      if (pluggedIdle) {
        if (since !== null) return false
        since = resumeAt ?? now
        resumeAt = null
        store.write(since)
        return true
      }
      if (since === null) return false
      since = null
      store.write(0)
      return true
    },
    text(now: number): string {
      return since === null ? "" : formatElapsed(now - since)
    },
    active: () => since !== null,
  }
}
