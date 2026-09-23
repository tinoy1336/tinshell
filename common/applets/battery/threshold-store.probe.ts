/**
 * threshold-store.probe — the charge-threshold store contract as the LOCK
 * SCREEN reaches it: the applets backend over its unix socket (the socket
 * policy never exposes the `fs` domain) with the store read served by a
 * background fetch. Asserts:
 *   (a) `fs.available` is false and the fs members answer their placeholders
 *       locally — a socket client cannot read the sysfs threshold at all;
 *   (b) a store read that has not been answered yet is `ready() === false` and
 *       `get() === undefined` — UNKNOWN, not "no value configured";
 *   (c) the machine-level charge-cap intent file (`/var/lib/tinshell/charge-cap`,
 *       the file the store actually reads and writes) is byte-identical
 *       (content + mtime) afterwards: a runtime read never writes the user's
 *       value back;
 *   (d) the socket policy still refuses `fs` for any caller that ignores (a).
 *
 * It never constructs a widget, never locks, never changes the threshold: the
 * only write it attempts is a threshold write through the DENIED fs domain, on
 * purpose.
 *
 * Run: ags run --gtk 4 common/applets/battery/threshold-store.probe.ts
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createAppletBackendClient } from "@common/applets/backend-client"
import { createSocketBackendTransport } from "@common/applets/backend-socket-client"
import { CHARGE_CAP_FILE } from "@common/applets/store-paths"
import { ignore } from "@common/log/logger"

const SYSFS = "/sys/class/power_supply/BAT0/charge_control_end_threshold"
/** The store's durable file, resolved through the ONE owner of the store→file
 *  mapping: the charge-cap intent is MACHINE-level, so the pre-login greeter
 *  (another user) can read and write the same limit the session set. */
const CAP_FILE = CHARGE_CAP_FILE
const KEY = "chargeThreshold" as const

const results: string[] = []
let failed = false

function check(label: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failed = true
}

function snapshot(path: string): string {
  try {
    const info = Gio.File.new_for_path(path).query_info(
      "time::modified,time::modified-usec,standard::size",
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

/** Wait for `pred()` to turn true, pumping the main loop (max `ms`). */
function until(pred: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms
    const tick = (): boolean => {
      if (pred()) {
        resolve(true)
        return GLib.SOURCE_REMOVE
      }
      if (Date.now() > deadline) {
        resolve(false)
        return GLib.SOURCE_REMOVE
      }
      return GLib.SOURCE_CONTINUE
    }
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, tick)
  })
}

async function main(): Promise<void> {
  const before = snapshot(CAP_FILE)
  console.log(`[probe] charge-cap before: ${before}`)

  const transport = createSocketBackendTransport()
  const backend = createAppletBackendClient({ transport, storeRead: "transport" })

  // (a) the capability boundary: a socket client is not served the fs domain,
  // and its members answer the placeholders WITHOUT firing a refused request.
  check("fs.available is false for a socket client", backend.fs.available === false)
  const rawRead = await backend.fs.readFileAsync(SYSFS)
  const rawWrite = await backend.fs.writeFileAsync(SYSFS, "100")
  check(
    "fs.readFileAsync answers the placeholder",
    rawRead === "",
    `got ${JSON.stringify(rawRead)}`,
  )
  check("fs.writeFileAsync answers the placeholder", rawWrite === false)

  // (b) an unanswered store read is unknown, not unset.
  const store = backend.battery.chargeThresholdStore
  const first = store.get(KEY)
  const readyFirst = store.ready(KEY)
  check("first get() is undefined (memo miss)", first === undefined, `got ${JSON.stringify(first)}`)
  check("first ready() is false (not answered yet)", readyFirst === false)

  // ...and once the backend answers, the SAME key reads the durable value.
  const answered = await until(() => store.ready(KEY), 4000)
  const value = store.get(KEY)
  check("ready() turns true once the backend answers", answered)
  check(
    "get() then reads the durable value",
    typeof value === "number",
    `got ${JSON.stringify(value)}`,
  )

  // (c) nothing above wrote the durable file.
  const after = snapshot(CAP_FILE)
  console.log(`[probe] charge-cap after:  ${after}`)
  check("charge-cap file untouched by the reads", before === after, `${before} vs ${after}`)

  // (d) the socket policy still refuses fs outright (defence in depth: the
  // capability flag is not the only barrier).
  const policyProbe = await transport.invoke("fs", "readFileAsync", [SYSFS])
  const denied = policyProbe.ok === false && policyProbe.error.kind === "denied"
  check("socket policy still refuses the fs domain", denied, JSON.stringify(policyProbe))
}

// The script owns its main loop: without one, the pending transport connect and
// the refresh timer never run and the process exits before any assertion.
const loop = GLib.MainLoop.new(null, false)
void (async () => {
  await main()
})()
  .catch((e) => {
    failed = true
    results.push(`FAIL probe crashed: ${String(e)}`)
  })
  .finally(() => {
    console.log(results.join("\n"))
    console.log(failed ? "[probe] RESULT: FAIL" : "[probe] RESULT: PASS")
    loop.quit()
  })
loop.run()
imports.system.exit(failed ? 1 : 0)
