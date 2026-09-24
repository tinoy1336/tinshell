/**
 * Request handlers for the launcher — `ags -i shell request "launcher ..."`.
 *
 * Handlers register against the shared command registry (common/commands/
 * registry). Each handler runs sync or async; errors surface as
 * `error: <msg>`. The empty-token probe returns the available commands (the
 * no-op probe signature of a stray bus holder).
 *
 * Emoji mode: `emoji` is the keybind/entry-level trigger (closed → open in
 * emoji mode; open in emoji mode → close; open in another mode → switch),
 * `emoji-insert` and `emoji-debug` are the insertion/verification entries
 * (they replace the retired `emoji insert` / `emoji debug` requests).
 *
 * `debug preview` reads back the bang previews: the card shows no error row, so
 * the reason a preview kept the bang's own row is only visible there (and in
 * the log sink). `debug query <text>` drives the live combiner with the card
 * hidden and answers the rows it settles on, so a preview can be read without
 * showing or typing into the card. `debug scroll` drives or reads the two row
 * surfaces (the result list and the emoji grid), and `debug entry` answers the
 * entry's own text — the Tab completion's ghost included.
 */

import { registerConfigCommands } from "@common/commands/config-commands"
import { register } from "@common/commands/registry"
import { beginPick, insertGlyph } from "@common/emoji/insert"
import { get as getConfig, reloadConfig, set as setConfigRaw } from "./config"
import { emojiDebug, emojiInsertSettings } from "./emoji"
import { reload as appsReload } from "./sources/apps"
import { previewDebug } from "./sources/bang-preview-fetch"

// Control surface the launcher widget publishes (Launcher.tsx): mount.ts hands
// the built window's handle over once the window exists.
export interface LauncherControl {
  toggle(): void
  show(): void
  hide(): void
  /** The emoji keybind contract (see the module header). */
  emoji(): void
  /** Debug: run the currently-selected result (mirrors Enter). */
  activateSelected?(): { selected: number; count: number; ran: boolean }
  /** Debug: run a query through the combiner with the card hidden and report
   *  the rows it settles on (`preview` marks the rows that take the per-kind
   *  description budget), plus the scroll viewport's own numbers. */
  debugQuery?(text: string): Promise<
    | {
        rows: { title: string; description: string; preview: boolean }[]
        selected: number
        offset: number
        viewportPx: number
        listHeight: number
        adjustment: number
        cardHeight: number
        naturalHeight: number
        /** The window's own allocation — the height the card is SHOWN at. */
        shownHeight: number
      }
    | { error: string }
  >
  /** Debug: the entry's own text — what Tab path autofill filled in, and which
   *  part of it is still the uncommitted ghost (the selection range). */
  debugEntry?(): {
    text: string
    cursor: number
    selectionStart: number
    selectionEnd: number
  }
  /** Debug: apply one scroll decision through the real controller path, or
   *  report a surface's live position (`status`); the target names the surface
   *  (the result list, or the emoji grid). Neither surface owns a momentum tail
   *  — a continuous gesture is its scroller's own kinetic scrolling — so the
   *  reply carries no tail numbers. */
  debugScroll?(
    unit: string,
    dy: number,
    target?: "list" | "grid",
  ): {
    target: string
    consumed: boolean
    selected: number
    rows: number
    offset: number
    adjustment: number
    viewportPx: number
    cardHeight: number
    /** The emoji grid's own numbers, always reported. */
    grid: { rows: number; offset: number; adjustment: number; viewportPx: number }
  }
}

let control: LauncherControl | null = null

export function setControl(c: LauncherControl | null): void {
  control = c
}

// ── Handler registrations ──

register(["launcher", "toggle"], (_t, res) => {
  control?.toggle()
  res("ok")
})

register(["launcher", "show"], (_t, res) => {
  control?.show()
  res("ok")
})

register(["launcher", "hide"], (_t, res) => {
  control?.hide()
  res("ok")
})

