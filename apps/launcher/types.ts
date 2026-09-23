/**
 * Shared result types. Every source (applications, calc, bangs, time, paths,
 * urls, emoji) returns `Result[]` and the combiner merges them into one flat
 * list ordered by priority.
 *
 * `category` drives the leading fallback icon and source priority in the
 * combiner. `run()` is invoked on Enter (the dispatch action).
 */
import type { EmojiEntry } from "@common/emoji/data"

export type ResultCategory = "app" | "calc" | "bang" | "time" | "path" | "url" | "emoji"

export interface Result {
  /** Primary text. */
  title: string
  /** Secondary line. Omit to render title-only. */
  description?: string
  /** Icon name (themed) for the row. */
  icon?: string
  /** Source category — drives priority + fallback icon. */
  category: ResultCategory
  /**
   * Invoked on Enter. Returns true if the launcher should hide after
   * (the common case — launch/copy/close). False = keep open.
   */
  run: () => boolean | void
  /**
   * Emoji mode: the glyphs this row expands into (category "emoji" only).
   * The row is a normal-height result until selected; on selection its widget
   * shows the glyph grid these entries describe (Launcher.tsx).
   */
  emojiEntries?: EmojiEntry[]
  /**
   * A BANG PREVIEW row (the fetched row an enriched bang shows, and the items
   * beneath it): its description is a payload rather than a generated note, so
   * it may run to its own line budget (`row-caps.ts` `DESC_LINES_PREVIEW`) and
   * is the one row kind that grows (`apps/launcher/row-caps.ts`). An ordinary
   * row stays one line tall.
   */
  preview?: boolean
  /**
   * Optional secondary action: launch on the NVIDIA dGPU via prime-run
   * (app rows only). The row renders a small button when present.
   */
  runPrime?: () => boolean | void
  /**
   * Optional secondary action: launch the app FLOATING (stacked on top of
   * the tiled layout), via Shift+Enter. App rows only.
   */
  runStack?: () => boolean | void
}

/** Async sources return this: sync results immediately, optional async batch. */
export interface SourceResponse {
  sync: Result[]
  /**
   * If present, resolves later and is merged in when ready.
   *
   * A source may hand a THUNK instead of a promise: the combiner calls it when
   * the debounced kickoff runs, so the work starts on the settled query rather
   * than on the keystroke that scheduled it (a bang preview must not fire a
   * request per keystroke).
   */
  async?: Promise<Result[]> | (() => Promise<Result[]>)
  /**
   * The async batch REPLACES this source's sync rows rather than appending to
   * them: the row the sync half produced stands while the batch is in flight
   * and is swapped out when it lands, so one source shows one row.
   *
   * An EMPTY batch is a no-op whatever this flag says — nothing to replace the
   * sync rows WITH is the failure answer, and the sync rows are the fallback.
   */
  replace?: boolean
}
