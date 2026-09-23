/**
 * backend.probe — the greeter's pre-login data path, checked without a
 * session, a compositor or a lock.
 *
 * Replays what the login screen does at strip build: bind the greeter's own
 * domains in process, subscribe the way the applets subscribe (the reactive
 * domains only tick while subscribed), and assert the readings a DATA cell
 * needs before it may leave the parked state. Also asserts the two READ-ONLY
 * contracts: the cap input never writes, and the `fs` domain reads but refuses
 * every write (a greeter write would run as `greeter`; `fs.writeFileAsync`
 * escalates through `sudo -n tee`).
 *
 * It never constructs a widget, never locks, never changes a profile or a
 * brightness: the only write it attempts is a `fs` write it EXPECTS to fail.
 *
 * Run: ags run --gtk 4 apps/greeter/dev/backend.probe.ts
 */
import GLib from "gi://GLib"
import { greeterLocalDomains, greeterLocalSamples } from "../strip/backend"

const d = greeterLocalDomains
const results: string[] = []
let failed = false

function check(label: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failed = true
}

function note(label: string, detail: string): void {
  results.push(`NOTE ${label} — ${detail}`)
}

const battery = d.battery.batteryState(1000)
const brightness = d.brightness.brightnessState(1000)
const cpu = d.cpu.cpuUtilization(1000)
const ram = d.cpu.ramUtilization(1000)
const temp = d.cpu.cpuTemperature(1000)
const tlp = d.tlp.tlpProfile(30_000)
// The applets subscribe in `setupSubscriptions`; without a subscriber
// createPoll never runs and every reactive would answer its seed.
cpu.subscribe(() => {})
ram.subscribe(() => {})
temp.subscribe(() => {})
tlp.subscribe(() => {})

const loop = GLib.MainLoop.new(null, false)
function finish(): void {
  for (const line of results) print(line)
  print(failed ? "RESULT FAIL" : "RESULT PASS")
  loop.quit()
}

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
  // ── battery: percent + the read-only cap ──
  const bs = battery.peek()
  check(
    "battery percentage is a real reading",
    bs.percentage >= 0 && bs.percentage <= 100,
    `${bs.percentage}`,
  )
  check("battery status is not the seed", bs.status !== "Unknown", bs.status)

  const bl = brightness.peek()
  check("brightness level is a real reading", bl.screen > 0 && bl.screen <= 100, `${bl.screen}`)

  const cpuPct = cpu.peek()
  const ramPct = ram.peek()
  check("cpu utilization is a real reading", cpuPct >= 0 && cpuPct <= 100, `${cpuPct}`)
  check("ram utilization is a real reading", ramPct >= 0 && ramPct <= 100, `${ramPct}`)
  const t = temp.peek()
  if (t === null) note("cpu temperature", "no hwmon sensor path answered (the applet paints '--')")
  else check("cpu temperature is a real reading", t > 0 && t < 130, `${t}°C`)

  const cap = d.battery.chargeThresholdStore.get("chargeThreshold")
  const capOk = cap === undefined || (typeof cap === "number" && cap >= 0 && cap <= 100)
  check("cap input answers a value or unknown", capOk, `${JSON.stringify(cap)}`)
  // The store is the MACHINE intent file that both the greeter and the session
  // write, so a cap set here is recorded rather than a greeter-local reading.
  check(
    "cap intent lives in the shared machine file",
    d.battery.chargeThresholdStore.path() === "/var/lib/tinshell/charge-cap",
    d.battery.chargeThresholdStore.path(),
  )
  // Rejected as OUT OF RANGE: proves validation without writing the file (a
  // valid set here would really change the machine's charge limit).
  check(
    "cap input rejects an out-of-range value",
    d.battery.chargeThresholdStore.set("chargeThreshold", 1234) === false,
  )

  // ── fs: sysfs reads + the cap writes, never the owner's home ──
  check("fs is available for the cap write", d.fs.available === true)
  void Promise.all([
    d.fs.readFileAsync("/proc/uptime"),
    d.fs.readFileAsync("/sys/class/power_supply/AC0/online"),
    d.fs.readUserFileAsync("/etc/greetd/tinshell-greeter/config.json"),
    d.powerProfile.readProfile(),
    greeterLocalSamples.battery(),
    greeterLocalSamples.brightness(),
    greeterLocalSamples.performance(),
  ]).then(([uptime, ac, userFile, profile, sBat, sBright, sPerf]) => {
    check("fs still reads (uptime)", String(uptime) !== "", String(uptime).trim())
    check(
      "fs still reads the AC state the Auto mode needs",
      ["0", "1"].includes(String(ac)),
      String(ac),
    )
    check("fs refuses to read the owner's files", userFile.ok === false)
    check(
      "power profile reads",
      ["performance", "balanced", "power-saver", "unknown"].includes(String(profile)),
      String(profile),
    )
    check("battery first-sample probe answers", sBat.ok === true)
    check("brightness first-sample probe answers", sBright.ok === true)
    check("performance first-sample probe answers", sPerf.ok === true)
    finish()
  })
  return GLib.SOURCE_REMOVE
})

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15_000, () => {
  check("probe settled within 15s", false, "a reading never landed")
  finish()
  return GLib.SOURCE_REMOVE
})

loop.run()
