/**
 * Row text caps — the card's width budget and its PER-KIND row height, in one
 * pure module so `./row-caps.probe.ts` can measure what it means on real GTK
 * labels.
 *
 * GTK4 has no maximum-size API: `set_size_request` is a MINIMUM, so the card is
 * as wide as the widest row's NATURAL width unless the text inside it is
 * bounded. These caps bound it, measured on GTK 4.22 with `row-caps.probe.ts`:
 * `max_width_chars` caps a label's natural request — a long description or a
 * 120-character unbroken token both measure just under the budget — and
 * `ellipsize=END` holds the label's minimum at the ellipsis size (12–26 px at
 * the description size, whatever the wrap mode). `window.width` × the monitor,
 * capped by `window.maxWidth`, is then what the card actually gets.
 *
 * ROW HEIGHT IS PER KIND. An ordinary row — an application, the file rows under
 * a typed path, an `Open — <path>`/`<url>` row, a catalogue hint, the emoji
 * section — keeps ONE description line and NO wrap, which is the height it has
 * always had: a launch must not change the card's shape. A BANG PREVIEW row
 * (`Result.preview`: the fetched row an enriched bang shows and the items
 * beneath it) carries a payload instead of a generated note, so its description
 * may run to `DESC_LINES_PREVIEW` lines — the same configured width then
 * carries that many times the text, and only that row grows (measured 14 px of
 * description at the card's font, 56 px for the four-line preview treatment).
 * Its wrap mode is `WORD_CHAR`, so a long path or URL token breaks inside the
 * line instead of being treated as one word.
 *
 * FOUR LINES IS THE LANDING POINT, and it is arithmetic rather than taste: at
 * the configured width one line holds `capChars(textBudget(width),
 * CAP_PX_DESC)` characters (53 at 320 px), and a preview parser clips its
 * summary at `MAX_SUMMARY` (`sources/bang-preview.ts`, 200). Two lines (106
 * characters) cut the payload short; four lines (212) are the first budget at
 * which the CLIP binds instead of the line count, so the whole fetched summary
 * is shown and nothing is fetched only to be discarded. A larger count would
 * need the clip raised with it, and nothing above the clip's length would be
 * read.
 *
 * Per-character widths are Pango's approximate char metric used by
 * max_width_chars at each label's CSS font size (style.css) — measured against
 * the app CSS on GTK 4.22, not the 0.6em monospace advance (Pango's metric is
 * ~6% wider at 11px). Keep in sync with style.css font sizes.
 */

/** `.main` padding (6px a side). */
export const MAIN_PAD = 12

/** `.match` padding 24 + icon 16 + spacing 10 + prime-run button 32 (measured
 *  92 + slack). */
export const ROW_CHROME = 100

/** `.title`, 12px. */
export const CAP_PX_TITLE = 7.23

/** `.description`, 10px. */
export const CAP_PX_DESC = 6.01

export const MIN_CAP_CHARS = 4

/** Description lines of an ordinary row — one, unchanged. */
export const DESC_LINES_ROW = 1

/** Description lines a bang preview row may use. Four is where the clip in
 *  `sources/bang-preview.ts` starts binding — see the note above. */
export const DESC_LINES_PREVIEW = 4

/** The pixels a row's text may occupy inside a card this wide. */
export function textBudget(cardWidth: number, chrome = ROW_CHROME): number {
  return cardWidth - MAIN_PAD - chrome
}

/** The `max_width_chars` a label gets for this budget at this font size. */
export function capChars(budget: number, pxPerChar: number): number {
  return Math.max(MIN_CAP_CHARS, Math.floor(budget / pxPerChar))
}

/** How many lines a row's description may occupy, by kind. */
export function descriptionLines(preview: boolean): number {
  return preview ? DESC_LINES_PREVIEW : DESC_LINES_ROW
}
