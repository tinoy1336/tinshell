/**
 * Elapsed-time text — the ONE seconds→text formatter every applet readout uses.
 *
 * Sourced from the power applet's uptime readout, which is where the shape was
 * established: whole seconds under a minute, then whole minutes, hours (under
 * 100) and days, each ROUNDED rather than truncated, so a reading never reads a
 * unit lower than its own magnitude (59.6 s is "60s", not "59s" — the rounding
 * moves it into the next unit only when the unit boundary itself is crossed).
 *
 * Pure: no gi, no GTK, no config. Consumers: the power applet's uptime face and
 * the battery applet's fully-charged counter.
 */

/** `seconds` of elapsed time as the shortest sensible text (`45s` / `12m` /
 *  `3h` / `2d`). Negative values read as `0s`. */
export function formatElapsed(seconds: number): string {
  const s = Math.round(Number.isFinite(seconds) ? Math.max(0, seconds) : 0)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(s / 3600)
  if (h < 100) return `${h}h`
  const d = Math.round(s / 86400)
  return `${d}d`
}
