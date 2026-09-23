/**
 * Low-battery warning latch — the ONE rule for when the battery applet raises
 * its low-percentage notification.
 *
 * The warning is CROSSING driven, not level driven: it fires on the single
 * reading that brings the level to or below the threshold from above, and stays
 * silent for every reading at or below it after that. The level climbing back
 * ABOVE the threshold re-arms the latch, so the next descent warns once again.
 *
 * A charging battery never warns, and charging does NOT consume the latch: a
 * battery plugged in below the threshold warns as soon as it is unplugged while
 * still below it.
 *
 * Both inputs are read AT DECISION TIME, never captured:
 *
 *   - the LEVEL, because the applet's config tier is live and a live-tier set
 *     only redraws — a level captured at mount would ignore it until a rebuild;
 *   - the already-warned FLAG, because more than one surface can host this
 *     applet at once (the in-session lock screen mounts the same strip) and the
 *     durable flag is the only state they share.
 *
 * Reading either input can never ARM the latch: only a rise back above the level
 * arms it, so a poll, a redraw, a restart, or another surface's write can
 * suppress a warning but never cause one.
 *
 * The pre-poll seed (100 %, status `Unknown`) is not a reading and never reaches
 * this latch: the latch is fed by battery CHANGES only, and the reactive's
 * subscription does not fire for the value it already holds.
 *
 * Pure: no gi, no GTK, no state store — the probe beside this module drives it
 * under plain Node.
 */

/** The reading the latch judges (a full BatteryState carries more). */
export interface LowWarningReading {
  percentage: number
  status: string
}

export type LowWarningAction = "warn" | "rearm" | "idle"

/** The decision for one reading: `warn` on the crossing that reaches the
 *  threshold, `rearm` on the reading that climbs back above it, else `idle`. */
export function lowWarningStep(
  reading: LowWarningReading,
  threshold: number,
  warned: boolean,
): LowWarningAction {
  if (reading.percentage > threshold) return warned ? "rearm" : "idle"
  // Charging is refilling the battery: never warn, and leave the latch as it
  // is so a plugged-in battery below the threshold still warns on unplug.
  if (reading.status === "Charging") return "idle"
  return warned ? "idle" : "warn"
}

interface LowWarningLatch {
  /** Feed one reading: performs the action the latch decides and returns it. */
  handle: (reading: LowWarningReading) => LowWarningAction
  /** True once the warning has fired and has not been re-armed. */
  warned: () => boolean
}

export function createLowWarningLatch(opts: {
  /** The level, read at decision time — a live config key must not be captured. */
  threshold: () => number
  /** Whether this descent has already been announced, read at decision time so
   *  another surface's write is seen. What it answers is never used to ARM. */
  warned: () => boolean
  onWarn: (percentage: number) => void
  onRearm: () => void
}): LowWarningLatch {
  // In-process mirror of the flag: a store whose own write failed must not let
  // this process warn again on every poll.
  let sent = opts.warned()
  const isWarned = (): boolean => sent || opts.warned()
  return {
    handle(reading: LowWarningReading): LowWarningAction {
      const action = lowWarningStep(reading, opts.threshold(), isWarned())
      // The mirror turns BEFORE the callback runs: a callback that throws must
      // not leave the latch armed and warn again on the next poll.
      if (action === "warn") {
        sent = true
        opts.onWarn(reading.percentage)
      } else if (action === "rearm") {
        sent = false
        opts.onRearm()
      }
      return action
    },
    warned: isWarned,
  }
}
