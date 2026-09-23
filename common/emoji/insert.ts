/**
 * Emoji insertion — the runtime glue around common/emoji/insert-plan.ts.
 *
 * The decision ladder lives in insert-plan.ts (pure, harness-tested). This
 * module supplies the real effects and the TIMING the ladder cannot express:
 *   - capture the focused toplevel when the surface OPENS (targetBefore),
 *   - schedule the injection AFTER the layer surface hides (never
 *     synchronously on activation — focus restore is asynchronous),
 *   - probe the focused toplevel again (targetAfter) and let the ladder
 *     refuse when it is missing or different,
 *   - restore the previous clipboard text after the target has pasted.
 *
 * The caller supplies the settings (`InsertSettings`) — this module reads no
 * config of its own (common/ has no config owner), so the surface that owns
 * the store owns the values.
 *
 * Safety rule (insert-plan): if anything about the target is uncertain the
 * ladder degrades to copy-only; the glyph is put on the clipboard before any
 * injection, so a copy-only result is never a lost emoji.
 */

import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import { copy } from "@common/clipboard"
import { hyprctlJson } from "@common/hyprland/dispatch"
import { log } from "@common/log/logger"
import { run } from "@common/subprocess/run"
import {
  executeInsertion,
  type InsertDeps,
  type InsertMode,
  type TargetInfo,
  type Typer,
} from "./insert-plan"

/** The insertion settings the CALLER owns (its config store, its values). */
export interface InsertSettings {
  mode: InsertMode
  /** Preferred typer; the other is the failover. */
  preferTyper: Typer
  /** Class names whose paste chord is Ctrl+Shift+V (terminals). */
  terminalClasses: string[]
  /** Restore the previous clipboard text after a successful paste. */
  restoreClipboard: boolean
  /** Wait after the surface hides before injecting. */
  delayMs: number
  /** Wait after a paste before restoring the pre-pick clipboard. */
  restoreDelayMs: number
}

/** Focused toplevel as reported by `hyprctl -j activewindow`, or null. */
async function probeActiveWindow(): Promise<TargetInfo | null> {
  const aw = await hyprctlJson("activewindow")
  if (!aw || typeof aw.address !== "string" || !aw.address) return null
  return { address: aw.address, class: typeof aw.class === "string" ? aw.class : "" }
}

function binAvailable(name: string): boolean {
  return GLib.find_program_in_path(name) !== null
}

/** Read the current clipboard text (null when empty / not text / too slow). */
function snapshotClipboard(): Promise<string | null> {
  return new Promise((resolve) => {
    const display = Gdk.Display.get_default()
    const clip = display?.get_clipboard()
    if (!clip) return resolve(null)
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      resolve(v)
    }
    // A wedged clipboard owner must not hang the caller: answer null past 400ms.
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
      finish(null)
      return GLib.SOURCE_REMOVE
    })
    try {
      ;(clip as any).read_text_async(null, (_c: any, res: any) => {
        GLib.source_remove(timer)
        try {
          finish(clip.read_text_finish(res))
        } catch (e) {
          log(`emoji: clipboard read failed: ${(e as Error).message}`)
          finish(null)
        }
      })
    } catch (e) {
      GLib.source_remove(timer)
      log(`emoji: clipboard read unavailable: ${(e as Error).message}`)
      finish(null)
    }
  })
}

const defaultDeps: InsertDeps = {
  run: (argv) => run(argv, { timeoutMs: 1500 }).then((r) => ({ exit: r.exit })),
  hasBinary: binAvailable,
  copyToClipboard: (text) => copy(text),
  log: (msg) => log(msg),
}

/**
 * A pick's captured target lives with the pick, never in a module slot: the
 * picker awaits `beginPick()` and passes the resolved target to
 * `insertGlyph`, so a second pick inside `insert.delayMs` cannot make the
 * first insertion consume the second capture. `generation` is the belt: every
 * new pick (or insert) bumps it, and a scheduled insertion whose generation
 * is stale is dropped instead of probing/injecting while a newer picker is up.
 */
let generation = 0

/**
 * Start a new pick: invalidate any scheduled insertion and capture the focused
 * window NOW (before the surface takes focus). Returns the captured target —
 * the caller owns it and passes it to `insertGlyph`.
 */
export function beginPick(): Promise<TargetInfo | null> {
  generation++
  return probeActiveWindow()
}

/** Cancel any scheduled insertion (the surface unloaded). */
export function resetTarget(): void {
  generation++
}

/** Schedule `fn` for the next main-loop turn, then optionally wait delayMs —
 *  the injection must never run synchronously inside the activate handler. */
function scheduleAfterHide(delayMs: number, fn: () => void): void {
  GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    if (delayMs > 0) {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
        fn()
        return GLib.SOURCE_REMOVE
      })
    } else {
      fn()
    }
    return GLib.SOURCE_REMOVE
  })
}

/**
 * Insert `glyph` into the focused application. Fire-and-forget: the caller
 * hides its surface first, then calls this with the target ITS pick captured
 * (`beginPick`) and its own `settings`. Runs the plan in insert-plan.ts after
 * the surface is gone.
 */
export function insertGlyph(
  glyph: string,
  targetBefore: TargetInfo | null,
  settings: InsertSettings,
): void {
  const mode = settings.mode
  const restoreWanted = settings.restoreClipboard
  const delayMs = Math.max(0, settings.delayMs)
  // This insertion supersedes any earlier scheduled one (and a later pick
  // supersedes this one).
  const gen = ++generation

  // Snapshot the clipboard BEFORE anything mutates it.
  const priorClipboard = restoreWanted ? snapshotClipboard() : Promise.resolve(null)

  const req = {
    glyph,
    mode,
    preferTyper: settings.preferTyper,
    terminalClasses: settings.terminalClasses,
    restoreClipboard: restoreWanted,
    targetBefore,
    targetAfter: null as TargetInfo | null,
    wtypeAvailable: binAvailable("wtype"),
    ydotoolAvailable: binAvailable("ydotool"),
  }

  scheduleAfterHide(delayMs, () => {
    if (gen !== generation) {
      log(`emoji: insertion for ${glyph} superseded by a newer pick — dropped`)
      return
    }
    void (async () => {
      req.targetAfter = await probeActiveWindow()
      const prior = await priorClipboard
      const outcome = await executeInsertion(defaultDeps, req, prior)
      log(
        `emoji: insert glyph=${glyph} mode=${mode} action=${outcome.action.kind}` +
          (outcome.action.kind === "copy" ? ` (${outcome.action.reason})` : "") +
          (outcome.injectedArgv ? ` argv=${outcome.injectedArgv.join(" ")}` : ""),
      )
      if (outcome.restoreClipboard && prior !== null) {
        const restoreDelay = Math.max(0, settings.restoreDelayMs)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, restoreDelay, () => {
          void (async () => {
            // Only restore when the clipboard still holds the glyph we wrote:
            // anything the user copied in the meantime is theirs, not ours to
            // clobber.
            const current = await snapshotClipboard()
            if (current !== glyph) {
              log("emoji: clipboard changed since the paste — restore skipped")
              return
            }
            copy(prior)
          })()
          return GLib.SOURCE_REMOVE
        })
      }
    })()
  })
}
