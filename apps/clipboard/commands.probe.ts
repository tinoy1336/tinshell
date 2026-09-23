/**
 * commands.probe — the clipboard REQUEST CONTRACT, exercised headless.
 *
 * Why it exists: the request surface is what other tooling reads, and its
 * shape is a safety property, not a convenience — a listing that answers entry
 * CONTENT hands every caller the payloads of every entry, which is how a live
 * access token ended up in a transcript. This probe pins the contract:
 *
 *  - a listing path (`history`, `entry <id>`, `debug`) answers METADATA only —
 *    timestamp, id, mime, payload byte size and the pinned flag — and the
 *    fixture payload text appears in no reply of any of them,
 *  - `entry <id> --reveal` is the ONE way to a payload: it answers exactly the
 *    named entry's content and none of another entry's,
 *  - a token a path does not define (`history --reveal`, `entry <id> --nope`,
 *    an extra argument after the id, an argument to a flag-free path) is
 *    answered with that path's usage line instead of being ignored,
 *  - an unknown subcommand is refused by the dispatcher, not silently treated
 *    as a listing,
 *  - `debug` carries counts and capture-loop state, never entry content.
 *
 * NO REAL HISTORY IS READ OR WRITTEN. The store paths are fixed at import from
 * the XDG data dir, so the probe REFUSES to run unless `XDG_DATA_HOME` names a
 * temp directory, and writes its fixture entries there through the store's own
 * `append()`. The payloads are fixtures generated here — never a value read
 * from the machine.
 *
 * Run (exit 1 on any violated invariant; the temp dir is the harness's to
 * remove):
 *   ags bundle --gtk 4 apps/clipboard/commands.probe.ts /tmp/commands-probe.sh
 *   XDG_DATA_HOME=$(mktemp -d) bash /tmp/commands-probe.sh
 */
import GLib from "gi://GLib"
import { dispatch } from "@common/commands/registry"
import "./commands"
import {
  append,
  contentHash,
  imagePath,
  newId,
  payloadSize,
  pinned,
  saveImage,
  storageDir,
  togglePin,
} from "./store"

const REAL_STORE = GLib.build_filenamev([GLib.get_home_dir(), ".local", "share", "clipboard"])
const dataHome = GLib.getenv("XDG_DATA_HOME") ?? ""
if (!dataHome) {
  throw new Error(
    "commands probe refuses to run without XDG_DATA_HOME — it writes fixture " +
      "entries and must never touch the real clipboard history",
  )
}
if (storageDir() === REAL_STORE) {
  throw new Error(`commands probe refuses to write into the real store '${REAL_STORE}'`)
}
if (!storageDir().startsWith(dataHome)) {
  throw new Error(`store dir '${storageDir()}' is not under XDG_DATA_HOME '${dataHome}'`)
}

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

/** The reply a request path answers, synchronously (every handler here is). */
function reply(request: string): string {
  let out = ""
  dispatch(
    request.split(" ").filter((t) => t.length > 0),
    (r) => {
      out = r
    },
  )
  return out
}

// ── fixtures (payloads generated here; nothing is read from the machine) ──
const FIXTURE_A = "FIXTURE-ONLY-payload-alpha-7c1d92"
const FIXTURE_B = "FIXTURE-ONLY-payload-bravo-4e80af"
const idA = newId()
const idB = newId()
append({ id: idA, ts: Date.now(), mime: "text", text: FIXTURE_A, hash: contentHash(FIXTURE_A) })
append({ id: idB, ts: Date.now(), mime: "text", text: FIXTURE_B, hash: contentHash(FIXTURE_B) })

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])
const idImg = newId()
saveImage(idImg, PNG)
append({ id: idImg, ts: Date.now(), mime: "image", imagePath: `img/${idImg}.png` })

// ── a listing answers metadata and no payload ──
const history = reply("clipboard history 50")
const lines = history.split("\n")
check("history lists every fixture entry", lines.length, 3)
check(
  "history carries no fixture payload",
  history.includes(FIXTURE_A) || history.includes(FIXTURE_B),
  false,
)
const lineA = lines.find((l) => l.includes(idA)) ?? ""
const colsA = lineA.split(" ")
check("a metadata line names the id", colsA[1], idA)
check("a metadata line names the mime", colsA[2], "text")
check("a metadata line carries the payload byte size", colsA[3], String(FIXTURE_A.length))
check("a metadata line carries the pinned flag", colsA[4], "false")
check("a metadata line starts with the ISO timestamp", Number.isNaN(Date.parse(colsA[0])), false)
check(
  "an image line carries its blob size",
  lines.find((l) => l.includes(idImg))?.split(" ")[3],
  String(PNG.length),
)

// ── the pinned flag is per entry ──
togglePin(idA)
const pinnedHistory = reply("clipboard history 50")
check(
  "a pinned entry reports pinned",
  pinnedHistory
    .split("\n")
    .find((l) => l.includes(idA))
    ?.endsWith("true"),
  true,
)
check(
  "an unpinned entry still reports unpinned",
  pinnedHistory
    .split("\n")
    .find((l) => l.includes(idB))
    ?.endsWith("false"),
  true,
)
check("pinning wrote through the store's own pin set", pinned().has(idA), true)

