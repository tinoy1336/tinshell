/**
 * Launcher emoji layer — the launcher's side of the shared emoji modules
 * (common/emoji/*).
 *
 * The shared layer owns the table (data.ts), the query/recents layer
 * (search.ts), the usage store (recency.ts) and the insertion ladder
 * (insert-plan.ts + insert.ts). This module is the seam: it builds the emoji
 * RESULT (the glyph matches themselves) and hands the insertion path the
 * settings from the launcher's own config — common/emoji reads no store.
 *
 * The result contract: the matches render as a glyph grid under ONE label that
 * folds the term and the FULL match count (`Emoji: emo - 43 matches`). The
 * search is uncapped — every match is rendered and reachable by scrolling; the
 * label counts them all. In emoji mode the section is the whole list; in an
 * ordinary search it is the last block of the list. An empty query in emoji
 * mode falls back to the recents glyphs.
 */
import type { EmojiEntry } from "@common/emoji/data"
import { beginPick, type InsertSettings, insertGlyph, resetTarget } from "@common/emoji/insert"
import type { InsertMode, TargetInfo, Typer } from "@common/emoji/insert-plan"
import { recordGlyph } from "@common/emoji/recency"
import { recentEntries, searchEntries, tableSize, topEntries } from "@common/emoji/search"
import { get } from "./config"
import { log } from "./log"
import type { Result } from "./types"

/** Grid columns (config grid.columns). */
export function emojiColumns(): number {
  return Math.max(2, Math.min(16, get<number>("grid.columns", 8)))
}

/** Rows of the grid visible at once (config grid.visibleRows); the rest of the
 *  matches scroll. Not a match cap — the search is uncapped. */
export function emojiVisibleRows(): number {
  return Math.max(1, Math.min(12, get<number>("grid.visibleRows", 4)))
}

/** Pitch of one grid row in px: the cell's min-height 34 + its 4px padding top
 *  and bottom (the CSS button.emoji-cell) + the grid's row spacing 4. Used to
 *  size the visible area and to map a row index onto a scroll offset. */
export const EMOJI_ROW_PITCH = 46

/** Height of the visible grid area: `visibleRows` rows, then it scrolls. */
export function emojiGridHeight(visibleRows: number = emojiVisibleRows()): number {
  return Math.max(1, visibleRows) * EMOJI_ROW_PITCH
}

/**
 * Scroll row that keeps the selected cell in view — the minimal scroll, so a
 * selection already visible does not move the grid. Pure (row indexes, not
 * pixels): the widget multiplies by EMOJI_ROW_PITCH.
 *
 * `currentTop` is the row currently at the top of the viewport; the returned
 * value is clamped to the last full viewport (the grid never scrolls past its
 * last row, so the visible rows always fill the area).
 */
export function emojiScrollTop(
  selected: number,
  total: number,
  columns: number,
  visibleRows: number,
  currentTop: number,
): number {
  const cols = Math.max(1, columns)
  const rows = Math.ceil(Math.max(0, total) / cols)
  const maxTop = Math.max(0, rows - Math.max(1, visibleRows))
  const row = Math.floor(Math.max(0, selected) / cols)
  let top = Math.min(Math.max(0, Math.floor(currentTop)), maxTop)
  if (row < top) top = row
  else if (row > top + Math.max(1, visibleRows) - 1) top = row - Math.max(1, visibleRows) + 1
  return Math.min(Math.max(0, top), maxTop)
}

/** Every glyph `query` matches — UNCAPPED so no match is unreachable (the label
 *  counts them all and the grid scrolls); an empty query is the recents strip. */
export function emojiEntriesFor(query: string, emojiMode: boolean): EmojiEntry[] {
  const q = query.trim()
  if (q) return searchEntries(q, Number.MAX_SAFE_INTEGER)
  if (!emojiMode) return []
  return recentEntries(Math.max(1, get<number>("recents.limit", 16)))
}

/**
 * The emoji result for this query/mode — null when there is nothing to show
 * (source disabled, no match, or an empty query outside emoji mode).
 *
 * The label folds the query term and the match count into ONE line
 * (`Emoji: emo - 43 matches`); the matches themselves ride on `emojiEntries`
 * and render as the grid. There is no separate count line.
 */
export function emojiRow(query: string, emojiMode: boolean): Result | null {
  if (!get<boolean>("sources.emoji", true)) return null
  const entries = emojiEntriesFor(query, emojiMode)
  if (!entries.length) return null
  return {
    title: emojiLabel(query, entries.length),
    category: "emoji",
    emojiEntries: entries,
    // Activation runs through the launcher's emoji path (the grid's selected
    // glyph), never through this row's run().
    run: () => false,
  }
}

/**
 * `Emoji: <term> - <n> matches` (singular `match`). The term is what the user
 * typed minus the `:` trigger's colons — those are search delimiters (stripped
 * by searchEntries), not part of the term. With no term (the empty-query
 * recents grid) the count names what it counts: `Emoji - <n> recents`.
 */
export function emojiLabel(query: string, count: number): string {
  const term = query.trim().replace(/^:+|:+$/g, "")
  if (!term) return `Emoji - ${count} recent${count === 1 ? "" : "s"}`
  return `Emoji: ${term} - ${count} match${count === 1 ? "" : "es"}`
}

/** Insertion settings for the shared ladder — read from the launcher config
 *  at every call so a `launcher config set insert.*` lands without a reload. */
export function emojiInsertSettings(): InsertSettings {
  return {
    mode: get<InsertMode>("insert.mode", "paste"),
    preferTyper: get<Typer>("insert.typer", "wtype"),
    terminalClasses: get<string[]>("insert.terminalClasses", []),
    restoreClipboard: get<boolean>("insert.restoreClipboard", true),
    delayMs: Math.max(0, get<number>("insert.delayMs", 140)),
    restoreDelayMs: Math.max(0, get<number>("insert.restoreDelayMs", 350)),
  }
}

/** Capture the focused window for the launcher's pick (the pick owns it). */
export function emojiBeginPick(): Promise<TargetInfo | null> {
  return beginPick()
}

/** Drop any scheduled insertion (a new launcher session supersedes it). */
export function emojiCancelPick(): void {
  resetTarget()
}

/** Record a pick in the shared usage store; a store failure never blocks. */
export function emojiRecord(glyph: string): void {
  try {
    recordGlyph(glyph, Math.max(1, get<number>("recents.max", 50)))
  } catch (e) {
    log(`emoji: recency record failed: ${(e as Error).message}`)
  }
}

/** Insert a picked glyph into the window the launcher's pick captured. */
export function emojiInsert(glyph: string, target: TargetInfo | null): void {
  insertGlyph(glyph, target, emojiInsertSettings())
}

/** `launcher emoji-debug` payload (the verification/introspection surface). */
export function emojiDebug(): string {
  return JSON.stringify({
    table: tableSize(),
    mode: get<InsertMode>("insert.mode", "paste"),
    typer: get<Typer>("insert.typer", "wtype"),
    columns: emojiColumns(),
    visibleRows: emojiVisibleRows(),
    gridHeight: emojiGridHeight(),
    recentsLimit: get<number>("recents.limit", 16),
    recents: topEntries(8).map((e) => e.glyph),
  })
}
