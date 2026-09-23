/**
 * Inline path autofill controller — blind Tab-cycling completion over
 * `completePath` / `globPath` (see @common/path/complete). Pure logic + cycle
 * state: the caller owns the Gtk.Entry and calls `onTab` from its Tab key
 * handler (launcher !p bang, promptd's input dialog, dock screengrab
 * save-location, the card path bar's Ctrl+L entry). Consecutive Tabs
 * cycle the SAME candidate list; any text edit recomputes it. `onAccept`
 * (Right Arrow) locks in the current selection and descends into a directory:
 * it resets the cycle so the NEXT Tab scans that directory's children.
 *
 * COMMITTED/GHOST MODEL: the entry text is always `committed + ghost`, where
 * `committed` is the locked-in portion (typed text + right-arrow-descended
 * dirs) and `ghost` is the current Tab suggestion. The caller renders the
 * ghost as a SELECTION (`set_selection_bounds(committedLen, text.length)`)
 * so the non-committed portion is visually distinct ("different shade").
 *
 * PATTERN QUERIES: a typed path whose basename carries `*`/`?` (see
 * `isGlobQuery`) completes to the MATCHING entries of its parent directory,
 * newest first. A candidate does not extend a pattern, so its ghost is the
 * whole matched path rather than a remainder — the entry shows what would be
 * committed. The typed prefix (a bang) stays committed text; GTK scrolls the
 * entry to the caret at the ghost's end, so a long path clips at the left and
 * the filename stays visible.
 *
 * REENTRANCY GUARD: our own `set_text` fires `changed` → `onInput` — and
 * Gtk emits it TWICE when replacing non-empty text: first with an
 * intermediate `""` (internal delete phase), then with the final text. The
 * `lastApplied` marker (the last full text WE wrote) lets `onInput` ignore
 * our fills' final emission, and the intermediate `""` is ignored too (an
 * empty entry can never be a meaningful path edit). Only real user edits
 * invalidate the cycle — this is what keeps Tab cycling instead of
 * descending.
 */

import { log } from "@common/log/logger"
import { completePath, expandPath, globPath, isGlobQuery, type PathSuggestion } from "./complete"

interface PathAutofillOpts {
  /** Path substring to complete, or null when autofill is inactive. */
  extract: (text: string) => string | null
  maxResults?: number
  /** Called when a PATTERN cycle hides matches beyond its cap (the count), and
   *  with 0 once the cycle is complete again — the caller reports the partial
   *  cycle instead of cycling a silent subset. */
  onTruncated?: (hidden: number) => void
}

interface PathAutofillResult {
  /** Full text to put in the entry (committed + ghost). */
  text: string
  /** Chars [0, committedLen) are committed; committedLen..text.length is the
   *  ghost — select that range to render the shade indicator. */
  committedLen: number
}

interface PathAutofill {
  onInput(text: string): void
  onTab(text: string, shift: boolean): PathAutofillResult | null
  onAccept(text: string): PathAutofillResult | null
  reset(): void
}