register(["launcher", "emoji"], (_t, res) => {
  control?.emoji()
  res("ok")
})

// Insert a glyph without touching the row/grid — the live/debug entry (the
// launcher's own pick: capture the focused window now, insert after this
// returns; insert.ts drops the insertion if a newer pick starts meanwhile).
register(["launcher", "emoji-insert"], (tokens, res) => {
  const glyph = tokens.join(" ").trim()
  if (!glyph) return res("usage: emoji-insert <glyph>")
  void (async () => {
    const target = await beginPick()
    insertGlyph(glyph, target, emojiInsertSettings())
  })()
  res("ok")
})

register(["launcher", "emoji-debug"], (_t, res) => {
  res(emojiDebug())
})

register(["launcher", "debug", "activate"], (_t, res) => {
  // Mirrors pressing Enter on the selected row, bypassing the key controller.
  // Isolates "key not received" from "activate path broken".
  const out = control?.activateSelected?.()
  res(JSON.stringify(out ?? { error: "activateSelected unavailable" }))
})

register(["launcher", "debug", "entry"], (_t, res) => {
  // The entry's text as the surface holds it: what a Tab completion filled in
  // and which part of it is still the ghost (the selection). The completion is
  // a blind cycle over the same `common/path/autofill` every surface uses, so
  // this is where the bang an argument completes under is read back.
  const out = control?.debugEntry?.()
  res(JSON.stringify(out ?? { error: "debugEntry unavailable" }))
})

register(["launcher", "debug", "scroll"], (tokens, res) => {
  // Applies ONE scroll decision through the same path the controller's
  // ::scroll handler calls — `applyScrollEvent` on the result list,
  // `applyEmojiScrollEvent` on the emoji grid — so the wiring is exercised by
  // the request surface: `debug scroll wheel 1`, `debug scroll surface -40`
  // (which reports `consumed:false`, the continuous gesture being handed to
  // the surface's own scroller), and `debug scroll status [grid]` reads a
  // surface a real gesture or its kinetic tail moved without moving it again.
  // The target token names the surface; the list is the default.
  const target = tokens.includes("grid") ? "grid" : "list"
  const unit = tokens[0] ?? "surface"
  const dy = unit === "status" ? 0 : Number.parseFloat(tokens[1] ?? "")
  if (!Number.isFinite(dy))
    return res("usage: debug scroll <wheel|surface|status> <delta> [list|grid]")
  const out = control?.debugScroll?.(unit, dy, target)
  res(JSON.stringify(out ?? { error: "debugScroll unavailable" }))
})

register(["launcher", "debug", "preview"], (_t, res) => {
  // The bang previews' own record: what each fetched bang asked for, whether
  // it produced rows, and the reason when it produced none. The card shows no
  // error row, so this is where a preview that silently kept today's row is
  // read back.
  res(previewDebug())
})

register(["launcher", "debug", "query"], (tokens, res) => {
  // Runs one query through the LIVE combiner with the card hidden and answers
  // the rows it settled on — the request surface's own read of what the card
  // would show, so a preview can be inspected without touching the screen.
  const query = tokens.join(" ").trim()
  if (!query) return res("usage: debug query <query>")
  const run = control?.debugQuery
  if (!run) return res(JSON.stringify({ error: "debugQuery unavailable" }))
  void run
    .call(control, query)
    .then((out) => res(JSON.stringify(out)))
    .catch((e: Error) => res(JSON.stringify({ error: e.message })))
})

// Config (standardized replies: JSON get, "reloaded" reload).
registerConfigCommands("launcher", {
  get: getConfig,
  set: setConfigRaw,
  reloadConfig,
})

register(["launcher", "apps", "reload"], (_t, res) => {
  appsReload()
  res("ok")
})

// `debug` has no handler of its own: a handler on a namespace node INTERCEPTS
// its own children (dispatch calls the first node it finds with a handler), so
// a `debug` catch-all would shadow `debug activate`/`debug preview`/`debug
// query`. Bare `debug` then falls to the registry's own subcommand list.
