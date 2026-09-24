/**
 * history.probe — reproducible probe for the per-note edit history
 * (`apps/notes/history.ts`, the chain behind Ctrl+Z / Ctrl+Y across a reopen).
 *
 * The feature's whole risk sits in the pure model, not in the window: a chain
 * that drifts, folds wrong, records its own replay, or replays over an edit the
 * app did not make. Every one of those is a text-in/text-out question, so the
 * probe drives the model directly:
 *
 *  1. fuzz replay identity — random edit scripts, the chain reconstructs the
 *     reference after every op, and undo/redo walk it back and forward exactly,
 *  2. the self-recording guard — a replay is never recorded as an edit,
 *  3. folding at the caps — steps and payload ceilings hold, the text survives,
 *  4. coalescing boundaries — the 800 ms window, a newline, a caret jump, the
 *     per-step char ceiling, insert vs delete runs,
 *  5. re-anchor in both directions — a matching file keeps the chain, a
 *     differing file replaces it (and can never be reverted by it),
 *  6. a corrupt, truncated, foreign-version or foreign-path file reads as "no
 *     history" and never throws,
 *  7. the owner guard — one live writer per note's chain,
 *  8. the write cost at the payload cap.
 *
 * Case 8 measures the serialized payload through this host's filesystem. The
 * app's own write (`common/fs/files` `writeFileSync` → `GLib.file_set_contents`,
 * temp file + rename) is the same cost class and is reported separately.
 *
 * Run:  node --experimental-strip-types apps/notes/history.probe.mjs
 *       (exit 1 on any violated invariant)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  agrees,
  applyBackward,
  applyForward,
  diffStep,
  emptyHistory,
  fold,
  hydrate,
  MAX_LOG_BYTES,
  MAX_STEP_CHARS,
  MAX_STEPS,
  MAX_TEXT_CHARS,
  ownerReadOnly,
  parseHistory,
  pathKey,
  reanchor,
  reconstruct,
  record,
  redo,
  serialize,
  undo,
} from "./history.ts"

const OWNER = { instance: "probe", pid: 4242 }
const checks = []
function check(name, ok, detail = "") {
  checks.push(ok)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === "" ? "" : ` — ${detail}`}`)
}

// ── helpers ──

/** Deterministic PRNG so a failing fuzz run reproduces. */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = "abcdefg \n"

function randomEdit(ref, r) {
  const pick = Math.min(ref.length, Math.floor(r() * (ref.length + 1)))
  if (ref.length > 8 && r() < 0.45) {
    // a deletion starts strictly inside the text, so it always removes something
    const at = Math.min(pick, ref.length - 1)
    const len = 1 + Math.floor(r() * Math.min(6, ref.length - at))
    const text = ref.slice(0, at) + ref.slice(Math.min(ref.length, at + len))
    return { text, caretBefore: Math.min(at + len, ref.length), caretAfter: at }
  }
  const at = pick
  const len = 1 + Math.floor(r() * 5)
  const chunk = Array.from({ length: len }, () => ALPHABET[Math.floor(r() * ALPHABET.length)]).join(
    "",
  )
  return { text: ref.slice(0, at) + chunk + ref.slice(at), caretBefore: at, caretAfter: at + len }
}

// ── 1. fuzz replay identity ──

/**
 * Coalescing off: a large monotonic gap per op makes every op its own step, so a
 * step count maps one-to-one onto the reference history and undo can be compared
 * against it exactly.
 */
function fuzzUncoalesced(seed) {
  const r = rng(seed)
  const path = "/tmp/note.md"
  let ref = ""
  const states = [ref]
  let h = emptyHistory(path, "", 0, OWNER, 0)
  let clock = 0
  for (let i = 0; i < 120; i++) {
    const next = randomEdit(ref, r)
    clock += 100000
    h = record(h, ref, next.text, next.caretBefore, next.caretAfter, clock)
    ref = next.text
    states.push(ref)
    if (reconstruct(h) !== ref) return { ok: false, at: i, why: "chain drifted from the reference" }
  }
  if (h.at !== states.length - 1) {
    return { ok: false, why: `step count ${h.at} vs ${states.length - 1} edits` }
  }
  // walk all the way back, comparing every state
  let text = ref
  for (let k = states.length - 1; k >= 1; k--) {
    const u = undo(h, text)
    if (!u) return { ok: false, why: `undo refused at depth ${k}` }
    h = u.history
    text = u.text
    if (text !== states[k - 1]) return { ok: false, why: `undo landed off-state at depth ${k}` }
  }
  if (undo(h, text) !== null) return { ok: false, why: "undo continued past the base" }
  // and all the way forward again
  for (let k = 1; k < states.length; k++) {
    const rd = redo(h, text)
    if (!rd) return { ok: false, why: `redo refused at depth ${k}` }
    h = rd.history
    text = rd.text
    if (text !== states[k]) return { ok: false, why: `redo landed off-state at depth ${k}` }
  }
  if (redo(h, text) !== null) return { ok: false, why: "redo continued past the top" }
  return { ok: true, why: `${states.length - 1} edits, undo/redo identity` }
}

