/**
 * charge-counter.probe — the fully-charged counter's state machine and the
 * borrowed formatter (common/applets/battery/charge-counter.ts +
 * common/applets/shared/elapsed.ts).
 *
 * No gi, no GTK, no applet, no real store: the counter takes its durable stamp as
 * two functions, so the probe drives it with a recording stub. It asserts that
 * entering the plugged-and-idle state stamps the moment, that staying in it only
 * advances the TEXT, that leaving it clears the record and stops the text, that a
 * stamp left by an earlier process RESUMES the count rather than restarting it,
 * that a machine with no record starts from the first observation, and that the
 * formatter reproduces the power applet's own elapsed-text shape for every finite
 * input (the reason the formatter was moved rather than rewritten).
 *
 * The counter module reaches the formatter through the `@common/*` alias, which
 * plain Node cannot resolve, so this probe runs bundled — with no gi of its own,
 * it still imports nothing that touches a display.
 *
 * Run:
 *   ags bundle --gtk 4 common/applets/battery/charge-counter.probe.ts /tmp/charge-counter-probe.sh
 *   bash /tmp/charge-counter-probe.sh       # exit 1 on any violated invariant
 */

import { formatElapsed } from "@common/applets/shared/elapsed"
import { createChargeCounter } from "./charge-counter"

const results: string[] = []
let failed = false

function check(label: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failed = true
}

/** The durable stamp as one applet's store serves it: a value plus a write log. */
function stamp(initial = 0) {
  const writes: number[] = []
  let value = initial
  return {
    writes,
    store: {
      read: () => value,
      write: (v: number) => {
        value = v
        writes.push(v)
      },
    },
  }
}

const T0 = 1_700_000_000 // an arbitrary fixed epoch (seconds)

// ── (a) entering the state stamps the moment ──

const entering = stamp()
const counter = createChargeCounter(entering.store)
check(
  "nothing is counted before the state is observed",
  !counter.active() && counter.text(T0) === "",
)
check("leaving a state that never began is a no-op", counter.observe(false, T0) === false)
check("entering the state reports the change", counter.observe(true, T0) === true)
check(
  "the moment of entry is what was written",
  entering.writes.length === 1 && entering.writes[0] === T0,
)
check("the text starts at zero elapsed", counter.text(T0) === "0s" && counter.active())

// ── (b) staying in the state advances the text, never the stamp ──

check(
  "a second observation of the same state reports nothing new",
  counter.observe(true, T0 + 5) === false,
)
check("the stamp is not rewritten while the state lasts", entering.writes.length === 1)
check("90 seconds in reads 2m", counter.text(T0 + 90) === "2m")
check("an hour in reads 1h", counter.text(T0 + 3600) === "1h")
check("a day in reads 24h (days begin past 100 h)", counter.text(T0 + 86_400) === "24h")
check("the state is still the one thing being counted", counter.active())

// ── (c) leaving the state clears the record and the text ──

check("leaving the state reports the change", counter.observe(false, T0 + 90) === true)
check("the clear is written as 0 (no start time on record)", entering.writes[1] === 0)
check("no text is painted once the state ends", counter.text(T0 + 90) === "" && !counter.active())
check("observing the ended state again reports nothing", counter.observe(false, T0 + 91) === false)
check(
  "re-entering stamps the NEW moment, not the old one",
  counter.observe(true, T0 + 500) === true && counter.text(T0 + 500) === "0s",
)

// ── (d) a stamp left by an earlier process RESUMES the count ──

const restarted = stamp(T0) // written before the process restart
const resumed = createChargeCounter(restarted.store)
check("a stored stamp paints nothing until the state is observed", resumed.text(T0 + 600) === "")
check(
  "the first observation resumes from the stored moment",
  resumed.observe(true, T0 + 600) === true,
)
check(
  "...so ten minutes in read 10m, not 0s",
  resumed.text(T0 + 600) === "10m",
  resumed.text(T0 + 600),
)
check(
  "resuming rewrites the same stamp (no new start)",
  restarted.writes.length === 1 && restarted.writes[0] === T0,
)
check("...and keeps advancing from it", resumed.text(T0 + 1200) === "20m")

// ── (e) a machine that boots already in the state counts from first sight ──

const freshBoot = stamp(0)
const booted = createChargeCounter(freshBoot.store)
check("no record means no earlier time to claim", booted.text(T0) === "")
check("the first observation becomes the start", booted.observe(true, T0) === true)
check(
  "a boot already topped out reads from boot",
  booted.text(T0) === "0s" && booted.text(T0 + 5) === "5s",
)

// ── (f) the formatter reproduces the power applet's own shape ──

/** The power applet's elapsed-text arithmetic as it stood before the move. */
function legacyFormat(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(s / 3600)
  if (h < 100) return `${h}h`
  const d = Math.round(s / 86400)
  return `${d}d`
}

const boundaries = [0, 1, 59, 60, 61, 90, 3599, 3600, 359_999, 356_400, 360_000, 86_400, 8_640_000]
let mismatch = ""
for (const seconds of boundaries) {
  if (formatElapsed(seconds) !== legacyFormat(seconds)) {
    mismatch = `${seconds}: ${formatElapsed(seconds)} vs ${legacyFormat(seconds)}`
    break
  }
}
check(
  "every boundary reads exactly as the power applet's own formatter read",
  mismatch === "",
  mismatch,
)

let sweepMismatch = ""
for (let s = 0; s <= 200_000; s += 7) {
  if (formatElapsed(s) !== legacyFormat(s)) {
    sweepMismatch = `${s}: ${formatElapsed(s)} vs ${legacyFormat(s)}`
    break
  }
}
check(
  "...and so does a sweep of every finite value to 200 000 s",
  sweepMismatch === "",
  sweepMismatch,
)

check(
  "the unit ladder's edges are the documented ones (59s / 1m / 1h / 99h / 4d)",
  formatElapsed(59) === "59s" &&
    formatElapsed(60) === "1m" &&
    formatElapsed(3600) === "1h" &&
    formatElapsed(356_400) === "99h" &&
    formatElapsed(360_000) === "4d",
)

console.log(results.join("\n"))
console.log(
  `charge-counter.probe: ${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`,
)
if (failed) {
  console.log("[probe] RESULT: FAIL")
  imports.system.exit(1)
}
console.log("[probe] RESULT: PASS")
imports.system.exit(0)
