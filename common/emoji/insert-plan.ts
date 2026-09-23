/**
 * Emoji insertion decision logic — PURE module (no gi:// imports, no
 * side effects of its own). Every effect is injected through `InsertDeps`, so
 * the whole ladder is exercisable from a plain-Node harness with a stub
 * injector that records the argv it would run.
 *
 * The ladder — copy-only is the floor, the glyph is never lost:
 *   1. mode "copy"                       → copy
 *   2. no target captured before opening → copy
 *   3. no focused window after closing   → copy
 *   4. focus moved to another window     → copy
 *   5. no typer binary available         → copy
 *   6. mode "type"                        → type the glyph with the typer
 *   7. mode "paste"                       → synthetic paste chord
 *        terminal-class target             → ctrl+shift+v
 *        anything else                     → ctrl+v
 *   8. the chosen typer exits non-zero    → retry the other typer once
 *   9. both typers fail                   → copy
 *
 * Clipboard: the glyph is put on the clipboard BEFORE anything else, for
 * EVERY outcome — mode "copy", every degrade path, and a failed injection.
 * The copy floor is what makes "copy-only" a real result rather than a lost
 * glyph. When the action was a paste and a previous clipboard text was
 * captured, the caller restores that text after the target has pasted.
 */

export type InsertMode = "paste" | "type" | "copy"
export type Typer = "wtype" | "ydotool"
type PasteChord = "ctrl+v" | "ctrl+shift+v"

/** The focused toplevel as reported by `hyprctl -j activewindow`. */
export interface TargetInfo {
  address: string
  class: string
}

export interface InsertRequest {
  glyph: string
  mode: InsertMode
  /** Preferred typer from config; the other is the failover. */
  preferTyper: Typer
  /** Class names whose paste chord is Ctrl+Shift+V (terminals). */
  terminalClasses: string[]
  /** Restore the previous clipboard text after a successful paste. */
  restoreClipboard: boolean
  /** Active window captured when the picker opened (null = none). */
  targetBefore: TargetInfo | null
  /** Active window probed after the picker hid (null = none). */
  targetAfter: TargetInfo | null
  wtypeAvailable: boolean
  ydotoolAvailable: boolean
}

type InsertAction =
  | {
      kind: "paste"
      typer: Typer
      chord: PasteChord
      reason: string
      /** The clipboard is mutated by a paste, so it is restored afterwards. */
      restoreClipboard: true
    }
  | { kind: "type"; typer: Typer; reason: string; restoreClipboard: false }
  | { kind: "copy"; reason: string }

interface InsertOutcome {
  /** The action finally taken (a plan may degrade to copy). */
  action: InsertAction
  /** The argv actually run (null in copy-only). */
  injectedArgv: string[] | null
  /** Whether the caller should restore the pre-pick clipboard afterwards. */
  restoreClipboard: boolean
  /** Whether the glyph reached the clipboard (false = the write threw). */
  clipboardWritten: boolean
}

export interface InsertDeps {
  run(argv: string[]): Promise<{ exit: number }>
  hasBinary(name: string): boolean
  copyToClipboard(text: string): void
  log(msg: string): void
}

/* ── argv builders (pure; exported so the harness asserts literal argv) ── */

/** wtype: modifiers auto-release when the process exits. */
const WTYPE_CHORD: Record<PasteChord, string[]> = {
  "ctrl+v": ["wtype", "-M", "ctrl", "-k", "v"],
  "ctrl+shift+v": ["wtype", "-M", "ctrl", "-M", "shift", "-k", "v"],
}

/** ydotool keycodes: KEY_LEFTCTRL=29, KEY_LEFTSHIFT=42, KEY_V=47. */
const YDOTOOL_CHORD: Record<PasteChord, string[]> = {
  "ctrl+v": ["ydotool", "key", "29:1", "47:1", "47:0", "29:0"],
  "ctrl+shift+v": ["ydotool", "key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"],
}

function chordArgv(typer: Typer, chord: PasteChord): string[] {
  return [...(typer === "wtype" ? WTYPE_CHORD[chord] : YDOTOOL_CHORD[chord])]
}

function typeArgv(typer: Typer, text: string): string[] {
  return typer === "wtype" ? ["wtype", text] : ["ydotool", "type", text]
}

/* ── selection ── */

