/**
 * plugged-since-store.probe — the fully-charged counter's start time, as the
 * applet reaches it on the SESSION side.
 *
 * The stamp is MACHINE-level (`/var/lib/tinshell/plugged-since`) because the pre-login
 * greeter paints the same counter the session's battery applet paints, and the
 * greeter cannot read the session user's state dir. Both sides therefore depend
 * on one contract, which this probe asserts without a session, a compositor or a
 * lock:
 *   (a) the store the applet reads — the battery domain's `pluggedSinceStore`,
 *       i.e. exactly what `backend.battery.pluggedSinceStore` is on a host that
 *       binds the domain (the dock, the greeter's strip) — resolves to that file,
 *       and the file→store mapping in `store-paths.ts` agrees, so a client that
 *       reads the file itself cannot disagree with the domain;
 *   (b) it answers a real stamp, and a READ never writes the file (content +
 *       mtime identical afterwards);
 *   (c) the file carries for OTHER accounts exactly the read bit — world-readable
 *       and never group/other-writable. That is the whole permission the greeter
 *       needs; the write path is the session user's scoped `sudo -n tee` rule
 *       (setup.sh, /etc/sudoers.d/tinshell-battery).
 *
 * It never writes the stamp: a valid set would move the count this machine is
 * running. The greeter-side read and its write refusal are proven per-user
 * (`runuser -u greeter …`), not from here.
 *
 * Run: ags run --gtk 4 common/applets/battery/plugged-since-store.probe.ts
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { chargeThresholdStore, pluggedSinceStore } from "@common/applets/domains/battery"
import { formatElapsed } from "@common/applets/shared/elapsed"
import { CHARGE_CAP_FILE, PLUGGED_SINCE_FILE, storeFilePath } from "@common/applets/store-paths"
import { ignore } from "@common/log/logger"

const KEY = "pluggedSince" as const

const results: string[] = []
let failed = false

function check(label: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failed = true
}

function note(label: string, detail: string): void {
  results.push(`NOTE ${label} — ${detail}`)
}

/** mtime + content, so a write cannot hide behind an equal value. */
function snapshot(path: string): string {
  try {
    const info = Gio.File.new_for_path(path).query_info(
      "time::modified,time::modified-usec",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    const mtime = `${info.get_attribute_uint64("time::modified")}.${info.get_attribute_uint32("time::modified-usec")}`
    const [ok, bytes] = GLib.file_get_contents(path)
    const body = ok && bytes ? new TextDecoder().decode(bytes) : "<unreadable>"
    return `${mtime} ${body.trim()}`
  } catch (e) {
    ignore(`probe snapshot ${path}`, e)
    return "<missing>"
  }
}

/** The file's permission bits, or null when it cannot be stat'd. */
function perms(path: string): number | null {
  try {
    return (
      Gio.File.new_for_path(path)
        .query_info("unix::mode", Gio.FileQueryInfoFlags.NONE, null)
        .get_attribute_uint32("unix::mode") & 0o777
    )
  } catch (e) {
    ignore(`probe perms ${path}`, e)
    return null
  }
}

const before = snapshot(PLUGGED_SINCE_FILE)

// (a) the store the applet calls IS the machine file, on both resolution paths.
check(
  "the applet's counter store resolves to the machine file",
  pluggedSinceStore.path() === PLUGGED_SINCE_FILE,
  pluggedSinceStore.path(),
)
check(
  "the store→file mapping agrees with the domain",
  storeFilePath("battery", "pluggedSinceStore") === PLUGGED_SINCE_FILE,
  storeFilePath("battery", "pluggedSinceStore"),
)

// (b) the value the counter would resume from.
const since = pluggedSinceStore.get(KEY)
check(
  "the stamp reads as an epoch-seconds number",
  typeof since === "number" && Number.isFinite(since) && since >= 0,
  JSON.stringify(since),
)
if (typeof since === "number" && since > 0) {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - since)
  note(
    "count running since",
    `${since} (${new Date(since * 1000).toISOString()}) — the glyph paints ${formatElapsed(elapsed)}`,
  )
} else {
  note("count", "no start on record (0) — nothing is painted until the pack is observed idle")
}

check(
  "the store rejects a value that is not a stamp (no write attempted)",
  pluggedSinceStore.set(KEY, Number.NaN) === false,
)

// The same factory backs the charge cap, so a regression there would be a
// regression in the counter's store too: the cap store must still resolve its own
// file and answer its own key.
check(
  "the charge-cap store still resolves its MACHINE file",
  chargeThresholdStore.path() === CHARGE_CAP_FILE,
  chargeThresholdStore.path(),
)
check(
  "the charge-cap store still answers its key",
  storeFilePath("battery", "chargeThresholdStore") === CHARGE_CAP_FILE &&
    (chargeThresholdStore.get("chargeThreshold") === undefined ||
      typeof chargeThresholdStore.get("chargeThreshold") === "number"),
  JSON.stringify(chargeThresholdStore.get("chargeThreshold")),
)
// The two machine files must never be the same file: one counter, one cap.
check(
  "the two machine stores are distinct files",
  String(CHARGE_CAP_FILE) !== String(PLUGGED_SINCE_FILE),
)

// (c) the permission the greeter relies on.
const mode = perms(PLUGGED_SINCE_FILE)
const shown = mode === null ? "missing" : mode.toString(8)
check("the machine file exists", mode !== null, PLUGGED_SINCE_FILE)
check("the file is world-readable", mode !== null && (mode & 0o004) !== 0, `mode ${shown}`)
check(
  "the file is never group/other-writable",
  mode !== null && (mode & 0o022) === 0,
  `mode ${shown}`,
)

check("a read never writes the stamp", before === snapshot(PLUGGED_SINCE_FILE), before)

for (const line of results) print(line)
print(failed ? "RESULT FAIL" : "RESULT PASS")
imports.system.exit(failed ? 1 : 0)
