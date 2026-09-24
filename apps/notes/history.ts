/**
 * history.ts — the per-note edit history behind Ctrl+Z / Ctrl+Y.
 *
 * GTK's own undo stack lives inside the Gtk.TextBuffer: it is per-widget, it
 * cannot be serialised, and it dies with the window, so a note reopened after a
 * close comes back with an empty stack. This module is the ONE stack instead. A
 * note keeps a splice operation log over a baseline text; the note window
 * serialises it into the app state dir and reads it back when the window is
 * created, so undo and redo reach across a close.
 *
 * MODEL: `base` is the full text at the oldest reachable point and
 * `steps[0 .. at)` are applied on top of it, so `at` is both the position of the
 * current text and the size of the undo stack. Undo walks `at` back, redo walks
 * it forward, and a new edit truncates the redo tail. A step is a splice: an
 * offset plus the text removed and inserted there, derived by diffing the
 * previous text against the current one — exact, and free of TextIter plumbing.
 *
 * INVARIANTS the callers and the probe rely on:
 *  - `reconstruct(h)` always describes the note file the chain was written
 *    against. Any disagreement resolves to a RE-ANCHOR (the chain is replaced by
 *    the on-disk text), never to a replay: undo must not revert an edit the app
 *    did not make. This module never writes a file — history-store.ts does, and
 *    nothing here touches the note's own .md.
 *  - Undo/redo verify the text they are about to revert and refuse (return null)
 *    when the buffer disagrees with the chain, so a stale chain can never corrupt
 *    a note.
 *
 * The module is PURE (no gi, no IO): the file side is history-store.ts, the
 * caller is Note.tsx, and history.probe.mjs drives every rule below.
 */

/** One splice: what a single recorded edit did to the text. */
export interface Step {
  /** Offset in the text BEFORE this step where the splice starts. */
  o: number
  /** Text removed at `o` ("" for a pure insert). */
  d: string
  /** Text inserted at `o` ("" for a pure delete). */
  i: string
  /** Insert-mark offset before the step. */
  cb: number
  /** Insert-mark offset after the step. */
  ca: number
  /** Arrival time of the step (monotonic ms) — the coalescing window. */
  t: number
}

/** Who wrote a history file: the instance name plus the writing pid. */
export interface Owner {
  instance: string
  pid: number
}

export interface History {
  v: 1
  /** Absolute note path this chain belongs to (verified on load). */
  path: string
  base: string
  steps: Step[]
  at: number
  /** Steps retired by folding, kept for the debug surface. */
  folded: number
  /** Insert-mark offset as of the last persist. */
  cursor: number
  owner: Owner
  updated: number
}

// ── bounds ──
// Every one of these is a hard ceiling: the log is folded into the baseline when
// it is crossed, so history is bounded without ever growing silently.

/** Undo depth per note. */
export const MAX_STEPS = 400
/** Total step payload (removed + inserted chars) per note. */
export const MAX_LOG_BYTES = 256 * 1024
/** One coalesced step stops here, so a single undo cannot swallow a wall of text. */
export const MAX_STEP_CHARS = 3000
/** Above this note size the chain becomes a single snapshot and recording stops. */
export const MAX_TEXT_CHARS = 256 * 1024
/** Consecutive edits within this gap merge into one undo step. */
export const COALESCE_MS = 800
/** Steps retired per fold — chunked so folding stays amortised. */
export const FOLD_CHUNK = 64

export const HISTORY_VERSION = 1

// ── hashing ──

