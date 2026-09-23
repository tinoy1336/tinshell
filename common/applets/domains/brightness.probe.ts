/**
 * brightness.probe — the brightness domain's publish rule as a CONSUMER sees it:
 * the first reading the domain publishes, and the placeholder it never publishes.
 *
 * Why it matters: the clock's transient dial measures the user's brightness
 * adjustments against the FIRST reading its lane adopts. A machine sitting at
 * 100 % (a laptop on AC) used to publish nothing at all — its first read landed
 * on the placeholder value and was dropped as "no change" — so the lane took no
 * baseline and adopted the user's first adjustment AS that baseline, never
 * painting it. The other side of the same rule: a process with no backlight
 * device answers 100 % without a reading, and that placeholder must never be
 * published, so a published value keeps meaning "a device was read" — the
 * distinction the volume domain draws with `available`.
 *
 * The rule itself lives in `./brightness-publish`, beside the domain rather than
 * inside it: the domain module's exported surface is the applets backend
 * contract, where every value export becomes a member the transport serves and
 * every host must provide. So it is pinned here twice over — the predicate case
 * by case, and the observable half as a consumer sees it. Both observable
 * assertions are value-independent — they hold on a machine at 100 % exactly as
 * on one at 44 %: a machine WITH a backlight device publishes its first read at
 * the device's own level, and a machine WITHOUT one publishes nothing.
 *
 * Run:
 *   ags bundle --gtk 4 common/applets/domains/brightness.probe.ts /tmp/brightness-probe.sh
 *   bash /tmp/brightness-probe.sh     # exit 1 on any violated invariant
 */
import GLib from "gi://GLib"
import { brightnessState } from "./brightness.ts"
import { publishBrightnessRead } from "./brightness-publish.ts"
import { listDir, readFile } from "./fs"

const failures: string[] = []
const check = (name: string, ok: boolean): void => {
  if (!ok) failures.push(name)
}

/** The level the domain should publish, computed here from sysfs so the check
 *  does not lean on the domain's own read. */
const deviceScreen = (): number => {
  const root = "/sys/class/backlight"
  let screen = 100
  for (const d of listDir(root)) {
    const max = parseInt(readFile(`${root}/${d}/max_brightness`), 10) || 255
    const val = parseInt(readFile(`${root}/${d}/brightness`), 10)
    if (Number.isNaN(val)) continue
    screen = Math.round((val / max) * 100)
  }
  return screen
}

const devices = listDir("/sys/class/backlight")
const expected = deviceScreen()
const state = brightnessState(30000)
const mountPeek = state.peek()
const seen: number[] = []
state.subscribe(() => seen.push(state.peek().screen))

check(
  `the state opens at the placeholder and has published nothing yet (${JSON.stringify(mountPeek)})`,
  mountPeek.screen === 100 && seen.length === 0,
)

// ── The publish rule, case by case ──
// The value-independence the defect turned on: a first read landing on the
// placeholder value still publishes, while the placeholder of a device-less
// process is never published at all.
check(
  "a first read of a machine at 100 % is published (the placeholder is the value, not the reading)",
  publishBrightnessRead(true, true, 100, 100) === true,
)
check(
  "a first read of a machine below 100 % is published",
  publishBrightnessRead(true, true, 100, 44) === true,
)
check(
  "a machine with no backlight device never publishes a reading",
  publishBrightnessRead(true, false, 100, 100) === false,
)
check(
  "a later read at the level the state holds does not publish",
  publishBrightnessRead(false, true, 44, 44) === false,
)
check(
  "a later read at a changed level publishes",
  publishBrightnessRead(false, true, 44, 90) === true,
)
console.log(`backlight devices ${JSON.stringify(devices)}, sysfs level ${expected}%`)
console.log(`mount peek ${JSON.stringify(mountPeek)}`)

const settleMs = 300
GLib.timeout_add(GLib.PRIORITY_DEFAULT, settleMs, () => {
  console.log(`published ${JSON.stringify(seen)} over ${settleMs} ms`)

  if (devices.length === 0) {
    check(
      `a machine with no backlight device publishes nothing (saw ${JSON.stringify(seen)})`,
      seen.length === 0,
    )
  } else {
    check(`the first read is published (saw ${JSON.stringify(seen)})`, seen.length >= 1)
    check(
      `the first published reading is the device's own level (${seen[0]}% vs ${expected}%)`,
      seen[0] === expected,
    )
    check(
      `every published reading tracks the device, so no placeholder was published (saw ${JSON.stringify(seen)})`,
      seen.every((v) => v === expected),
    )
  }

  console.log()
  if (failures.length > 0) {
    console.log(`FAIL — ${failures.length} violated invariant(s):`)
    for (const f of failures) console.log(`  - ${f}`)
    imports.system.exit(1)
  }
  console.log(
    `OK — the brightness domain opens at a placeholder it never publishes, and publishes a first reading at the device's own level${
      devices.length === 0
        ? " (no backlight device in this process: nothing published)"
        : ` (${expected}%)`
    }`,
  )
  imports.system.exit(0)
  return GLib.SOURCE_REMOVE
})

// The domain's reads resolve through the main context.
GLib.MainLoop.new(null, false).run()