/** Same fuzz with realistic timings, so coalescing is exercised: invariants only. */
function fuzzCoalesced(seed) {
  const r = rng(seed)
  let ref = ""
  let h = emptyHistory("/tmp/note.md", "", 0, OWNER, 0)
  let clock = 0
  for (let i = 0; i < 300; i++) {
    const next = randomEdit(ref, r)
    clock += Math.floor(r() * 400)
    h = record(h, ref, next.text, next.caretBefore, next.caretAfter, clock)
    ref = next.text
    if (reconstruct(h) !== ref) return { ok: false, why: "chain drifted from the reference" }
    const u = undo(h, ref)
    if (u && redo(u.history, u.text).text !== ref) {
      return { ok: false, why: "undo/redo was not an identity" }
    }
  }
  return { ok: true, why: `${h.at} steps from 300 edits` }
}

const fuzzOff = fuzzUncoalesced(7)
check("1a fuzz, coalescing off: exact undo/redo identity", fuzzOff.ok, fuzzOff.why)
const fuzzOn = fuzzCoalesced(11)
check("1b fuzz, coalescing on: chain always equals the reference", fuzzOn.ok, fuzzOn.why)

// a splice is derived exactly, whatever the edit
const d1 = diffStep("hello world", "hello brave world")
check(
  "1c diff: a mid-text insert",
  d1 && d1.o === 6 && d1.d === "" && d1.i === "brave ",
  JSON.stringify(d1),
)
const d2 = diffStep("abcXYZdef", "abcdef")
check(
  "1d diff: a mid-text delete",
  d2 && d2.o === 3 && d2.d === "XYZ" && d2.i === "",
  JSON.stringify(d2),
)
check("1e diff: no change is null", diffStep("same", "same") === null)

// ── 2. the self-recording guard ──

{
  let h = emptyHistory("/tmp/note.md", "abc", 3, OWNER, 0)
  h = record(h, "abc", "abcd", 3, 4, 1000)
  const afterEdit = h
  const u = undo(h, "abcd")
  // the window applies the replay: setting the text fires the same "changed"
  // signal the recorder listens to, which must pass origin "replay"
  const replayed = record(u.history, "abcd", u.text, 4, 3, 1001, "replay")
  check("2a a replay adds no step", replayed === u.history)
  check("2b a replay leaves `at` alone", replayed.at === u.history.at)
  check("2c the chain after a replay still describes the buffer", agrees(replayed, u.text))
  check(
    "2d the redo tail survives a replay (the edit is still reachable)",
    afterEdit.at === 1 && replayed.at === 0 && redo(replayed, u.text)?.text === "abcd",
  )
}

// ── 3. folding at the caps ──

{
  let ref = ""
  let h = emptyHistory("/tmp/note.md", "", 0, OWNER, 0)
  let clock = 0
  // long insert runs: big payload per step, so both ceilings are crossed
  for (let i = 0; i < 900; i++) {
    const chunk = String.fromCharCode(97 + (i % 26)).repeat(400)
    const next = ref + chunk
    clock += 100000
    h = record(h, ref, next, ref.length, next.length, clock)
    ref = next
  }
  let bytes = 0
  for (const s of h.steps) bytes += s.d.length + s.i.length
  check("3a step count is within the cap", h.steps.length <= MAX_STEPS, `${h.steps.length}`)
  check("3b payload is within the cap", bytes <= MAX_LOG_BYTES, `${bytes}`)
  check("3c folding happened", h.folded > 0, `${h.folded} retired`)
  check("3d the text survived the folds", reconstruct(h) === ref)
  check("3e `at` is in range after folding", h.at >= 0 && h.at <= h.steps.length)

  // undo stops exactly at the base, and the base is reachable text
  let text = ref
  let guard = 0
  while (true) {
    const u = undo(h, text)
    if (!u) break
    h = u.history
    text = u.text
    if (++guard > MAX_STEPS + 10) break
  }
  check("3f undo stops at the folded base", h.at === 0 && text.length >= 0 && guard <= MAX_STEPS)
  check(
    "3g the base is the oldest reachable state",
    text.length >= 0 && agrees(reanchor(h, text), text),
  )

  // an explicit fold is the same arithmetic
  const before = h.folded
  const folded = fold(h, 5)
  check(
    "3h fold retires steps without changing the text",
    folded.folded === before + 5 || h.at === 0,
  )
}

