/**
 * Non-blocking subprocess runner — the cross-app primitive for shelling out.
 *
 * Uses Gio.Subprocess with async communicate so a slow qalc currency refresh,
 * a hung nmcli SAE connect, or a python3 eval never freezes the GTK main loop.
 * GTK runs a single main loop; any synchronous spawn would stall rendering.
 *
 * Two entry points:
 *   - `run(argv, opts)` → Promise<RunResult>  (Promise API — preferred)
 *   - `runCb(cmd, onDone, timeoutMs)`          (callback API — shell string,
 *        slow-log; the dock's composed-command call sites)
 *
 * Every call can carry a `timeoutMs`: on expiry the subprocess is force-exited
 * and the promise rejects with TimeoutError (callback form: onDone with the
 * sentinel exit -2). A hung external command must never leave a caller
 * awaiting forever.
 *
 * `argv` form (run) passes directly to Gio.Subprocess.new — NO shell, so no
 * quoting footguns. `runCb` uses `bash -c <cmd>` for the dock's composed
 * command strings.
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { debugEnabled, ignore, log } from "@common/log/logger"

export class TimeoutError extends Error {
  constructor(public ms: number) {
    super(`subprocess timed out after ${ms}ms`)
    this.name = "TimeoutError"
  }
}

export interface RunResult {
  /** exit code (0-255). -2 means timed out (force-exited). */
  exit: number
  /** stdout, decoded utf-8. Empty on timeout. */
  stdout: string
  /** stderr, decoded utf-8 (only when captureStderr). */
  stderr: string
}

interface RunOptions {
  /** ms before force-exit; omit for no timeout. */
  timeoutMs?: number
  /** capture stderr instead of silencing it. */
  captureStderr?: boolean
  /** env var name checked for verbose per-cmd timing logs (e.g. "DOCK_DEBUG"). */
  debugVar?: string
}

const SLOW_THRESHOLD_US = 500_000 // 500ms — log as slow

let seq = 0

/**
 * Run a command asynchronously. `argv` is passed as an argv array directly to
 * Gio.Subprocess.new — NO shell, so no quoting footguns. Resolve with the
 * result (exit + stdout). Rejects only on timeout or spawn failure.
 */
export function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let proc: Gio.Subprocess
    try {
      let flags = Gio.SubprocessFlags.STDOUT_PIPE
      if (opts.captureStderr) flags |= Gio.SubprocessFlags.STDERR_PIPE
      else flags |= Gio.SubprocessFlags.STDERR_SILENCE
      proc = Gio.Subprocess.new(argv, flags)
    } catch (e) {
      reject(e)
      return
    }

    let settled = false
    // The timeout is a one-shot: it destroys its own source, so the callback
    // clears the id. Removing a fired source logs GLib-CRITICAL (Source ID …
    // was not found), which every slow child would otherwise emit.
    let timeoutId: number | null = null
    if (opts.timeoutMs)
      timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, opts.timeoutMs, () => {
        timeoutId = null
        try {
          proc.force_exit()
        } catch (e) {
          // The child already exited between the timeout firing and the kill.
          ignore("timeout kill", e)
        }
        // Settle HERE, not from the communicate callback: force_exit() kills the
        // direct child, but a grandchild that inherited the stdout pipe keeps it
        // open (the router's `ags` CLI/unit spawns), so the communicate callback
        // would never fire and the caller would await a dead child forever.
        if (!settled) {
          settled = true
          reject(new TimeoutError(opts.timeoutMs as number))
        }
        return GLib.SOURCE_REMOVE
      })

    const t0 = GLib.get_monotonic_time()
    proc.communicate_utf8_async(null, null, (_p, result) => {
      if (timeoutId !== null) GLib.source_remove(timeoutId)
      if (settled) return
      settled = true
      const elapsed = GLib.get_monotonic_time() - t0
      try {
        const [, stdout, stderr] = proc.communicate_utf8_finish(result)
        const exit = proc.get_exit_status()
        maybeLogTiming(argv.join(" "), elapsed, undefined, opts.debugVar)
        resolve({ exit, stdout: stdout ?? "", stderr: stderr ?? "" })
      } catch (e) {
        log(`subprocess communicate failed: ${(e as Error).message}`)
        resolve({ exit: 1, stdout: "", stderr: "" })
      }
    })
  })
}

