/**
 * Query combiner — orchestrates the sources on each keystroke.
 *
 * Design:
 *   - sync sources (applications, time, unit conversions, bare typed shapes,
 *     !f/!c/usage bangs) compute immediately and set the results at once so the UI never lags on
 *     typing.
 *   - async sources (calc, !py, !q) shell out; they're kicked off debounced
 *     (calc.debounceMs, default 150ms) and merge in when they resolve. A
 *     latest-query guard discards stale resolutions.
 *   - results are ordered by source priority: urls → paths → bangs-with-query
 *     → time/units → calc → apps → emoji, then capped at maxEntries. In EMOJI MODE
 *     (the mod+. keybind or a leading `:` in the query) every other source is
 *     suppressed for every query: the list is emoji-only and the widget
 *     renders it as the glyph grid itself (the app search stays on mod+Space).
 *   - a PATH-SHAPED query (`isPathShaped` (@common/path/complete): `/`, `~`,
 *     `./`, `../` prefix) is the path source's
 *     alone, and a URL-SHAPED query (an explicit `scheme:`) is the URL
 *     source's alone: apps, bangs, time, calc and emoji are suppressed for
 *     both, so a typed directory or URL cannot also match an app name.
 *   - a busy callback reports whether an async source (calc, !py, !q, a bang
 *     preview) is still in flight, so the UI can show its loading indicator.
 *
 * Selection preservation: sync result batches (fresh query) reset selection to
 * 0 (auto-select first). Async merges carry `incremental: true` so the caller
 * can keep the user's current selection instead of snapping back to index 0 —
 * this stops a late-arriving calc row from stealing focus from the app the
 * user already had selected.
 *
 * A source may also ask for its async batch to REPLACE its sync rows
 * (`SourceResponse.replace`) instead of adding to them: a bang preview keeps
 * the bang's own row while it fetches and swaps it when the payload lands, so
 * the row is never doubled. An empty batch replaces nothing.
 *
 * Supersession: a query change CANCELS a scheduled kickoff before any early
 * return, because a debounce armed by an earlier keystroke reads `this.query`
 * when it fires and would merge the earlier keystroke's pending snapshot.
 * `onResults` fires on every batch (sync and async) with the full merged list.
 */
import GLib from "gi://GLib"
import { copy } from "@common/clipboard"
import { isPathShaped } from "@common/path/complete"
import { get } from "./config"
import { emojiRow } from "./emoji"
import { log } from "./log"
import { search as appsSearch } from "./sources/apps"
import { cancelPreviews } from "./sources/bang-preview-fetch"
import { bangs as bangsEval } from "./sources/bangs"
import { calc as calcEval, unitRows } from "./sources/calc"
import { paths as pathsEval } from "./sources/paths"
import { shapeRows } from "./sources/text-tools"
import { timeConvert } from "./sources/time"
import { isUrlQuery, urls as urlsEval } from "./sources/urls"
import type { Result, SourceResponse } from "./types"

export interface ResultBatch {
  results: Result[]
  /** true = an async source merged into an existing list; preserve selection. */
  incremental: boolean
  /** true = the launcher is in emoji mode (the caller selects the emoji row). */
  emojiMode: boolean
}

export interface CombinerCallbacks {
  onResults: (batch: ResultBatch) => void
  /** An async source is in flight (true) or the last one settled (false). */
  onBusy: (busy: boolean) => void
}

const PRIORITY: Record<string, number> = {
  url: 0,
  path: 0,
  bang: 0,
  time: 1,
  calc: 2,
  app: 3,
  emoji: 4,
}

interface Pending {
  apps: Result[]
  bangsSync: Result[]
  time: Result[]
  units: Result[]
  shapes: Result[]
  paths: Result[]
  urls: Result[]
  calc: Result | null
  bangsAsync: Result[]
  emoji: Result[]
}