function available(req: InsertRequest, typer: Typer): boolean {
  return typer === "wtype" ? req.wtypeAvailable : req.ydotoolAvailable
}

/** Primary typer (preference, else the other), or null when neither exists. */
function pickTyper(req: InsertRequest): Typer | null {
  if (available(req, req.preferTyper)) return req.preferTyper
  const other: Typer = req.preferTyper === "wtype" ? "ydotool" : "wtype"
  return available(req, other) ? other : null
}

/** The other typer if it is installed, else null (failover candidate). */
function fallbackTyper(req: InsertRequest, used: Typer): Typer | null {
  const other: Typer = used === "wtype" ? "ydotool" : "wtype"
  return available(req, other) ? other : null
}

/* ── the ladder ── */

function planInsertion(req: InsertRequest): InsertAction {
  if (req.mode === "copy") return { kind: "copy", reason: "mode=copy" }

  const before = req.targetBefore
  const after = req.targetAfter
  if (!before?.address) return { kind: "copy", reason: "no target captured before opening" }
  if (!after?.address) return { kind: "copy", reason: "no focused window after closing" }
  if (after.address !== before.address)
    return { kind: "copy", reason: "focus moved to another window" }

  const typer = pickTyper(req)
  if (!typer) return { kind: "copy", reason: "no typer available (wtype/ydotool)" }

  if (req.mode === "type")
    return { kind: "type", typer, reason: "direct typing", restoreClipboard: false }

  const terminal = req.terminalClasses.includes(after.class)
  return {
    kind: "paste",
    typer,
    chord: terminal ? "ctrl+shift+v" : "ctrl+v",
    reason: terminal ? "terminal target" : "window target",
    restoreClipboard: true,
  }
}

async function tryRun(deps: InsertDeps, argv: string[]): Promise<boolean> {
  try {
    const r = await deps.run(argv)
    return r.exit === 0
  } catch (e) {
    deps.log(`emoji: injection failed: ${String(e)}`)
    return false
  }
}

/**
 * Run the ladder. `priorClipboard` is the text captured before the pick
 * (null when none / not text). Pure apart from the injected deps.
 */
export async function executeInsertion(
  deps: InsertDeps,
  req: InsertRequest,
  priorClipboard: string | null,
): Promise<InsertOutcome> {
  const action = planInsertion(req)

  // The copy floor is UNCONDITIONAL and comes FIRST: the glyph reaches the
  // clipboard before any branch returns, so mode=copy and every degrade path
  // (no target, focus moved, no typer, injection failure) leave the picked
  // glyph pasteable. Running any of those before the write is what made
  // "copy-only" lose the glyph.
  try {
    deps.copyToClipboard(req.glyph)
  } catch (e) {
    // A failed write must NOT fall through to injection: the target would
    // paste whatever stale content is on the clipboard.
    deps.log(`emoji: clipboard write failed: ${String(e)}`)
    return {
      action: { kind: "copy", reason: "clipboard write failed" },
      injectedArgv: null,
      restoreClipboard: false,
      clipboardWritten: false,
    }
  }

  if (action.kind === "copy") {
    deps.log(`emoji: copy-only (${action.reason})`)
    return { action, injectedArgv: null, restoreClipboard: false, clipboardWritten: true }
  }

  const argvFor = (t: Typer): string[] =>
    action.kind === "type" ? typeArgv(t, req.glyph) : chordArgv(t, action.chord)

  let used = action.typer
  let argv = argvFor(used)
  let ok = await tryRun(deps, argv)

  if (!ok) {
    const alt = fallbackTyper(req, used)
    if (alt) {
      deps.log(`emoji: ${used} failed, trying ${alt}`)
      used = alt
      argv = argvFor(alt)
      ok = await tryRun(deps, argv)
    }
  }

  if (!ok) {
    deps.log("emoji: injection failed, glyph left on the clipboard")
    return {
      action: { kind: "copy", reason: "injection failed — glyph copied" },
      injectedArgv: null,
      restoreClipboard: false,
      clipboardWritten: true,
    }
  }

  const finalAction: InsertAction = { ...action, typer: used }
  return {
    action: finalAction,
    injectedArgv: argv,
    restoreClipboard: action.kind === "paste" && req.restoreClipboard && priorClipboard !== null,
    clipboardWritten: true,
  }
}
