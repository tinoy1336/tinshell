/**
 * common/menus/spinner.tsx — a small spinning glyph for the wifi/bt menus.
 *
 * Implementation lives in common/glyph/spinner; this file is a thin adapter
 * feeding the applet palette (colour + font family) the caller supplies.
 */

import { type SpinnerHandle, createSpinnerGlyph as sharedCreate } from "@common/glyph/spinner"

export function createSpinnerGlyph(opts: {
  size: number
  emoji: string
  colour: { rgb: number[]; alpha: number }
  fontFamily: string
}): SpinnerHandle {
  return sharedCreate({
    size: opts.size,
    emoji: opts.emoji,
    colour: [
      opts.colour.rgb[0],
      opts.colour.rgb[1],
      opts.colour.rgb[2],
      Math.min(1, opts.colour.alpha),
    ],
    fontFamily: opts.fontFamily,
  })
}
