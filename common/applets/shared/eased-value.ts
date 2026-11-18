/**
 * common/applets/shared/eased-value.ts — the per-frame value sweep every ring
 * and dial reads.
 *
 * An applet's ring does not jump to its new reading: each frame moves a fixed
 * fraction of what is left, so a sweep's length scales with the size of the
 * change, and the value SNAPS onto the reading as it settles — a caller that
 * stops its frame loop on the `false` return therefore knows the painted value
 * is exactly the reading's. The same shape drives the closed-state ring in
 * `create-applet-core.ts` and the overflow dial's rim scale.
 *
 * Frames come from the CALLER: this module is stepped by whatever loop the
 * surface already runs (`runFrames` in the core, the clock's own loop in the
 * dock), so it owns no frame source and holds no timer. `initial: null` means
 * no reading yet: the first `advance` ADOPTS it instead of sweeping from a
 * made-up value.
 *
 * Pure: no gi, no GTK, no config.
 */

/** The fraction of the remaining distance one frame closes. */
export const EASE_FACTOR = 0.3

/** Distances under this are the reading itself: the value snaps and reports
 *  itself settled. */
export const EASE_EPSILON = 0.3

export interface EasedValue {
  /** The value to paint: the eased value, snapped to its reading once settled. */
  readonly value: number
  /** True while a frame still moved it — the frame loop has work to do. */
  readonly moving: boolean
  /** True once a reading has been adopted. False only before the first reading,
   *  when `behind` answers false for EVERY value — a caller that arms a frame
   *  loop on `behind` alone therefore never seeds a fresh lane. */
  readonly seeded: boolean
  /** True when it is not yet on `reading` (false before its first reading). */
  behind: (reading: number) => boolean
  /** Advance one frame toward `reading`. False once settled on it. */
  advance: (reading: number) => boolean
  /** Land on `reading` at once, no sweep — a transition that animates another
   *  way (a source cross-fade) must not sweep the value as well. */
  adopt: (reading: number) => void
}

export function createEasedValue(initial: number | null): EasedValue {
  let value = initial ?? 0
  let seeded = initial !== null
  let moving = false
  return {
    get value() {
      return value
    },
    get moving() {
      return moving
    },
    get seeded() {
      return seeded
    },
    behind: (reading) => seeded && Math.abs(reading - value) >= EASE_EPSILON,
    advance: (reading) => {
      if (!seeded) {
        seeded = true
        value = reading
        moving = false
        return false
      }
      const diff = reading - value
      if (Math.abs(diff) < EASE_EPSILON) {
        value = reading
        moving = false
        return false
      }
      value += diff * EASE_FACTOR
      moving = true
      return true
    },
    adopt: (reading) => {
      seeded = true
      value = reading
      moving = false
    },
  }
}
