/**
 * row-caps.probe — what the card's width budget and the PER-KIND row height
 * actually do, measured on real GTK labels (no window is ever mapped).
 *
 * The launcher's caps are not a style choice: GTK4 has no maximum-size API, so
 * the labels are what bound the card's width. This probe measures the two
 * invariants the per-kind height policy rests on:
 *
 *  1. an ordinary row is ONE description line, so its height is the height it
 *     had before preview rows existed — measured equal to a short single-line
 *     description, with the label's minimum at the ellipsis width (no wrap);
 *  2. a preview row takes its own line budget (`DESC_LINES_PREVIEW`), and its
 *     `WORD_CHAR` wrap keeps the label's minimum at the ellipsis size — the
 *     same text wrapped `WORD` instead takes a larger minimum, which is the
 *     card-stretch the no-wrap rule exists to prevent. The budget is checked
 *     against the parsers' clip (`MAX_SUMMARY`), so the line count and the clip
 *     cannot drift apart.
 *
 * The card width comes from the live config (`window.width` × the monitor,
 * capped by `window.maxWidth`), so the character counts printed are the user's
 * own numbers. The labels are measured under the theme's font — no CSS is
 * applied in a probe — which the line COUNT and the minimum widths do not
 * depend on; the absolute px of a line is the theme's, not the card's.
 *
 * Run:  ags bundle --gtk 4 apps/launcher/row-caps.probe.ts /tmp/row-caps-probe.sh
 *       bash /tmp/row-caps-probe.sh
 */
import Gdk from "gi://Gdk"
import Gtk from "gi://Gtk"
import Pango from "gi://Pango"
import {
  CAP_PX_DESC,
  CAP_PX_TITLE,
  capChars,
  DESC_LINES_PREVIEW,
  DESC_LINES_ROW,
  descriptionLines,
  MAIN_PAD,
  MIN_CAP_CHARS,
  ROW_CHROME,
  textBudget,
} from "./row-caps"
import { MAX_SUMMARY } from "./sources/bang-preview"

Gtk.init()

// The card's own font sizes come from style.css; the probe applies the
// description size so its px are the card's px (the per-char constant above is
// calibrated for it). Without a display the labels fall back to the theme font,
// which the line counts and the comparisons still hold for.
const display = Gdk.Display.get_default()
const css = new Gtk.CssProvider()
css.load_from_string(`label { font-size: 10px; font-family: ${themeFamily()}; }`)
if (display)
  Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
console.log(`display ${display ? "reachable" : "absent"} — measuring at 10px`)

function themeFamily(): string {
  try {
    return (
      Gtk.Settings.get_default()?.gtk_font_name?.split(" ").slice(0, -1).join(" ") || "sans-serif"
    )
  } catch {
    return "sans-serif"
  }
}

/** A label built the way the launcher builds one: the row class, the cap, the
 *  ellipsis, and — for a preview row — the wrap the per-kind policy adds. */
function label(text: string, pxPerChar: number, lines: number): Gtk.Label {
  const budget = textBudget(cardWidth())
  const l = new Gtk.Label({ label: text, halign: Gtk.Align.START })
  l.set_max_width_chars(capChars(budget, pxPerChar))
  l.set_ellipsize(Pango.EllipsizeMode.END)
  if (lines > DESC_LINES_ROW) {
    l.set_wrap(true)
    l.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
    l.set_lines(lines)
  }
  return l
}

/** The same label wrapped `WORD` instead — the mode the policy deliberately
 *  does NOT use, kept here to measure what it would cost. */
function wordWrappedLabel(text: string, pxPerChar: number, lines: number): Gtk.Label {
  const l = label(text, pxPerChar, lines)
  l.set_wrap(true)
  l.set_wrap_mode(Pango.WrapMode.WORD)
  return l
}

/** The configured card width: the monitor fraction, capped. Falls back to the
 *  app's own default (0.3 of 1280) when no display is reachable. */
function cardWidth(): number {
  let monW = 1280
  try {
    const display = Gdk.Display.get_default()
    const mon0 = display?.get_monitors?.()?.get_item?.(0) as Gdk.Monitor | null
    if (mon0) monW = mon0.get_geometry().width
  } catch {
    // keep the default width
  }
  return Math.min(Math.round(monW * 0.3), 800)
}

/** [minimum, natural] width in px. */
function widths(l: Gtk.Label): [number, number] {
  const [min, nat] = l.measure(Gtk.Orientation.HORIZONTAL, -1)
  return [min, nat]
}

/** The label's natural height in px. */
function height(l: Gtk.Label): number {
  return l.measure(Gtk.Orientation.VERTICAL, textBudget(cardWidth()))[1]
}

const width = cardWidth()
const budget = textBudget(width)
const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

// ── the width budget the user's config produces ──
console.log(`card width ${width}px (window.width 0.3 of the monitor, cap 800)`)
console.log(
  `text budget ${budget}px (minus .main ${MAIN_PAD}px and row chrome ${ROW_CHROME}px) — ` +
    `title cap ${capChars(budget, CAP_PX_TITLE)} chars, description cap ${capChars(budget, CAP_PX_DESC)} chars per line`,
)