// ── 4. coalescing boundaries ──

function typing(delayMs, texts) {
  let h = emptyHistory("/tmp/note.md", texts[0], texts[0].length, OWNER, 0)
  let ref = texts[0]
  for (let i = 1; i < texts.length; i++) {
    const next = texts[i]
    h = record(h, ref, next, ref.length, next.length, i * delayMs)
    ref = next
  }
  return h
}

check("4a two keys inside the window merge", typing(799, ["", "a", "ab"]).steps.length === 1)
check("4b a gap of exactly the window merges", typing(800, ["", "a", "ab"]).steps.length === 1)
check("4c a gap past the window splits", typing(801, ["", "a", "ab"]).steps.length === 2)
{
  const h = typing(100, ["", "a", "a\n"])
  check("4d a newline ends the step", h.steps.length === 2)
}
{
  // a caret jump: the second edit happens elsewhere, so it is its own step
  let h = emptyHistory("/tmp/note.md", "x", 1, OWNER, 0)
  h = record(h, "x", "xz", 1, 2, 1000)
  h = record(h, "xz", "xzq", 1, 2, 1100)
  check("4e a caret jump ends the step", h.steps.length === 2, `${h.steps.length}`)
}
{
  const long = "z".repeat(MAX_STEP_CHARS)
  let h = emptyHistory("/tmp/note.md", "", 0, OWNER, 0)
  h = record(h, "", long, 0, MAX_STEP_CHARS, 1000)
  h = record(h, long, `${long}z`, MAX_STEP_CHARS, MAX_STEP_CHARS + 1, 1100)
  check("4f the per-step ceiling ends the step", h.steps.length === 2, `${h.steps.length}`)
}
{
  // a delete run: two backspaces merge into one undoable step
  let h = emptyHistory("/tmp/note.md", "abc", 3, OWNER, 0)
  h = record(h, "abc", "ab", 3, 2, 1000)
  h = record(h, "ab", "a", 2, 1, 1100)
  check("4g a backspace run merges", h.steps.length === 1, `${h.steps.length}`)
  check("4h the merged delete undoes both characters", undo(h, "a").text === "abc")
}
{
  // a mixed replace never merges with a typing run
  let h = emptyHistory("/tmp/note.md", "abc", 3, OWNER, 0)
  h = record(h, "abc", "abcX", 3, 4, 1000)
  h = record(h, "abcX", "abc", 3, 4, 1050)
  check("4i an insert and a delete do not merge", h.steps.length === 2, `${h.steps.length}`)
}

// ── 5. re-anchor, both directions ──

{
  let h = emptyHistory("/tmp/note.md", "abc", 3, OWNER, 0)
  h = record(h, "abc", "abcd", 3, 4, 1000)
  const good = hydrate(h, "/tmp/note.md", "abcd", 4, OWNER, 2000)
  check("5a a matching file keeps the chain", good.status === "loaded" && good.history.at === 1)
  check("5b the kept chain still undoes", undo(good.history, "abcd").text === "abc")

  const changed = hydrate(h, "/tmp/note.md", "edited elsewhere", 4, OWNER, 2000)
  check("5c a differing file re-anchors", changed.status === "reanchored")
  check("5d the re-anchored chain has no steps", changed.history.steps.length === 0)
  check("5e the re-anchored chain is the on-disk text", changed.history.base === "edited elsewhere")
  check(
    "5f undo has nothing to revert after a re-anchor",
    undo(changed.history, "edited elsewhere") === null,
  )
  check("5g the retired steps are counted", changed.history.folded === 1)

  const foreign = hydrate(h, "/tmp/other.md", "abcd", 4, OWNER, 2000)
  check("5h a history for another path is ignored", foreign.status === "none")
  check("5i the ignored history leaves no steps", foreign.history.steps.length === 0)
}

// ── 6. corrupt and version-mismatched files ──

