/**
 * profile-name.probe — the power daemon's `ActiveProfile` mapping
 * (common/applets/domains/profile-name.ts).
 *
 * Two consumers depend on the fall-through case: `domains/tlp.ts` arms its
 * `tlp-stat` fallback on `unknown` and skips it otherwise, and the performance
 * applet refuses to switch profiles from an unanswered read. A mapping that
 * quietly answered "balanced" would hide an absent daemon AND let the applet act
 * on a reading nobody took, with no error anywhere — so the edges are pinned
 * here: the three profiles the daemon names, and everything else as `unknown`.
 *
 * Run:  node --experimental-strip-types common/applets/domains/profile-name.probe.ts
 */
import { profileFromString } from "./profile-name.ts"

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}

check("performance maps to performance", profileFromString("performance"), "performance")
check("balanced maps to balanced", profileFromString("balanced"), "balanced")
check("power-saver maps to power-saver", profileFromString("power-saver"), "power-saver")
check("an unlisted spelling is unknown, not balanced", profileFromString("powersave"), "unknown")
check("a name a future release adds is unknown", profileFromString("turbo"), "unknown")
check("an empty reply is unknown", profileFromString(""), "unknown")
check("a differently-cased name is not guessed at", profileFromString("Balanced"), "unknown")

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`)
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`profile-name probe failed: ${failed.length} check(s)`)