/** FNV-1a over UTF-16 code units: the file-key and chain-fingerprint digest. */
export function hashText(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/** File-name key for a note path: two digests so a collision needs two. */
export function pathKey(path: string): string {
  return (hashText(path) + hashText(`k${path.length}:${path}`)).slice(0, 12)
}

// ── splice arithmetic ──

/** The splice that turns `prev` into `next`; null when they are equal. */
export function diffStep(prev: string, next: string): { o: number; d: string; i: string } | null {
  if (prev === next) return null
  const max = Math.min(prev.length, next.length)
  let start = 0
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++
  let endPrev = prev.length
  let endNext = next.length
  while (
    endPrev > start &&
    endNext > start &&
    prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrev--
    endNext--
  }
  return { o: start, d: prev.slice(start, endPrev), i: next.slice(start, endNext) }
}

/** Apply a step forward (redo/replay direction). */
export function applyForward(text: string, step: Step): string {
  return text.slice(0, step.o) + step.i + text.slice(step.o + step.d.length)
}

/** Apply a step backward (undo direction). */
export function applyBackward(text: string, step: Step): string {
  return text.slice(0, step.o) + step.d + text.slice(step.o + step.i.length)
}

/** The text the chain describes at `at`. */
export function reconstruct(h: History): string {
  let text = h.base
  for (let k = 0; k < h.at; k++) text = applyForward(text, h.steps[k])
  return text
}

function logBytes(h: History): number {
  let n = 0
  for (const s of h.steps) n += s.d.length + s.i.length
  return n
}

// ── construction ──

export function emptyHistory(
  path: string,
  base: string,
  cursor: number,
  owner: Owner,
  now: number,
): History {
  return {
    v: HISTORY_VERSION,
    path,
    base,
    steps: [],
    at: 0,
    folded: 0,
    cursor,
    owner,
    updated: Math.floor(now / 1000),
  }
}

/** Replace the chain with a snapshot of `text` — the re-anchor primitive. */
export function reanchor(h: History, text: string): History {
  return {
    ...h,
    base: text,
    steps: [],
    at: 0,
    folded: h.folded + h.steps.length,
    cursor: Math.max(0, Math.min(h.cursor, text.length)),
  }
}

// ── recording ──

/**
 * Fold `k` steps out of the log into the baseline: replay them onto `base` and
 * drop them. The text is unchanged on purpose — what is lost is the ability to
 * undo past the fold, which is how the bounds are enforced.
 */
export function fold(h: History, k: number): History {
  const n = Math.max(0, Math.min(Math.floor(k), h.at))
  if (n === 0) return h
  let base = h.base
  for (let j = 0; j < n; j++) base = applyForward(base, h.steps[j])
  return { ...h, base, steps: h.steps.slice(n), at: h.at - n, folded: h.folded + n }
}

/** Fold until the log is within its caps (chunked; stops at `at` — the redo tail is never folded). */
export function bound(h: History): History {
  let out = h
  while ((out.steps.length > MAX_STEPS || logBytes(out) > MAX_LOG_BYTES) && out.at > 0) {
    out = fold(out, Math.min(out.at, FOLD_CHUNK))
  }
  return out
}

/**
 * True when `head` continues `prev` as one human edit: same kind, no time gap,
 * the caret never left the splice, and the merge stays under the char ceiling.
 */
function continues(prev: Step, head: Step, nowMs: number): boolean {
  if (nowMs - prev.t > COALESCE_MS) return false
  if (head.cb !== prev.ca) return false
  if (head.d === "" && head.i !== "" && prev.d === "") {
    if (head.o !== prev.o + prev.i.length) return false
    if (head.i.includes("\n")) return false
    return prev.i.length + head.i.length <= MAX_STEP_CHARS
  }
  if (head.i === "" && head.d !== "" && prev.i === "") {
    // A backspace run deletes at a falling offset (the new deletion sits
    // immediately before the previous one); a forward-delete run stays at one
    // offset. Both are one human edit.
    const adjacent = head.o === prev.o || head.o + head.d.length === prev.o
    if (!adjacent) return false
    return prev.d.length + head.d.length <= MAX_STEP_CHARS
  }
  return false
}

/**
 * Record one buffer change. `origin` is "replay" while the window is applying
 * this module's own undo/redo, which must never record itself as an edit — the
 * only reason the recorder needs to know where a change came from.
 *
 * `caretBefore` is the insert-mark offset the change started from and `caretAfter`
 * where it ended; both are stored so undo can put the caret back where the edit
 * was made.
 */
export function record(
  h: History,
  prevText: string,
  nextText: string,
  caretBefore: number,
  caretAfter: number,
  nowMs: number,
  origin: "user" | "replay" = "user",
): History {
  if (origin === "replay") return h
  const diff = diffStep(prevText, nextText)
  if (!diff) return { ...h, cursor: caretAfter }
  // A note past the size ceiling keeps no chain: re-anchor to the current text so
  // the chain always describes the note, then stop adding steps.
  if (nextText.length > MAX_TEXT_CHARS) {
    return { ...reanchor(h, nextText), cursor: caretAfter }
  }

  const steps = h.steps.slice(0, h.at)
  const head: Step = { ...diff, cb: caretBefore, ca: caretAfter, t: nowMs }
  const last = steps[steps.length - 1]
  if (last && continues(last, head, nowMs)) {
    if (last.d === "") {
      steps[steps.length - 1] = { ...last, i: last.i + head.i, ca: caretAfter, t: nowMs }
    } else if (head.o + head.d.length === last.o) {
      // backspace: the new deletion precedes the previous one
      steps[steps.length - 1] = { ...last, o: head.o, d: head.d + last.d, ca: caretAfter, t: nowMs }
    } else {
      steps[steps.length - 1] = { ...last, d: last.d + head.d, ca: caretAfter, t: nowMs }
    }
  } else {
    steps.push(head)
  }
  return bound({ ...h, steps, at: steps.length, cursor: caretAfter })
}

// ── undo / redo ──

export interface Replay {
  history: History
  text: string
  cursor: number
}

/**
 * Step back one edit. Null when there is nothing to undo, or when `text` does
 * not hold what the step says it inserted — a chain that disagrees with the
 * buffer must never be replayed over it.
 */
export function undo(h: History, text: string): Replay | null {
  if (h.at === 0) return null
  const step = h.steps[h.at - 1]
  if (text.slice(step.o, step.o + step.i.length) !== step.i) return null
  const cursor = Math.max(0, Math.min(step.cb, text.length))
  return { history: { ...h, at: h.at - 1, cursor }, text: applyBackward(text, step), cursor }
}

/** Step forward one undone edit. Null when the redo tail is empty or disagrees. */
export function redo(h: History, text: string): Replay | null {
  if (h.at >= h.steps.length) return null
  const step = h.steps[h.at]
  if (text.slice(step.o, step.o + step.d.length) !== step.d) return null
  const cursor = Math.max(0, Math.min(step.ca, text.length))
  return { history: { ...h, at: h.at + 1, cursor }, text: applyForward(text, step), cursor }
}

// ── load-time validation ──

/**
 * Bring a chain and the text read from disk together. `loaded` = the chain
 * describes that text exactly; `reanchored` = the file changed outside the app
 * (another editor, a sync tool, a shell) and the chain is replaced by what is
 * on disk, so its steps can never revert someone else's edit; `none` = no usable
 * history file.
 */
export function hydrate(
  parsed: History | null,
  path: string,
  diskText: string,
  cursor: number,
  owner: Owner,
  nowMs: number,
): { history: History; status: "loaded" | "reanchored" | "none" } {
  if (!parsed || parsed.path !== path) {
    return { history: emptyHistory(path, diskText, cursor, owner, nowMs), status: "none" }
  }
  if (reconstruct(parsed) === diskText) return { history: parsed, status: "loaded" }
  return { history: reanchor(parsed, diskText), status: "reanchored" }
}

/** True while this module's chain still describes `diskText` (focus-out re-check). */
export function agrees(h: History, diskText: string): boolean {
  return reconstruct(h) === diskText
}

/**
 * True when another LIVE process owns this note's history and this one may read
 * it but must not write it: a hand-started dev island beside the shell must not
 * clobber the chain the other instance is backing.
 */
export function ownerReadOnly(
  fileOwner: Owner | undefined,
  mine: Owner,
  pidAlive: (pid: number) => boolean,
): boolean {
  if (!fileOwner) return false
  if (!Number.isInteger(fileOwner.pid) || fileOwner.pid <= 0) return false
  if (fileOwner.pid === mine.pid && fileOwner.instance === mine.instance) return false
  if (!pidAlive(fileOwner.pid)) return false
  return true
}

// ── serialisation ──

export function serialize(h: History): string {
  return JSON.stringify(h)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

function isStep(v: unknown): v is Step {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false
  const s = v as Record<string, unknown>
  return (
    isFiniteNumber(s.o) &&
    typeof s.d === "string" &&
    typeof s.i === "string" &&
    isFiniteNumber(s.cb) &&
    isFiniteNumber(s.ca) &&
    isFiniteNumber(s.t)
  )
}

/**
 * Parse a history file. Anything malformed — garbage, a truncated write, an
 * unknown version, a foreign shape — reads as "no history" rather than throwing:
 * a broken history file must never keep a note from opening.
 */
export function parseHistory(raw: string): History | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  if (o.v !== HISTORY_VERSION) return null
  if (typeof o.path !== "string" || typeof o.base !== "string") return null
  if (!Array.isArray(o.steps) || !o.steps.every(isStep)) return null
  if (!isFiniteNumber(o.at) || o.at < 0 || o.at > o.steps.length) return null
  if (!isFiniteNumber(o.cursor) || !isFiniteNumber(o.folded) || !isFiniteNumber(o.updated)) {
    return null
  }
  const owner = o.owner as Record<string, unknown> | undefined
  if (!owner || typeof owner.instance !== "string" || !isFiniteNumber(owner.pid)) return null
  return {
    v: HISTORY_VERSION,
    path: o.path,
    base: o.base,
    steps: o.steps as Step[],
    at: o.at as number,
    folded: o.folded as number,
    cursor: o.cursor as number,
    owner: { instance: owner.instance, pid: owner.pid as number },
    updated: o.updated as number,
  }
}