// ── one entry, inspected by name: still metadata ──
const entryA = reply(`clipboard entry ${idA}`)
check("entry <id> is one line", entryA.includes("\n"), false)
check("entry <id> carries no payload", entryA.includes(FIXTURE_A), false)
check("entry <id> is the same metadata shape", entryA.split(" ")[1], idA)
check("entry <id> reports the pinned flag", entryA.split(" ")[4], "true")

// ── the ONE payload path ──
check(
  "entry <id> --reveal answers exactly that entry",
  reply(`clipboard entry ${idA} --reveal`),
  FIXTURE_A,
)
const revealedB = reply(`clipboard entry ${idB} --reveal`)
check("revealing one entry answers it", revealedB, FIXTURE_B)
check("revealing one entry does not answer another", revealedB.includes(FIXTURE_A), false)
check(
  "revealing an image answers its absolute PNG path",
  reply(`clipboard entry ${idImg} --reveal`),
  imagePath(idImg),
)
check(
  "an image reveal never prints the bytes",
  reply(`clipboard entry ${idImg} --reveal`).includes("\u0089"),
  false,
)

// ── an undeclared token is refused, never ignored ──
check(
  "history refuses a reveal flag",
  reply("clipboard history --reveal"),
  "error: usage: clipboard history [<limit>]",
)
check(
  "history refuses a non-numeric limit",
  reply("clipboard history all"),
  "error: usage: clipboard history [<limit>]",
)
check(
  "history refuses a zero limit",
  reply("clipboard history 0"),
  "error: usage: clipboard history [<limit>]",
)
check(
  "history refuses a second argument",
  reply("clipboard history 5 6"),
  "error: usage: clipboard history [<limit>]",
)
check(
  "entry refuses an unknown flag",
  reply(`clipboard entry ${idA} --nope`),
  "error: usage: clipboard entry <id> [--reveal]",
)
check(
  "entry refuses a trailing argument",
  reply(`clipboard entry ${idA} --reveal extra`),
  "error: usage: clipboard entry <id> [--reveal]",
)
check(
  "entry refuses a missing id",
  reply("clipboard entry"),
  "error: usage: clipboard entry <id> [--reveal]",
)
check(
  "entry reports an unknown id",
  reply("clipboard entry no-such-id"),
  "error: no such entry: no-such-id",
)
check(
  "entry reveals no unknown id",
  reply("clipboard entry no-such-id --reveal"),
  "error: no such entry: no-such-id",
)
check(
  "delete refuses an extra argument",
  reply(`clipboard delete ${idB} --all`),
  "error: usage: clipboard delete <id>",
)
check(
  "pin refuses an extra argument",
  reply(`clipboard pin ${idB} --force`),
  "error: usage: clipboard pin <id>",
)
check(
  "unpin refuses an extra argument",
  reply(`clipboard unpin ${idB} --reveal`),
  "error: usage: clipboard unpin <id>",
)
check("clear refuses an argument", reply("clipboard clear --all"), "error: usage: clipboard clear")
check("toggle refuses an argument", reply("clipboard toggle now"), "error: usage: clipboard toggle")
check(
  "debug refuses an argument",
  reply("clipboard debug --reveal"),
  "error: usage: clipboard debug",
)
check("a refused pin did not pin", pinned().has(idB), false)
check("a refused delete removed nothing", reply("clipboard history 50").includes(idB), true)

// ── an unknown subcommand is loud ──
const unknownSub = reply("clipboard nonsense")
check(
  "an unknown subcommand answers an error",
  unknownSub.startsWith("error: unknown command"),
  true,
)
check("an unknown subcommand leaks no payload", unknownSub.includes(FIXTURE_A), false)

// ── debug is metadata, and stays metadata ──
const debug = reply("clipboard debug")
check(
  "debug leaks no fixture payload",
  debug.includes(FIXTURE_A) || debug.includes(FIXTURE_B),
  false,
)
check("debug leaks no image path", debug.includes(idImg), false)
let parsed: Record<string, unknown> = {}
try {
  parsed = JSON.parse(debug) as Record<string, unknown>
} catch (e) {
  check(`debug answers JSON (${String(e)})`, debug, "JSON object")
}
check("debug counts the entries", parsed.entries, 3)
check("debug counts the pins", parsed.pinned, 1)

// ── the size the surface reports is the store's own measurement ──
check(
  "payloadSize measures a text payload in UTF-8 bytes",
  payloadSize({ id: "x", ts: 0, mime: "text", text: FIXTURE_A }),
  FIXTURE_A.length,
)
check(
  "payloadSize measures an image payload from its blob",
  payloadSize({ id: idImg, ts: 0, mime: "image", imagePath: `img/${idImg}.png` }),
  PNG.length,
)
check(
  "payloadSize of a missing blob is zero, not an error",
  payloadSize({ id: "gone", ts: 0, mime: "image", imagePath: "img/gone.png" }),
  0,
)

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`fixture store: ${storageDir()}`)
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`commands probe failed: ${failed.length} check(s)`)