// ── 1. an ordinary row is one line, unchanged ──
const appDesc = label("open in firefox", CAP_PX_DESC, descriptionLines(false))
const longAppDesc = label(
  "search the web in the default browser and open the first result",
  CAP_PX_DESC,
  descriptionLines(false),
)
check("ordinary description policy is one line", descriptionLines(false), DESC_LINES_ROW)
check(
  "an over-long ordinary description does not grow the row",
  height(longAppDesc),
  height(appDesc),
)
check(
  "an ordinary label caps its natural width at the budget",
  widths(longAppDesc)[1] <= Math.round(budget) + 1,
  true,
)
check("an ordinary label keeps the ellipsis-sized minimum", widths(longAppDesc)[0] < 40, true)

// ── 2. only the preview kind grows, to its own line budget ──
const previewText =
  "Arthropods are invertebrates in the phylum Arthropoda. They possess an exoskeleton with a cuticle made of chitin, often mineralised with calcium carbonate, a body with differentiated (metameric) segments, and paired jointed appendages."
// A sample at the parser's own clip length, so the measured height is the one a
// real fetched summary reaches.
const previewSample = `${previewText} ${previewText}`.slice(0, MAX_SUMMARY)
const previewDesc = label(previewSample, CAP_PX_DESC, descriptionLines(true))
check("preview description policy is four lines", descriptionLines(true), DESC_LINES_PREVIEW)
check("a preview row is taller than an ordinary row", height(previewDesc) > height(appDesc), true)

// The budget is arithmetic, not taste: the line count only matters up to the
// point where the parser's clip is the binding constraint.
const charsPerLine = capChars(budget, CAP_PX_DESC)
check(
  "the four-line budget covers the parser clip, so the clip binds",
  charsPerLine * DESC_LINES_PREVIEW >= MAX_SUMMARY,
  true,
)
check(
  "two lines did NOT cover it — four is the first budget that does",
  charsPerLine * 2 < MAX_SUMMARY,
  true,
)
console.log(
  `capacity — ${charsPerLine} chars/line x ${DESC_LINES_PREVIEW} lines = ${charsPerLine * DESC_LINES_PREVIEW} chars ` +
    `against the ${MAX_SUMMARY}-char clip (two lines were ${charsPerLine * 2})`,
)
console.log(
  `heights — ordinary row description ${height(appDesc)}px, preview row description ${height(previewDesc)}px`,
)

// ── 3. the long-token guard survives the wrap ──
// A row can carry an unbroken token (a path's basename, a URL with no
// separator). `max_width_chars` caps the label's NATURAL width either way, so
// the card cannot widen; what the wrap mode changes is the label's MINIMUM,
// which is what a card's own floor is made of.
const longToken =
  "Open — /home/dev/very/long/path/that/keeps/going/and/going/filename-with-many-characters.png"
const unbrokenToken = `Open — https://example.com/${"a".repeat(120)}`
const guarded = label(longToken, CAP_PX_DESC, descriptionLines(true))
const unguarded = wordWrappedLabel(longToken, CAP_PX_DESC, descriptionLines(true))
const guardedUnbroken = label(unbrokenToken, CAP_PX_DESC, descriptionLines(true))
const unguardedUnbroken = wordWrappedLabel(unbrokenToken, CAP_PX_DESC, descriptionLines(true))
check(
  "WORD_CHAR keeps a long token inside the budget",
  widths(guarded)[1] <= Math.round(budget) + 1,
  true,
)
check("the preview label's minimum stays tiny", widths(guarded)[0] < budget / 4, true)
check(
  "WORD_CHAR is the more breakable mode (its minimum never exceeds WORD's)",
  widths(guardedUnbroken)[0] <= widths(unguardedUnbroken)[0],
  true,
)
console.log(
  `long token — natural width WORD_CHAR ${widths(guarded)[1]}px, WORD ${widths(unguarded)[1]}px ` +
    `(budget ${budget}px, both capped by max_width_chars)`,
)
console.log(
  `unbroken 120-char token — minimum width WORD_CHAR ${widths(guardedUnbroken)[0]}px, WORD ${widths(unguardedUnbroken)[0]}px`,
)

// ── 4. the emoji section is untouched: its own constants, one title line ──
const emojiLabel = label("Emoji: joy - 7 matches", CAP_PX_TITLE, descriptionLines(false))
check(
  "the emoji section label is a one-line ordinary label",
  height(emojiLabel),
  height(label("Emoji", CAP_PX_TITLE, descriptionLines(false))),
)
check("the cap floor still applies", capChars(10, CAP_PX_TITLE), MIN_CAP_CHARS)

const failed = checks.filter(([, a, e]) => JSON.stringify(a) !== JSON.stringify(e))
for (const [name, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`row-caps probe failed: ${failed.length} check(s)`)