/** Spawn a command detached (fire-and-forget). Used for app/browser launches.
 *
 * Launched apps MUST NOT live in the hosting instance's cgroup: spawned via a
 * bare Gio.Subprocess the child joins e.g. app.slice/tinshell-shell.service, so a
 * shell restart (KillMode=control-group) SIGTERM/SIGKILLs it — VS Code
 * half-dies into an "Application is not responding" dialog.
 *
 * Route through `systemd-run --user --scope`: the app runs as a direct child
 * of systemd-run in its OWN scope unit (separate cgroup, survives instance
 * restarts) while still inheriting the CALLER's environment — full Wayland
 * identity and GPU pins, no manager-env drift. Falls back to a bare spawn if
 * systemd-run itself fails to launch.
 */
export function spawnDetached(argv: string[]): void {
  try {
    Gio.Subprocess.new(
      ["systemd-run", "--user", "--scope", "--collect", ...argv],
      Gio.SubprocessFlags.NONE,
    )
  } catch (e) {
    log(`scoped spawn failed, falling back to direct: ${(e as Error).message}`)
    try {
      Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE)
    } catch (e2) {
      log(`spawn failed: ${(e2 as Error).message}`)
    }
  }
}

/**
 * Callback form: run `cmd` via `bash -c`, fire `onDone(stdout, exitStatus)`
 * on completion. Slow-log (>500ms) plus per-cmd debug log when `debugVar` is
 * set. On timeout, onDone fires with exit -2. `runCb(cmd, cb)` is the dock's
 * command runner.
 */
export function runCb(
  cmd: string,
  onDone: (stdout: string, exitStatus: number) => void,
  timeoutMs?: number,
  debugVar = "DOCK_DEBUG",
): void {
  const id = ++seq
  const label = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd
  const verbose = debugEnabled(debugVar)

  try {
    const proc = Gio.Subprocess.new(
      ["bash", "-c", cmd],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    )

    const t0 = GLib.get_monotonic_time()
    let timedOut = false

    proc.communicate_utf8_async(null, null, (_proc, result) => {
      if (timedOut) return // the timeout already resolved the caller
      const elapsed = GLib.get_monotonic_time() - t0
      const [, stdout] = proc.communicate_utf8_finish(result)
      const exitStatus = proc.get_exit_status()
      maybeLogTiming(label, elapsed, id, debugVar)
      onDone(stdout ?? "", exitStatus)
    })

    if (timeoutMs) {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        if (!timedOut) {
          timedOut = true
          try {
            proc.force_exit()
          } catch (e) {
            ignore("timeout kill", e)
          }
          onDone("", -2) // -2 = timed out
        }
        return GLib.SOURCE_REMOVE
      })
    }
  } catch (e) {
    if (verbose) log(`[cmd-err] #${id} ${label}: ${e}`)
    onDone("", 1)
  }
}

function maybeLogTiming(label: string, elapsedUs: number, id?: number, debugVar?: string): void {
  const idTag = id === undefined ? "" : `#${id} `
  if (elapsedUs > SLOW_THRESHOLD_US) {
    log(
      `[slow-cmd] ${idTag}${label}: ${(elapsedUs / 1000).toFixed(0)}ms (blocking equivalent would freeze UI for this long)`,
    )
  } else if (debugVar && debugEnabled(debugVar)) {
    log(`[cmd] ${idTag}${label}: ${(elapsedUs / 1000).toFixed(0)}ms`)
  }
}
