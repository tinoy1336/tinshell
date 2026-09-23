/**
 * Easing functions for animations — collected in one place.
 * Each maps a normalized time t ∈ [0,1] to an eased progress value.
 */

/** Quadratic ease-in-out — step snap, offsets (the dock's classic). */
export const easeQuadInOut = (t: number): number => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t)

/** Cubic ease-in-out — the launcher's card-height tween. */
export const easeCubicInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2

/** Cubic ease-out. */
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3