export function createPathAutofill(opts: PathAutofillOpts): PathAutofill {
  let baseText: string | null = null // committed entry text the current candidates were computed from
  let candidates: PathSuggestion[] = []
  let index = -1
  let lastApplied: string | null = null // last full text WE wrote, to recognize our own programmatic fills
  let patternMode = false // current cycle was computed by globPath (a pattern query)
  let notice = false // a truncation notice is currently published to the caller

  const publishNotice = (hidden: number): void => {
    if (hidden > 0) {
      notice = true
      opts.onTruncated?.(hidden)
      return
    }
    if (notice) {
      notice = false
      opts.onTruncated?.(0)
    }
  }

  const reset = (): void => {
    baseText = null
    candidates = []
    index = -1
    lastApplied = null
    patternMode = false
    publishNotice(0)
  }

  // The ghost suffix to append to the committed entry text: the candidate's
  // full path (trailing "/" for dirs) minus the already-committed (expanded)
  // path. Preserves the user's "~"/relative display by only taking the SUFFIX.
  const ghostFor = (committedPath: string, c: PathSuggestion): string => {
    const full = c.path + (c.isDir ? "/" : "")
    if (committedPath.trim() === "") return full // nothing committed: ghost = whole path
    // canonicalize_filename strips trailing slashes — re-append so the slice
    // starts AFTER the dir separator (no double slash in the result).
    const expanded = expandPath(committedPath)
    const committedExpanded =
      committedPath.endsWith("/") && !expanded.endsWith("/") ? expanded + "/" : expanded
    // Case-insensitive: a candidate's real casing may differ from what was
    // typed (Pictures under ~/pict), and a case-sensitive test falls through to
    // the name-append fallback, yielding ~/pictPictures/ instead of ~/Pictures/.
    if (full.toLowerCase().startsWith(committedExpanded.toLowerCase()))
      return full.slice(committedExpanded.length)
    return c.name + (c.isDir ? "/" : "") // fallback if the expanded forms don't align
  }

  // The REPLACE-PREVIEW for a pattern query: the whole matched path, not a
  // remainder. Everything the entry held before the pattern (a bang prefix,
  // leading whitespace) stays committed, so the caller keeps the bang and
  // shades the path that a commit would leave in the entry.
  const patternPreview = (committedText: string, c: PathSuggestion): PathAutofillResult => {
    const extracted = opts.extract(committedText) ?? ""
    const start = extracted === "" ? -1 : committedText.indexOf(extracted)
    const prefix = start >= 0 ? committedText.slice(0, start) : committedText
    return {
      text: prefix + c.path + (c.isDir ? "/" : ""),
      committedLen: prefix.length,
    }
  }

  return {
    onInput(text: string): void {
      log(
        `[autofill] onInput text=${JSON.stringify(text)} lastApplied=${JSON.stringify(lastApplied)}`,
      )
      if (text === lastApplied) {
        log(`[autofill] onInput ignore (${text === lastApplied ? "lastApplied" : "empty"})`)
        return // our programmatic fill's final emission — keep state
      }
      if (text === "") {
        log(`[autofill] onInput ignore (${text === lastApplied ? "lastApplied" : "empty"})`)
        return // Gtk set_text emits "changed" with "" mid-replace (delete phase) — ignore it
      }
      // Real user edit: invalidate the cycle (next Tab recomputes).
      baseText = null
      candidates = []
      index = -1
      lastApplied = null
      patternMode = false
      publishNotice(0)
      log("[autofill] onInput RESET")
    },

    onTab(text: string, shift: boolean): PathAutofillResult | null {
      const p = opts.extract(text)
      log(
        `[autofill] onTab text=${JSON.stringify(text)} p=${JSON.stringify(p)} lastApplied=${JSON.stringify(lastApplied)} baseText=${JSON.stringify(baseText)}`,
      )
      if (p === null) return null
      const committed = text === lastApplied ? (baseText ?? text) : text
      const pathToComplete = text === lastApplied ? (opts.extract(baseText ?? text) ?? "") : p
      const tabMode = committed === baseText ? "CYCLED" : "RECOMPUTED"
      if (committed !== baseText) {
        baseText = committed
        patternMode = isGlobQuery(pathToComplete)
        if (patternMode) {
          const glob = globPath(pathToComplete)
          candidates = glob.suggestions
          publishNotice(glob.hidden)
        } else {
          candidates = completePath(pathToComplete, { maxResults: opts.maxResults ?? 12 })
          publishNotice(0)
        }
        index = -1
      }
      log(
        `[autofill] onTab ${tabMode} candidates=${candidates.length} index=${index} pattern=${patternMode}`,
      )
      if (candidates.length === 0) return null
      index =
        (((index + (shift ? -1 : 1)) % candidates.length) + candidates.length) % candidates.length
      const c = candidates[index]
      if (patternMode) {
        const preview = patternPreview(committed, c)
        lastApplied = preview.text
        log(`[autofill] onTab -> ${JSON.stringify(preview.text)} (pattern preview)`)
        return preview
      }
      const committedPath = opts.extract(committed) ?? ""
      const ghost = ghostFor(committedPath, c)
      const fullText = committed + ghost
      lastApplied = fullText
      log(`[autofill] onTab -> ${JSON.stringify(fullText)}`)
      return { text: fullText, committedLen: committed.length }
    },

    onAccept(text: string): PathAutofillResult | null {
      if (opts.extract(text) === null) return null
      log(
        `[autofill] onAccept text=${JSON.stringify(text)} lastApplied=${JSON.stringify(lastApplied)} index=${index}`,
      )
      if (text === lastApplied && index >= 0 && index < candidates.length) {
        const c = candidates[index]
        if (patternMode) {
          // Pattern cycle: the entry already holds the matched path as the
          // ghost, so accepting it commits that text literally and consumes
          // the pattern — one match is what the entry then names.
          baseText = null
          candidates = []
          index = -1
          patternMode = false
          publishNotice(0)
          lastApplied = text
          log(`[autofill] onAccept COMMIT PATTERN -> ${JSON.stringify(text)}`)
          return { text, committedLen: text.length }
        }
        const committed = baseText ?? text
        const ghost = ghostFor(opts.extract(committed) ?? "", c)
        const newCommitted = committed + ghost // dir ghost already ends with "/"
        // baseText = null: force the NEXT Tab to recompute from the locked-in
        // dir (its children), i.e. descend. lastApplied keeps the guard happy
        // so the caller's set_text is not mistaken for a user edit.
        baseText = null
        candidates = []
        index = -1
        lastApplied = newCommitted
        log(`[autofill] onAccept LOCK-IN -> ${JSON.stringify(newCommitted)}`)
        return { text: newCommitted, committedLen: newCommitted.length }
      }
      log("[autofill] onAccept -> null")
      return null
    },

    reset,
  }
}
