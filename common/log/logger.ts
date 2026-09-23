/**
 * Pluggable logger — the cross-app logging primitive.
 *
 * Why pluggable: apps run under different process trees and their log output
 * needs different sinks to survive.
 *   - The dock is WM-autostarted; its stdout is typically lost, so it writes
 *     to a file sink (/tmp/tinshell-debug.log).
 *   - The launcher runs under systemd; stderr is captured by `journalctl`, so
 *     it uses the stderr sink.
 * Both sinks ship here; each app picks at init via `setSink`.
 *
 * `log(msg)` is the always-available entry point (default sink = stderr). An
 * app calls `setSink(...)` once at startup to switch. `logTo(path, msg)` is the
 * per-path variant for high-volume per-frame diagnostics that need their own
 * file (used by the dock's geo-log).
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"

type Sink = (line: string) => void

let prefix = ""
let sink: Sink = stderrSink

/** Default sink: stderr. Captured by journald under systemd; visible on a tty. */
function stderrSink(line: string): void {
  printerr(line)
}

/** Open a file for appending, creating it on first use. Appends win over
 *  replaces (log history is kept); the replace fallback covers append-only
 *  filesystems. null on failure. Backs the file sink (default
 *  /tmp/tinshell-debug.log), which survives WM autostart where stdout is lost —
 *  best-effort, silently drops on failure. */
function openAppendStream(path: string): Gio.FileOutputStream | null {
  try {
    const file = Gio.File.new_for_path(path)
    try {
      return file.append_to(Gio.FileCreateFlags.NONE, null)
    } catch (_) {
      return file.replace(null, false, Gio.FileCreateFlags.NONE, null)
    }
  } catch (_) {
    // No log() here: this is the logger's own file open, so reporting through
    // the sink would recurse into the same failing path.
    return null
  }
}

export function fileSink(path = "/tmp/tinshell-debug.log"): Sink {
  let stream: Gio.FileOutputStream | null = null
  const ensure = (): Gio.FileOutputStream | null => {
    if (stream) return stream
    stream = openAppendStream(path)
    return stream
  }
  // Serialized write chain. GOutputStream allows ONE outstanding async write
  // per stream — fire-and-forget bursts silently drop every line but the
  // first ("Stream has outstanding operation"). The next
  // line is written in the previous write's finish callback.
  const queue: string[] = []
  let writing = false
  const pump = (): void => {
    if (writing || queue.length === 0) return
    const s = stream
    if (!s) return
    writing = true
    const line = queue.shift()!
    try {
      // (1) io_priority must be GLib.PRIORITY_DEFAULT, not null (gjs rejects
      // null → silent 0-byte files on dock AND notes); (2) the buffer must be
      // wrapped in GLib.Bytes — write_async on a raw Uint8Array misreads the
      // view length and writes pool garbage.
      const bytes = new GLib.Bytes(new TextEncoder().encode(`${line}\n`))
      ;(s as any).write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null, () => {
        writing = false
        pump()
      })
    } catch (e) {
      // Same recursion constraint as openAppendStream: report on stderr only.
      printerr(`log write failed: ${e}`)
      writing = false
      pump()
    }
  }
  return (line: string) => {
    if (!ensure()) return
    queue.push(line)
    pump()
  }
}

/** Choose the sink. Optional `prefix` is prepended to every line (e.g. "[dock]"). */
export function setSink(next: Sink, tag = ""): void {
  sink = next
  prefix = tag
}

/** Log a diagnostic line through the active sink. */
export function log(msg: string): void {
  const line = prefix ? `${prefix} ${msg}` : msg
  sink(line)
}

/** Deliberate-ignore channel: a caught failure the caller has decided to
 *  continue past is still reported through the active sink, so an ignored
 *  failure stays observable instead of vanishing. `what` names the operation
 *  that failed. Use this instead of an empty catch body. */
export function ignore(what: string, e?: unknown): void {
  log(`ignored (${what}): ${e === undefined ? "no detail" : e}`)
}

// ── Per-path logger (for high-volume per-frame logs that need their own file) ──

const pathStreams: Map<string, Gio.FileOutputStream> = new Map()
const pathQueues: Map<string, string[]> = new Map()
const pathWriting: Map<string, boolean> = new Map()

function pumpPath(path: string): void {
  if (pathWriting.get(path)) return
  const s = pathStreams.get(path)
  const q = pathQueues.get(path)
  if (!s || !q || q.length === 0) return
  pathWriting.set(path, true)
  const line = q.shift()!
  try {
    // Same rule as fileSink's pump: io_priority must be GLib.PRIORITY_DEFAULT
    // (null → silent 0-byte files) and the buffer must be wrapped in
    // GLib.Bytes — write_async on a raw string misreads the length.
    const bytes = new GLib.Bytes(new TextEncoder().encode(`${line}\n`))
    ;(s as any).write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null, () => {
      pathWriting.set(path, false)
      pumpPath(path)
    })
  } catch (e) {
    printerr(`logTo write failed for ${path}: ${e}`)
    pathWriting.set(path, false)
    pumpPath(path)
  }
}

/** Append a line to an arbitrary file path. Opens (creates if needed) on first
 *  use and caches the stream. Best-effort — silently drops on failure.
 *  Serialized per path (same one-outstanding-write rule as fileSink). */
export function logTo(path: string, line: string): void {
  let s = pathStreams.get(path)
  if (!s) {
    const opened = openAppendStream(path)
    if (!opened) return
    s = opened
    pathStreams.set(path, s)
  }
  let q = pathQueues.get(path)
  if (!q) {
    q = []
    pathQueues.set(path, q)
  }
  q.push(line)
  pumpPath(path)
}

/** Whether a DEBUG env var is set (per-app convention: <APP>_DEBUG=1). */
export function debugEnabled(envVar: string): boolean {
  return GLib.getenv(envVar) === "1"
}

// ── Tagged logger (one per app: the tag is fixed for the whole process) ──

/** A logger bound to a fixed `[tag]`; `logTo` stays the untagged per-path writer. */
interface TaggedLogger {
  log(msg: string): void
  ignore(what: string, e?: unknown): void
  logTo(path: string, line: string): void
}

/** Build a logger whose lines carry `tag` (e.g. "[launcher]"). The SINK stays
 *  process-global — the tag identifies the app inside the shared stream, it
 *  never touches the sink. */
export function createLogger(tag: string): TaggedLogger {
  return {
    log: (msg: string) => log(`${tag} ${msg}`),
    ignore: (what: string, e?: unknown) => ignore(`${tag} ${what}`, e),
    logTo,
  }
}
