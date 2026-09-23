/**
 * low-warning.probe — the low-battery warning latch's crossing rule
 * (common/applets/battery/low-warning.ts) under plain Node.
 *
 * No gi, no GTK, no notification, no state file: the latch is pure, so the probe
 * drives it with readings, a mutable flag that stands in for the durable store
 * (the sink writes it back on every transition, exactly as the applet does) and a
 * counting sink. It asserts that a descent warns EXACTLY once, that charging
 * neither warns nor consumes the latch, that a reading above the threshold
 * re-arms it, that an already-warned flag survives a restart without repeating
 * (and without swallowing) a crossing, that a reading AT the threshold counts as
 * below it, that the LEVEL is re-read at decision time (a live config tier), that
 * a SECOND mount reading the shared flag does not warn again, and that no read of
 * either input can ever arm the latch.
 *
 * Run:  node --experimental-strip-types common/applets/battery/low-warning.probe.ts
 */
import {
  createLowWarningLatch,
  type LowWarningAction,
  type LowWarningReading,
  lowWarningStep,
} from "./low-warning.ts"

const results: string[] = []
let failed = false

function check(label: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failed = true
}

/** A reading as the battery domain would deliver it. */
function r(percentage: number, status = "Discharging"): LowWarningReading {
  return { percentage, status }
}

/** The durable flag as the mounts see it: a mutable box plus the read the latch
 *  performs at decision time. More than one mount can hold the same box. */
function flag(initial: boolean): { box: { value: boolean }; read: () => boolean } {
  const box = { value: initial }
  return { box, read: () => box.value }
}

type Flag = ReturnType<typeof flag>

/** A latch over the given decision-time inputs, with a sink that writes the flag
 *  back on every transition (what the applet's store set does). */
function recordingLatch(opts: { level?: () => number; flag: Flag }) {
  const warnedAt: number[] = []
  let rearms = 0
  const latch = createLowWarningLatch({
    threshold: opts.level ?? (() => 10),
    warned: opts.flag.read,
    onWarn: (pct) => {
      warnedAt.push(pct)
      opts.flag.box.value = true
    },
    onRearm: () => {
      rearms += 1
      opts.flag.box.value = false
    },
  })
  return { latch, warnedAt, rearms: () => rearms }
}

// ── (a) one warning per descent ──

const descent = recordingLatch({ flag: flag(false) })
check("above the threshold is silent", descent.latch.handle(r(11)) === "idle")
check("reaching the threshold warns", descent.latch.handle(r(10)) === "warn")
check(
  "every reading below the threshold after that is silent",
  descent.latch.handle(r(9)) === "idle" && descent.latch.handle(r(8)) === "idle",
)
check(
  "exactly one warning was sent, at the threshold",
  descent.warnedAt.length === 1,
  `got ${descent.warnedAt.length}`,
)

// ── (b) the rise above the threshold re-arms ──

check("a reading above the threshold re-arms", descent.latch.handle(r(11)) === "rearm")
check("warned() is false after the re-arm", descent.latch.warned() === false)
check(
  "a second reading above the threshold does not re-arm again",
  descent.latch.handle(r(12)) === "idle",
)
check(
  "the next descent warns again, once",
  descent.latch.handle(r(10)) === "warn" && descent.warnedAt.length === 2,
  `warns ${descent.warnedAt.length}`,
)
check("the re-arm ran once per rise", descent.rearms() === 1, `got ${descent.rearms()}`)

// ── (c) charging neither warns nor consumes the latch ──

const charging = recordingLatch({ flag: flag(false) })
check(
  "a charging battery below the threshold is silent",
  charging.latch.handle(r(5, "Charging")) === "idle",
)
check("nothing was warned while charging", charging.warnedAt.length === 0)
check("the latch stayed armed through charging", charging.latch.warned() === false)
check(
  "unplugging below the threshold still warns",
  charging.latch.handle(r(5)) === "warn" && charging.warnedAt.length === 1,
)

// ── (d) an already-warned flag: a restart neither repeats nor swallows ──

const restarted = recordingLatch({ flag: flag(true) })
check(
  "a restart already below the threshold does not repeat the warning",
  restarted.latch.handle(r(9)) === "idle",
)
check("a restart above the threshold re-arms", restarted.latch.handle(r(50)) === "rearm")
check(
  "the next descent after the restart warns",
  restarted.latch.handle(r(9)) === "warn" && restarted.warnedAt.length === 1,
)

