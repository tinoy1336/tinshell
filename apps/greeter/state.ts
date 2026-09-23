/**
 * Last-login username persistence.
 *
 * The greeter runs as the `greeter` user pre-login and CANNOT read/write
 * the session user's home — but it owns /etc/greetd/tinshell-greeter/ (install.sh chowns it
 * to greeter:greeter), so a small state file there persists across greeter
 * respawns. A separate file (not a config.json key) survives redeploys:
 * install.sh overwrites config.json with the defaults each time.
 *
 * Preview/harness mode (TINSHELL_GREETER_PREVIEW/HARNESS, run as the session user) writes the
 * deployed path would fail — TINSHELL_GREETER_STATE_FILE overrides it (the harness
 * uses a /tmp file: self-contained, no permission noise, remembers the
 * username within the harness session).
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { bytesToUtf8 } from "@common/fs/bytes"
import { log } from "@common/log/logger"

const STATE_FILE =
  GLib.getenv("TINSHELL_GREETER_STATE_FILE") ?? "/etc/greetd/tinshell-greeter/last-user"

/** The last successfully-attempted username ("" when never logged in). */
export function readLastUser(): string {
  try {
    const [ok, contents] = GLib.file_get_contents(STATE_FILE)
    if (!ok || !contents) return ""
    return bytesToUtf8(contents).trim()
  } catch {
    return ""
  }
}

/** Remember the username the user submitted (survives failed auth — it is
 *  what they typed; fixing a typo is easier than retyping). */
export function writeLastUser(user: string): void {
  if (!user) return
  try {
    const file = Gio.File.new_for_path(STATE_FILE)
    file.replace_contents(
      new TextEncoder().encode(`${user}\n`),
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null,
    )
    log(`[greeter] remembered last user: ${user}`)
  } catch (e: any) {
    log(`[greeter] could not write last-user state: ${e?.message ?? e}`)
  }
}