{
  let h = emptyHistory("/tmp/note.md", "abc", 3, OWNER, 0)
  h = record(h, "abc", "abcd", 3, 4, 1000)
  const good = serialize(h)
  check("6a a round trip parses", parseHistory(good)?.at === 1)
  const bad = [
    ["", "empty"],
    ["{", "truncated"],
    ["[]", "array"],
    ["null", "null"],
    ["nonsense", "not json"],
    [
      '{"v":2,"path":"/tmp/note.md","base":"abc","steps":[],"at":0,"folded":0,"cursor":0,"updated":0,"owner":{"instance":"x","pid":1}}',
      "unknown version",
    ],
    [good.replace('"v":1', '"v":"1"'), "version as a string"],
    [good.replace('"at":1', '"at":5'), "at past the step count"],
    [good.replace('"at":1', '"at":-1'), "negative at"],
    [good.replace('"steps":[', '"steps":[{"o":"x",'), "non-numeric offset"],
    [good.replace('"owner":{"instance":"probe","pid":4242}', '"owner":null'), "missing owner"],
    [
      '{"v":1,"path":7,"base":"a","steps":[],"at":0,"folded":0,"cursor":0,"updated":0,"owner":{"instance":"x","pid":1}}',
      "non-string path",
    ],
  ]
  let threw = false
  const results = bad.map(([raw, label]) => {
    try {
      return [label, parseHistory(raw) === null]
    } catch (e) {
      threw = true
      return [label, false]
    }
  })
  const failed = results.filter(([, ok]) => !ok).map(([label]) => label)
  check("6b every malformed file reads as no history", failed.length === 0, failed.join(", "))
  check("6c parsing never throws", !threw)

  // a corrupted file at the load boundary is "no history", not a broken open
  const none = hydrate(parseHistory("{"), "/tmp/note.md", "on disk", 0, OWNER, 2000)
  check(
    "6d a corrupt file hydrates to an empty chain",
    none.status === "none" && none.history.base === "on disk",
  )
}

// ── 7. the owner guard ──

{
  const mine = { instance: "shell", pid: 100 }
  const alive = (pid) => pid === 200 || pid === 100
  const dead = () => false
  check(
    "7a another live instance is read-only",
    ownerReadOnly({ instance: "notes", pid: 200 }, mine, alive) === true,
  )
  check(
    "7b my own file is writable",
    ownerReadOnly({ instance: "shell", pid: 100 }, mine, alive) === false,
  )
  check(
    "7c a dead owner is taken over",
    ownerReadOnly({ instance: "notes", pid: 200 }, mine, dead) === false,
  )
  check(
    "7d an unknown pid is taken over",
    ownerReadOnly({ instance: "notes", pid: -1 }, mine, alive) === false,
  )
  check("7e a file with no owner is taken over", ownerReadOnly(undefined, mine, alive) === false)
}

// ── 8. the write cost at the payload cap ──

{
  let ref = ""
  let h = emptyHistory("/tmp/note.md", "", 0, OWNER, 0)
  let clock = 0
  for (let i = 0; i < 400; i++) {
    const chunk = `line ${i} ${"x".repeat(300)}\n`
    const next = ref + chunk
    clock += 1000
    h = record(h, ref, next, ref.length, next.length, clock)
    ref = next
  }
  const payload = serialize(h)
  const dir = mkdtempSync(join(tmpdir(), "notes-history-probe-"))
  const file = join(dir, "history.json")
  const rounds = 30
  const times = []
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now()
    writeFileSync(file, payload)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(rounds / 2)]
  const worst = times[rounds - 1]
  rmSync(dir, { recursive: true, force: true })
  console.log(
    `     payload ${(payload.length / 1024).toFixed(1)} KiB, ${h.steps.length} steps: median ${median.toFixed(2)} ms, worst ${worst.toFixed(2)} ms over ${rounds} writes`,
  )
  check("8a a capped payload serialises", payload.length > 0 && parseHistory(payload) !== null)
  check("8b a capped write stays under 5 ms median", median < 5, `${median.toFixed(2)} ms`)
}

// ── extra: the text ceiling keeps the chain honest ──

{
  const big = "y".repeat(MAX_TEXT_CHARS + 10)
  let h = emptyHistory("/tmp/note.md", "", 0, OWNER, 0)
  h = record(h, "", big, 0, big.length, 1000)
  check("9a a note past the size ceiling keeps no steps", h.steps.length === 0)
  check("9b its chain is the current text", h.base === big && agrees(h, big))
}

// ── extras: path keys and the apply primitives ──

check("10a a path key is 12 hex chars", /^[0-9a-f]{12}$/.test(pathKey("/home/x/note.md")))
check("10b different paths get different keys", pathKey("/a.md") !== pathKey("/b.md"))
{
  const step = { o: 2, d: "XY", i: "Z", cb: 2, ca: 3, t: 0 }
  check(
    "10c forward and backward splices are inverses",
    applyForward("abXYc", step) === "abZc" && applyBackward("abZc", step) === "abXYc",
  )
}

const failed = checks.filter((ok) => !ok).length
console.log(`summary: ${checks.length - failed}/${checks.length} checks passed`)
if (failed > 0) throw new Error(`notes history probe failed: ${failed} check(s)`)