// ── (e) the boundary and the step function's own cases ──

check("at the threshold counts as below it", lowWarningStep(r(10), 10, false) === "warn")
check(
  "one percent above the threshold is not the crossing",
  lowWarningStep(r(11), 10, false) === "idle",
)
check(
  "an idle (Full) battery below the threshold counts as not charging",
  lowWarningStep(r(9, "Full"), 10, false) === "warn",
)
check(
  "above the threshold with the latch set re-arms even while charging",
  lowWarningStep(r(50, "Charging"), 10, true) === "rearm",
)

// ── (f) a throwing sink cannot cause a repeat ──

let threw = false
const throwing = createLowWarningLatch({
  threshold: () => 10,
  warned: () => false,
  onWarn: () => {
    throw new Error("sink failed")
  },
  onRearm: () => {},
})
try {
  throwing.handle(r(9))
} catch {
  threw = true
}
check(
  "a throwing sink leaves the latch set, so the next poll is silent",
  threw && throwing.warned() === true && throwing.handle(r(8)) === "idle",
)

// ── (g) every action the latch returns is one of the three ──

const actions: LowWarningAction[] = ["warn", "rearm", "idle"]
const sweep = recordingLatch({ flag: flag(false) })
const seen = [sweep.latch.handle(r(50)), sweep.latch.handle(r(10)), sweep.latch.handle(r(11))]
check(
  "the latch only ever answers warn/rearm/idle",
  seen.every((a) => actions.includes(a)),
  seen.join(","),
)

// ── (h) the LEVEL is read at decision time (appearance is a live config tier) ──

let level = 10
const live = recordingLatch({ level: () => level, flag: flag(false) })
check("above the level in force the reading is silent", live.latch.handle(r(11)) === "idle")
level = 20
check(
  "raising the level takes effect on the NEXT reading, with no rebuild",
  live.latch.handle(r(11)) === "warn" && live.warnedAt.length === 1,
  `warns ${live.warnedAt.length}`,
)
level = 5
check(
  "lowering the level below the reading re-arms instead of warning",
  live.latch.handle(r(11)) === "rearm",
)

// ── (i) a second mount of the applet shares the flag and does not warn again ──

const shared = flag(false)
const firstMount = recordingLatch({ flag: shared })
const secondMount = recordingLatch({ flag: shared })
check("the first mount warns on the descent", firstMount.latch.handle(r(9)) === "warn")
check(
  "the second mount (seeded before the first mount's write) stays silent",
  secondMount.latch.handle(r(9)) === "idle" && secondMount.warnedAt.length === 0,
)
shared.box.value = false // the level rose and the flag was re-armed
check(
  "once the flag is re-armed the second mount warns on the next descent",
  secondMount.latch.handle(r(9)) === "warn" && secondMount.warnedAt.length === 1,
)

// ── (j) no read can ARM the latch — only a rise above the level does ──

const readOnly = recordingLatch({ flag: flag(true) })
check("an already-warned flag below the level stays silent", readOnly.latch.handle(r(5)) === "idle")
check(
  "an already-warned flag above the level only re-arms",
  readOnly.latch.handle(r(50)) === "rearm",
)
check("no warning came out of those two readings", readOnly.warnedAt.length === 0)
check(
  "the descent after the genuine rise warns once",
  readOnly.latch.handle(r(5)) === "warn" && readOnly.warnedAt.length === 1,
)

// ── (k) an in-process wait survives a flag whose write failed ──

const writeFails = recordingLatch({ flag: { box: { value: false }, read: () => false } })
check(
  "a warn is remembered in-process even when the flag read keeps answering false",
  writeFails.latch.handle(r(9)) === "warn" &&
    writeFails.latch.handle(r(8)) === "idle" &&
    writeFails.warnedAt.length === 1,
  `warns ${writeFails.warnedAt.length}`,
)

console.log(results.join("\n"))
if (failed) {
  console.log("[probe] RESULT: FAIL")
  // Throwing (not process.exit) keeps this probe gi-free AND type-checks: the
  // repo's [probe] exit hook is gjs's `imports.system`, which plain Node has not
  // got. A thrown error is the non-zero exit here.
  throw new Error("low-warning.probe failed")
}
console.log("[probe] RESULT: PASS")