/**
 * Order the merged list by source priority. There is NO result cap: the card
 * shows `listHeight` rows and SCROLLS the rest (`Launcher.tsx` + `./scroll.ts`),
 * the scroller's `max-content-height` holding it at `listHeight` x the measured
 * row pitch. The emoji row sorts last and needs no reserved slot — nothing can
 * push it out of a list that is not cut.
 */
function byPriority(list: Result[]): Result[] {
  return [...list].sort((a, b) => (PRIORITY[a.category] ?? 9) - (PRIORITY[b.category] ?? 9))
}

/**
 * Does this query look like math? qalc happily "answers" arbitrary words
 * ("you" → 1E−24 B·u, "cat" → 10 ma·t) by treating them as units/variables,
 * so exit-code guarding isn't enough. Gate implicit calc on a real math
 * shape: starts with a digit/sign and contains an operator, or is a function
 * call (sqrt(...), sin, log), or a unit conversion ("<num> <unit> to ...").
 */
function looksLikeMath(q: string): boolean {
  const s = q.trim()
  if (!s) return false
  // arithmetic: contains an operator and at least one digit
  if (/[0-9]/.test(s) && /[-+*/^%()]/.test(s)) return true
  // a bare number (with optional decimals) → worth a row
  if (/^[0-9][0-9.,\s]*$/.test(s)) return true
  // function call form: word(...)
  if (/^[a-z_]+\s*\(.*\)/i.test(s)) return true
  // unit conversion: "<number> <unit> (to|in|as) <unit>"
  if (/^[0-9.\s]+\S+\s+(to|in|as)\s+\S+/i.test(s)) return true
  return false
}

/**
 * The query as qalc should read it. qalc treats `%` as a remainder operator,
 * so the percent-of shape the user types (`15% of 200`) parses as
 * `rem(15, 1 B)` and exits non-zero; in that shape the word `of` is a
 * multiplication. Only that shape is rewritten, and only its first `of`.
 */
function qalcInput(q: string): string {
  return /^\d+(?:\.\d+)?\s*%\s+of\s+\S/i.test(q.trim()) ? q.replace(/\bof\b/i, "*") : q
}

export class Combiner {
  private query = ""
  private debounceId: number | null = null
  private debounceSeq = 0
  /** An async source (calc, !py, !q) is still in flight. */
  private busy = false
  /** Emoji mode: set by the keybind request or a leading `:` in the query. */
  private emojiMode = false

  constructor(private cb: CombinerCallbacks) {}

  /** Current best merged snapshot. */
  private snapshot(p: Pending): Result[] {
    const all = [
      ...p.urls,
      ...p.paths,
      ...p.bangsSync,
      ...p.bangsAsync,
      ...p.time,
      ...p.units,
      ...p.shapes,
    ]
    if (p.calc) all.push(p.calc)
    all.push(...p.apps)
    all.push(...p.emoji)
    return byPriority(all)
  }

  /** Emoji mode: the keybind and the `:` entry trigger both set it; the row
   *  it adds only exists while it matches (or on the mode's empty query). */
  isEmojiMode(): boolean {
    return this.emojiMode
  }

  setEmojiMode(on: boolean): void {
    if (on === this.emojiMode) return
    this.emojiMode = on
    this.queryDidChange(this.query)
  }

  private setBusy(busy: boolean): void {
    this.busy = busy
    this.cb.onBusy(busy)
  }

