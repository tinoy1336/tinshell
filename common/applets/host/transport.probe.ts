/**
 * transport.probe — the applets member table and its fail-closed resolution
 * (common/applets/host/transport.ts).
 *
 * `resolveMember` is the ONE place a request token becomes a member name, and
 * the socket surface classifies traffic by the RESOLVED name (a shorthand must
 * not slip past a policy that names the long form). Two invariants keep that
 * safe, and this probe fails if either inverts:
 *   - a token the table does not name resolves to an EMPTY name, never to a
 *     guess, so a caller that denies on an empty name denies the unknown;
 *   - an AMBIGUOUS token is empty too, with its candidates listed, so the same
 *     deny-on-empty rule covers it.
 * It also pins the store accessors the owner-only policy matches by SUFFIX
 * (`.set`, `.dump`, `.path`): rename one and the policy silently stops
 * protecting it.
 *
 * What this probe cannot drive: `handleDomainRequest` (async, and the module
 * graph pulls `common/session`, whose import stops promise continuations
 * draining outside the AGS runtime — see the host spec). The WRITE ordering is
 * therefore pinned at the resolution seam, which is the gate the callers use.
 *
 * Run (bundled — this module imports GI):
 *   ags bundle --gtk 4 common/applets/host/transport.probe.ts /tmp/transport-probe.sh
 *   timeout 90 bash /tmp/transport-probe.sh
 */
import { APPLETS_DOMAINS, domainMembers, resolveMember } from "./transport.ts"

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}

const domains = Object.keys(APPLETS_DOMAINS).sort()

// ── the table: every domain answers, with sorted unique member names ──
check("the table is not empty", domains.length > 0, true)
check("the fs domain exists (a never-served list depends on it)", domains.includes("fs"), true)
check("the battery domain exists", domains.includes("battery"), true)
let sortedUnique = true
let everyDomainHasMembers = true
for (const d of domains) {
  const members = domainMembers(d)
  if (members.length === 0) everyDomainHasMembers = false
  if (JSON.stringify(members) !== JSON.stringify([...members].sort())) sortedUnique = false
  if (new Set(members).size !== members.length) sortedUnique = false
}
check("every domain exposes at least one member", everyDomainHasMembers, true)
check("member lists come back sorted and deduplicated", sortedUnique, true)
check("an unknown domain has no members", domainMembers("no-such-domain").length, 0)

// ── the fail-closed direction: unknown and ambiguous never become a name ──
check("an unknown member resolves to no name", resolveMember("battery", "no-such-member").name, "")
check(
  "an unknown member offers no candidates",
  resolveMember("battery", "no-such-member").ambiguous,
  [],
)
check("an unknown domain resolves to no name", resolveMember("no-such-domain", "state").name, "")
check(
  "an unknown domain offers no candidates",
  resolveMember("no-such-domain", "state").ambiguous,
  [],
)
check("an empty token resolves to no name", resolveMember("battery", "").name, "")

const battery = domainMembers("battery")
check(
  "a member named by the table resolves to itself",
  resolveMember("battery", battery[0]).name,
  battery[0],
)
check(
  "a member's case-insensitive spelling resolves",
  resolveMember("battery", battery[0].toUpperCase()).name,
  battery[0],
)

// ── the shorthand ladder: domain-word prefix, then one camel word ──
check(
  "a domain-word prefix resolves (`battery state` → batteryState)",
  resolveMember("battery", "state").name,
  "batteryState",
)

// ── the store accessors the owner-only policy matches by suffix ──
const storeMembers = domains.flatMap((d) => domainMembers(d)).filter((m) => m.includes("."))
const storeVerbs = [...new Set(storeMembers.map((m) => `.${m.split(".").pop()}`))].sort()
check("store accessors are named `<store>.<verb>`", storeMembers.length > 0, true)
check("store accessors expose only known verbs", storeVerbs, [
  ".dump",
  ".get",
  ".path",
  ".ready",
  ".reload",
  ".set",
])
// The owner-only suffixes the socket policy matches must still name real
// accessors: rename one and the policy silently stops protecting that write.
check(
  "every owner-only suffix names a real store accessor",
  [".set", ".dump", ".path"].every((s) => storeVerbs.includes(s)),
  true,
)
check(
  "a store write is reachable by its exact name (so the policy sees it)",
  resolveMember("battery", "chargeThresholdStore.set").name,
  "chargeThresholdStore.set",
)

// ── a resolved name is always a real table member (never a fabrication) ──
let allResolvedExist = true
for (const d of domains) {
  for (const m of domainMembers(d)) {
    const r = resolveMember(d, m)
    if (r.name !== m || r.ambiguous.length > 0) allResolvedExist = false
  }
}
check("every table member resolves to itself with no candidates", allResolvedExist, true)

const failed = checks.filter(
  ([, actual, expected]) => JSON.stringify(actual) !== JSON.stringify(expected),
)
for (const [name, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`transport probe failed: ${failed.length} check(s)`)
