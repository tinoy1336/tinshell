/**
 * history-store.probe — the FILE side of the per-note edit history
 * (`apps/notes/history-store.ts` over `history.ts`), driven for real.
 *
 * The pure probe covers the model; this one covers the parts that only exist on
 * disk: the state-dir path per note, a save/load round trip, the re-anchor when
 * the note file changed outside the app, an unusable history file, the owner
 * guard read through the real loader, the retention prune, and — the invariant
 * the whole feature rests on — that the history path NEVER writes the note's
 * own .md file.
 *
 * Every path it touches is inside a scratch XDG_STATE_HOME, so it neither reads
 * nor writes the user's real notes, state or history: run it under
 * `XDG_STATE_HOME=$(mktemp -d)`.
 *
 * Run:
 *   XDG_STATE_HOME=$(mktemp -d) bash -c \
 *     'ags bundle --gtk 4 apps/notes/history-store.probe.ts /tmp/notes-history-store-probe.sh && \
 *      bash /tmp/notes-history-store-probe.sh'
 *   (exit 1 on any violated invariant)
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { appStateFilePath } from "@common/state"
import { agrees, emptyHistory, type History, record } from "./history"
import {
  currentOwner,
  HISTORY_FILE_MAX,
  historyPathFor,
  loadForNote,
  pruneHistoryFiles,
  saveForNote,
} from "./history-store"

const checks: [string, boolean, string][] = []
function check(name: string, ok: boolean, detail = ""): void {
  checks.push([name, ok, detail])
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === "" ? "" : ` — ${detail}`}`)
}

const stateDir = GLib.getenv("XDG_STATE_HOME")
if (!stateDir) throw new Error("run this probe with XDG_STATE_HOME set to a scratch dir")
const scratch = GLib.build_filenamev([stateDir, "scratch"])
GLib.mkdir_with_parents(scratch, 0o700)

const notePath = GLib.build_filenamev([scratch, "note.md"])
const NOTE_TEXT = "hello"
writeText(notePath, NOTE_TEXT)
const noteMtimeBefore = mtimeOf(notePath)

function writeText(path: string, text: string): void {
  GLib.file_set_contents(path, text)
}

function readText(path: string): string | null {
  try {
    const [ok, contents] = GLib.file_get_contents(path)
    if (!ok || !contents) return null
    return new TextDecoder().decode(contents)
  } catch {
    return null
  }
}

function mtimeOf(path: string): number {
  try {
    const info = Gio.File.new_for_path(path).query_info(
      "time::modified",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    return info.get_attribute_uint64("time::modified")
  } catch {
    return 0
  }
}

function historyFileCount(): number {
  const dir = GLib.path_get_dirname(historyPathFor("/x"))
  let n = 0
  try {
    const it = Gio.File.new_for_path(dir).enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    let info: Gio.FileInfo | null
    while ((info = it.next_file(null))) {
      const name = info.get_name()
      if (name.startsWith("history-") && name.endsWith(".json")) n++
    }
  } catch {
    return -1
  }
  return n
}

// ── path shape ──

const historyPath = historyPathFor(notePath)
check(
  "1 the history file lives in the app state dir",
  historyPath.startsWith(stateDir),
  historyPath,
)
check(
  "2 it follows the canonical name",
  historyPath === appStateFilePath("notes", `history-${historyPath.slice(-17, -5)}.json`),
  historyPath,
)
check(
  "3 it is NOT next to the note file",
  GLib.path_get_dirname(historyPath) !== GLib.path_get_dirname(notePath),
)

// ── save / load round trip ──

const now = 1_700_000_000_000
let chain: History = emptyHistory(notePath, NOTE_TEXT, 5, currentOwner(), now)
chain = record(chain, NOTE_TEXT, "hello world", 5, 11, now)
check("4 a chain saves", saveForNote(chain))
check("5 the file lands where the loader looks", readText(historyPath) !== null)

const loaded = loadForNote(notePath, "hello world", now + 1)
check("6 a matching file loads the chain", loaded.status === "loaded" && loaded.history.at === 1)
check("7 the loaded chain is writable by this instance", loaded.readOnly === false)
check("8 the loaded chain describes the file", agrees(loaded.history, "hello world"))

// ── the note file changed outside the app ──

const changed = loadForNote(notePath, "edited by another editor", now + 2)
check("9 an external change re-anchors", changed.status === "reanchored")
check(
  "10 the re-anchored chain holds the on-disk text",
  changed.history.base === "edited by another editor",
)
check("11 the re-anchored chain has nothing to undo", changed.history.steps.length === 0)

// ── an unusable history file ──

writeText(historyPath, "{ this is not json")
const corrupt = loadForNote(notePath, "hello world", now + 3)
check("12 a corrupt history file reads as no history", corrupt.status === "none")
check("13 and never throws", corrupt.history.base === "hello world")

GLib.unlink(historyPath)
const missing = loadForNote(notePath, "hello world", now + 4)
check("14 a missing history file reads as no history", missing.status === "none")

// ── the owner guard, read through the real loader ──

const foreign = { ...chain, owner: { instance: "some-other-instance", pid: 1 } }
writeText(historyPath, JSON.stringify(foreign))
const foreignLoad = loadForNote(notePath, "hello world", now + 5)
check("15 another LIVE instance's chain is read-only here", foreignLoad.readOnly === true)
check(
  "16 and is still readable for undo",
  foreignLoad.status === "loaded" && foreignLoad.history.at === 1,
)

const deadOwner = { ...chain, owner: { instance: "some-other-instance", pid: 999_999 } }
writeText(historyPath, JSON.stringify(deadOwner))
check(
  "17 a dead owner's chain is taken over",
  loadForNote(notePath, "hello world", now + 6).readOnly === false,
)

// ── retention ──

for (let i = 0; i < HISTORY_FILE_MAX + 5; i++) {
  const p = GLib.build_filenamev([scratch, `gen-${i}.md`])
  const h = emptyHistory(p, `note ${i}`, 0, currentOwner(), now)
  saveForNote({ ...h, steps: [], at: 0 })
}
const beforePrune = historyFileCount()
pruneHistoryFiles()
const afterPrune = historyFileCount()
check(
  "18 the prune trims to the retention cap",
  afterPrune === HISTORY_FILE_MAX,
  `${beforePrune} → ${afterPrune}`,
)

// ── the invariant: the note's own file is never written by this layer ──

check(
  "19 the note file is byte-identical after every history operation",
  readText(notePath) === NOTE_TEXT,
)
check("20 and its mtime never moved", mtimeOf(notePath) === noteMtimeBefore)

const failed = checks.filter(([, ok]) => !ok).length
console.log(`summary: ${checks.length - failed}/${checks.length} checks passed`)
if (failed > 0) throw new Error(`notes history-store probe failed: ${failed} check(s)`)
