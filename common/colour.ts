/**
 * Colour helpers — shared config→CSS conversions.
 */

/** Convert a 6-digit hex colour (#rrggbb) to an rgba() CSS string.
 *  Unknown formats fall back to the dark card scrim at the requested alpha.
 *  Shared by files/notes (config-driven dynamic CSS). */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return `rgba(10, 12, 17, ${alpha})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`
}
