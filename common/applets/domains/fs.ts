import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { bytesToUtf8 } from "@common/fs/bytes"
import { ignore } from "@common/log/logger"

/** Whether this host is served the fs domain at all. The socket policy never
 *  exposes `fs` (common/applets/host/socket-server.ts): it reads and writes files
 *  AS THE OWNER, so a foreign-user host must not have it. An applet that
 *  mutates sysfs gates on this instead of discovering the refusal through a
 *  write that silently did nothing. */
export const available: boolean = true

/** Read a file from sysfs/proc. Returns empty string on failure. */
export function readFile(path: string): string {
  try {
    const [, contents] = GLib.file_get_contents(path)
    if (!contents) return ""
    return bytesToUtf8(contents).trim()
  } catch (_) {
    return ""
  }
}

/** List directory entries. Returns empty array on failure. */
export function listDir(path: string): string[] {
  try {
    const file = Gio.File.new_for_path(path)
    const enumerator = file.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    const names: string[] = []
    let info: Gio.FileInfo | null
    while ((info = enumerator.next_file(null))) {
      names.push(info.get_name())
    }
    return names
  } catch (_) {
    return []
  }
}

// ── Async variants — never block the GTK main loop ──
// All backend I/O should use these. createPoll fns that return the Promise from
// these (or that are themselves `async`) are handled correctly by createPoll,
// which calls `.then(set)` on a returned Promise instead of blocking.

/** Async read of a sysfs/proc file. Resolves "" on any failure. */
export function readFileAsync(path: string): Promise<string> {
  return new Promise((resolve) => {
    const file = Gio.File.new_for_path(path)
    file.load_contents_async(null, (_o: any, res: any) => {
      try {
        const [, contents] = file.load_contents_finish(res)
        resolve(contents ? bytesToUtf8(contents).trim() : "")
      } catch (e) {
        ignore(`read ${path}`, e)
        resolve("")
      }
    })
  })
}

/** Write a file (sysfs control attributes). Tries a DIRECT write first — on
 *  machines where a udev/tmpfiles rule made the attribute user-writable no
 *  privilege escalation is involved at all. On EACCES falls back to the
 *  scoped `sudo -n tee` rule (e.g. `NOPASSWD: /usr/bin/tee <path>` — the
 *  battery-threshold setup; see AGENTS.md). Both failing resolves false and
 *  logs, so a missing permission setup is visible instead of a silent no-op. */
export function writeFileAsync(path: string, contents: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Direct write first (no sudo). GFile.replace_contents_async handles
    // sysfs attributes atomically-ish (write + fsync semantics are fine here).
    const file = Gio.File.new_for_path(path)
    file.replace_contents_async(
      new TextEncoder().encode(contents),
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null,
      (f: any, res: any) => {
        try {
          f.replace_contents_finish(res)
          resolve(true)
          return
        } catch (e: any) {
          // Direct write failed (EACCES without a udev rule, or any other
          // error) — fall back to the scoped sudo tee rule. If that also
          // fails, sudoWrite logs and resolves false.
          if (GLib.getenv("DOCK_DEBUG") === "1")
            print(`[writeFileAsync] direct write failed, falling back to sudo: ${e}`)
          sudoWrite()
        }
      },
    )

    function sudoWrite(): void {
      let proc: Gio.Subprocess
      try {
        proc = Gio.Subprocess.new(
          ["sudo", "-n", "tee", path],
          Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_SILENCE,
        )
      } catch (e) {
        ignore("sysfs sudo write spawn", e)
        resolve(false)
        return
      }
      proc.communicate_async(new TextEncoder().encode(contents), null, (_p: any, res: any) => {
        try {
          proc.communicate_finish(res)
          const ok = proc.get_exit_status() === 0
          if (!ok)
            ignore(
              `sysfs write ${path} (exit ${proc.get_exit_status()}) — is the permission rule set up? (see AGENTS.md)`,
            )
          resolve(ok)
        } catch (e) {
          ignore(`sysfs sudo write ${path}`, e)
          resolve(false)
        }
      })
    }
  })
}

// ── User-owned file I/O (config.json etc.) — not privileged, not sysfs. ──
// Distinct from the sysfs helpers above: these use GFile async APIs directly
// (no `sudo tee`); readUserFileAsync distinguishes "missing/unreadable" from
// "present but empty".

/** Async read of a user-owned file. Resolves { ok, contents }; ok=false when the
 *  file is missing or unreadable (ok=true with empty contents for a present-but-empty file). */
export function readUserFileAsync(path: string): Promise<{ ok: boolean; contents: string }> {
  return new Promise((resolve) => {
    const file = Gio.File.new_for_path(path)
    file.load_contents_async(null, (_o: any, res: any) => {
      try {
        const [, contents] = file.load_contents_finish(res)
        resolve({
          ok: true,
          contents: contents ? bytesToUtf8(contents) : "",
        })
      } catch (e) {
        // A present-but-unreadable file is reported; callers only see ok=false.
        ignore(`read user file ${path}`, e)
        resolve({ ok: false, contents: "" })
      }
    })
  })
}

/** Atomic-ish async write of a user-owned file via replace_contents_async. Resolves success. */
export function writeUserFileAsync(path: string, contents: string): Promise<boolean> {
  return new Promise((resolve) => {
    const file = Gio.File.new_for_path(path)
    const bytes = new TextEncoder().encode(contents)
    // make_backup + etag=null + replace with no etag check.
    file.replace_contents_async(
      bytes as any,
      null, // etag — null = don't check
      false, // make_backup
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null, // cancellable
      (_o: any, res: any) => {
        try {
          file.replace_contents_finish(res)
          resolve(true)
        } catch (e) {
          ignore(`write user file ${path}`, e)
          resolve(false)
        }
      },
    )
  })
}
