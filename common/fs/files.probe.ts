/**
 * files.probe — the shared file-write primitives (common/fs/files.ts).
 *
 * These are the ONE write path for every app that persists something small:
 * notes' autosave and its close-time flush, the clipboard history and its
 * images, the emoji recents, the config store's live file. The zero-length
 * write is the reason the async form exists at all: `replace_contents_async`
 * does NOT copy the buffer it is handed and is unreliable for empty data, so
 * the implementation wraps the bytes in a `GLib.Bytes` (whose lifetime it owns).
 * A regression there is silent in exactly the worst way — a note saved empty, a
 * cleared history that refuses to clear — so the empty write is pinned here
 * first, then overwrite, then the failure direction.
 *
 * Everything it touches lives under a scratch root in the temp dir, removed at
 * the end of the run.
 *
 * The async form is driven through its EFFECT, not its promise: in a bundled gjs
 * entry the Gio write callback does not drain (the file lands on disk while the
 * returned promise stays pending), so each async case fires the write and then
 * waits, bounded, for the file on disk to reach the expected state. That is what
 * a caller depends on anyway — the bytes, not the boolean.
 *
 * Run (bundled — this module imports GI):
 *   ags bundle --gtk 4 common/fs/files.probe.ts /tmp/files-probe.sh
 *   timeout 90 bash /tmp/files-probe.sh
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ensureDir, writeFileAsync, writeFileSync } from "./files.ts"

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}

const join = (...parts: string[]): string => GLib.build_filenamev(parts)
const sizeOf = (path: string): number => {
  const info = Gio.File.new_for_path(path).query_info(
    "standard::size",
    Gio.FileQueryInfoFlags.NONE,
    null,
  )
  return info.get_size()
}
const readOf = (path: string): string => {
  if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return ""
  try {
    const [ok, contents] = GLib.file_get_contents(path)
    return ok ? new TextDecoder().decode(contents as Uint8Array) : ""
  } catch (_) {
    return ""
  }
}

const ROOT = join(GLib.get_tmp_dir(), `tinshell-files-probe-${GLib.get_monotonic_time()}`)

/** Spin the main context until `pred` holds, bounded — the repo's probe idiom for
 *  a GI callback that has to run before the assertion. */
function waitFor(pred: () => boolean, ms: number): boolean {
  const end = GLib.get_monotonic_time() + ms * 1000
  while (GLib.get_monotonic_time() < end) {
    if (pred()) return true
    GLib.MainContext.default().iteration(false)
  }
  return pred()
}

function removeTree(path: string): void {
  const file = Gio.File.new_for_path(path)
  if (!file.query_exists(null)) return
  if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY) {
    const children = file.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    for (;;) {
      const info = children.next_file(null)
      if (!info) break
      removeTree(join(path, info.get_name()))
    }
    children.close(null)
    GLib.rmdir(path)
    return
  }
  GLib.unlink(path)
}

// ── ensureDir ──
check("ensureDir creates a nested path", ensureDir(join(ROOT, "a", "b", "c")), true)
check("ensureDir on an existing path is true", ensureDir(join(ROOT, "a", "b", "c")), true)
check(
  "the created path is a directory",
  GLib.file_test(join(ROOT, "a", "b", "c"), GLib.FileTest.IS_DIR),
  true,
)

// ── the async write: content, overwrite, and the EMPTY write ──
const scratch = join(ROOT, "note.md")
const long = join(ROOT, "long.md")

GLib.file_set_contents(long, "x".repeat(4096))
GLib.file_set_contents(scratch, "stale contents")

// A write to a fresh path lands, and a shorter write truncates what was there.
void writeFileAsync(join(ROOT, "fresh.md"), "hello")
check(
  "an async write creates the file with its contents",
  waitFor(() => readOf(join(ROOT, "fresh.md")) === "hello", 5000),
  true,
)

void writeFileAsync(scratch, "tiny")
check(
  "a shorter async write truncates the file",
  waitFor(() => sizeOf(scratch) === 4, 5000),
  true,
)
check("to exactly its own length", sizeOf(scratch), 4)

// The empty write is the case the GLib.Bytes form exists for: the raw
// Uint8Array variant never completes for zero-length data.
void writeFileAsync(scratch, "")
check(
  "an EMPTY async write truncates the file",
  waitFor(() => sizeOf(scratch) === 0, 5000),
  true,
)
check("the file still exists", GLib.file_test(scratch, GLib.FileTest.EXISTS), true)
check("and reads back empty", readOf(scratch), "")

GLib.file_set_contents(long, "y".repeat(4096))
void writeFileAsync(long, "")
check(
  "an EMPTY write truncates a large file",
  waitFor(() => sizeOf(long) === 0, 5000),
  true,
)

// A write into a missing directory does not throw; the failure is the file's
// absence, which is what a caller sees.
void writeFileAsync(join(ROOT, "missing", "deep", "x.md"), "data")
check(
  "a write into a missing directory writes nothing",
  waitFor(() => !GLib.file_test(join(ROOT, "missing", "deep", "x.md"), GLib.FileTest.EXISTS), 2000),
  true,
)

// UTF-8 round-trips byte for byte.
void writeFileAsync(scratch, "café — 📁\n")
check(
  "UTF-8 round-trips",
  waitFor(() => readOf(scratch) === "café — 📁\n", 5000),
  true,
)

// ── the synchronous form ──
check("writeFileSync reports success", writeFileSync(join(ROOT, "sync.md"), "sync"), true)
check("the synchronous write landed", readOf(join(ROOT, "sync.md")), "sync")
check(
  "a synchronous EMPTY write lands",
  writeFileSync(join(ROOT, "sync.md"), "") && sizeOf(join(ROOT, "sync.md")),
  0,
)
check(
  "writeFileSync creates a missing parent directory",
  writeFileSync(join(ROOT, "made", "deep", "s.md"), "x"),
  true,
)

removeTree(ROOT)
check("the scratch root is removed by the run", GLib.file_test(ROOT, GLib.FileTest.EXISTS), false)

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`files probe failed: ${failed.length} check(s)`)