  /**
   * Called on every keystroke. Computes sync sources now, schedules async
   * sources debounced, and keeps the latest query as the single source of
   * truth (stale async resolutions are dropped).
   */
  queryDidChange(text: string): void {
    this.query = text
    const trimmed = text.trim()
    const pending: Pending = {
      apps: [],
      bangsSync: [],
      time: [],
      units: [],
      shapes: [],
      paths: [],
      urls: [],
      calc: null,
      bangsAsync: [],
      emoji: [],
    }

    // A leading `:` is the entry-level equivalent of the emoji keybind: it
    // switches the launcher into emoji mode (the query itself is matched with
    // its colons stripped — searchEntries does that).
    if (trimmed.startsWith(":") && !this.emojiMode) this.emojiMode = true

    const isBang = trimmed.startsWith("!")
    // A path-shaped query is served by the path source alone and a URL-shaped
    // query by the URL source alone: no app-search rows (or bangs/time/calc/
    // emoji) load under a typed directory path or URL.
    const isPath = isPathShaped(trimmed)
    const isUrl = isUrlQuery(trimmed)
    const timeEnabled = get<boolean>("sources.time", true)
    const unitsEnabled = get<boolean>("sources.units", true)

    // Emoji mode is an EMOJI-ONLY list: apps/calc/time/bangs never run there,
    // whatever the query (mod+Space keeps the app search). The emoji row is
    // the whole list in that mode and its widget renders as the grid itself.
    const emojiOnly = this.emojiMode
    let bangAsync: SourceResponse["async"] | null = null
    // The async batch REPLACES the bang sync rows (an enriched bang row keeps
    // the bang's identity instead of being shown twice).
    let bangReplace = false

    if (!emojiOnly && (isPath || isUrl)) {
      // 0. Paths / URLs (sync) — the only source a path- or URL-shaped query
      // runs.
      pending.paths = isPath ? pathsEval(trimmed).sync : []
      pending.urls = isUrl ? urlsEval(trimmed).sync : []
    } else if (!emojiOnly) {
      // 1. Apps (sync).
      const appsResp = get<boolean>("sources.applications", true)
        ? appsSearch(trimmed)
        : { sync: [] }
      pending.apps = appsResp.sync

      // 2. Bangs (sync + maybe async).
      const bangResp = get<boolean>("sources.bangs", true)
        ? bangsEval(text, (b) => this.setBusy(b))
        : { sync: [] }
      pending.bangsSync = bangResp.sync
      bangAsync = bangResp.async ?? null
      bangReplace = bangResp.replace === true

      // 2.5 Time conversion (sync — pure Intl, instant, no subprocess). Its
      // row presence also gates implicit calc: qalc mangles timezone queries
      // ("9pm utc to est" → unit garbage), so a parseable time query must
      // never reach qalc.
      pending.time = timeEnabled && !isBang ? timeConvert(trimmed) : []

      // 2.6 Unit conversions (sync — the curated table, no subprocess). The
      // rows also gate implicit calc: qalc answers the same conversion, so
      // letting both run would show the same answer twice.
      pending.units = unitsEnabled && !isBang ? unitRows(trimmed) : []

      // 2.7 Bare typed shapes (sync — a colour code, a JWT, an IPv4 address or
      // CIDR block; sources/text-tools.ts `shapeRows`). The rows also gate
      // implicit calc: a CIDR carries a `/` and must not also reach qalc.
      pending.shapes = !isBang
        ? shapeRows(trimmed).map((v) => ({
            title: v.title,
            description: v.description,
            icon: "accessories-calculator",
            category: "calc" as const,
            run: () => {
              copy(v.copy ?? v.title)
              return true
            },
          }))
        : []
    }

    // 2.6 Emoji (sync — pure in-memory fuzzy match over the shared layer in
    // common/emoji). At most ONE row, sorted LAST; it appears only when the
    // query matches (in emoji mode an empty query shows the recents grid).
    // Not for bang queries (a `!` query is a bang's business) or path-/URL-
    // shaped queries (those two sources own them).
    const emoji =
      get<boolean>("sources.emoji", true) && (emojiOnly || (!isBang && !isPath && !isUrl))
        ? emojiRow(trimmed, this.emojiMode)
        : null
    if (emoji) pending.emoji = [emoji]

    // Emit the sync batch immediately (resets selection — fresh query).
    this.cb.onResults({
      results: this.snapshot(pending),
      incremental: false,
      emojiMode: this.emojiMode,
    })

    // Every query change supersedes a scheduled async kickoff, so cancel it
    // BEFORE the early returns below. A debounce armed by an earlier keystroke
    // would otherwise fire with THIS query (kickAsync reads this.query) and
    // merge a snapshot of the EARLIER keystroke's pending list — dropping rows
    // the current query did produce (the sync unit conversions included) and
    // showing a qalc answer for a query qalc was never meant to answer.
    if (this.debounceId !== null) {
      GLib.source_remove(this.debounceId)
      this.debounceId = null
    }

    // 3. Debounced async sources. Emoji mode has none, and neither has a
    // path- or URL-shaped query: calc and the async bangs are suppressed with
    // the rest of the sources.
    if (emojiOnly || isPath || isUrl) return

    // Implicit calc only when NOT a bang AND the query looks like math AND
    // neither the time source nor the unit table produced rows (prevents
    // non-math words like "you"/"cat" from spawning a calc row — qalc would
    // otherwise "answer" them with unit nonsense — keeps timezone queries out
    // of qalc, and leaves one row per conversion).
    const wantImplicitCalc =
      !isBang &&
      get<boolean>("sources.calc", true) &&
      looksLikeMath(trimmed) &&
      pending.time.length === 0 &&
      pending.units.length === 0 &&
      pending.shapes.length === 0
    const wantBangAsync = !!bangAsync

    if (!wantImplicitCalc && !wantBangAsync) return

    const myseq = ++this.debounceSeq
    const debounceMs = get<number>("calc.debounceMs", 150)
    this.debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, debounceMs, () => {
      this.debounceId = null
      if (myseq !== this.debounceSeq) return GLib.SOURCE_REMOVE // superseded
      this.kickAsync(pending, {
        wantImplicitCalc,
        wantBangAsync,
        bangAsync,
        bangReplace,
      })
      return GLib.SOURCE_REMOVE
    })
  }

  private async kickAsync(
    pending: Pending,
    opts: {
      wantImplicitCalc: boolean
      wantBangAsync: boolean
      bangAsync: SourceResponse["async"] | null
      bangReplace: boolean
    },
  ): Promise<void> {
    const q = this.query
    // Bang async (e.g. !py / !q / a bang preview) — resolves first since it
    // moves the busy flag. A source that handed a THUNK starts its work here,
    // on the settled query, rather than on the keystroke that scheduled it.
    if (opts.wantBangAsync && opts.bangAsync) {
      try {
        const pendingWork = opts.bangAsync
        const res = await (typeof pendingWork === "function" ? pendingWork() : pendingWork)
        if (q !== this.query) return // stale
        // A replacing batch that carried rows retires this source's sync rows
        // (the enriched bang row stands in their place); an empty batch is a
        // failed preview and leaves the sync row where it is.
        if (opts.bangReplace && res.length > 0) pending.bangsSync = []
        pending.bangsAsync = res
        // incremental: preserve the user's selection
        this.cb.onResults({
          results: this.snapshot(pending),
          incremental: true,
          emojiMode: this.emojiMode,
        })
      } catch (e) {
        log(`combiner: bang async error: ${(e as Error).message}`)
      }
    }

    if (opts.wantImplicitCalc) {
      try {
        const r = await calcEval(qalcInput(q), (b) => this.setBusy(b))
        if (q !== this.query) return // stale
        pending.calc = r
        // incremental: preserve the user's selection
        this.cb.onResults({
          results: this.snapshot(pending),
          incremental: true,
          emojiMode: this.emojiMode,
        })
      } catch (e) {
        log(`combiner: calc error: ${(e as Error).message}`)
      }
    }
  }

  /** Cancel any pending debounce (e.g. on window hide) and the preview request
   *  it would have waited on. */
  cancel(): void {
    if (this.debounceId !== null) {
      GLib.source_remove(this.debounceId)
      this.debounceId = null
    }
    this.debounceSeq++
    cancelPreviews()
    if (this.busy) this.setBusy(false)
  }
}
