/**
 * build-stamp.probe — reproducible probe for the build identity a bundle
 * carries (common/host/build-stamp.ts).
 *
 * Asserts the `TINSHELL_BUILD_STAMP` triple the bundler injects parses (and that a
 * malformed one is rejected rather than half-read), that the startup line and
 * the report state the artifact, its fingerprint, its build time and the store
 * the bundle belongs to, that the on-disk comparison tells a superseded bundle
 * cache from a matching one AND from a bundle that carries no store at all, and that
 * `<instance> debug build` answers through the registry dispatcher — the same
 * call the request path makes.
 *
 * Run:
 *   ags bundle --gtk 4 common/host/build-stamp.probe.ts /tmp/build-stamp-probe.sh
 *   bash /tmp/build-stamp-probe.sh
 */
import GLib from "gi://GLib"
import { dispatch } from "@common/commands/registry"
import {
  buildStamp,
  buildStampLines,
  buildStampText,
  registerBuildStampRequest,
} from "./build-stamp"

const checks: [string, string, string][] = []
const eq = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, String(actual), String(expected)])
}
const has = (name: string, haystack: string, needle: string): void => {
  checks.push([name, String(haystack.includes(needle)), "true"])
}

const FP = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const WHEN = 1758490000

// ── no stamp: a bundle built outside the bundler ──
GLib.unsetenv("TINSHELL_BUILD_STAMP")
eq("unset → no stamp", buildStamp(), null)
has("unset → text says so", buildStampText(), "outside the bundler")
eq("unset → report names no artifact", buildStampLines()[0], "artifact: (none)")

// ── malformed stamp: artifact without a fingerprint is not readable ──
GLib.setenv("TINSHELL_BUILD_STAMP", "universal", true)
eq("malformed → no stamp", buildStamp(), null)

// ── the injected triple ──
GLib.setenv("TINSHELL_BUILD_STAMP", `universal ${FP} ${WHEN}`, true)
eq("artifact parses", buildStamp()?.artifact, "universal")
eq("fingerprint parses", buildStamp()?.fingerprint, FP)
eq("built-at parses", buildStamp()?.builtAt, WHEN)
const text = buildStampText()
has("text names the artifact", text, "universal")
has("text carries the short fingerprint", text, FP.slice(0, 12))
has(
  "text carries the local build time",
  text,
  GLib.DateTime.new_from_unix_local(WHEN).format("%Y-%m-%d %H:%M:%S") ?? "",
)

// ── the store travels with the bundle; nothing here resolves it ──
GLib.unsetenv("TINSHELL_BUILD_STORE")
has("no store → text says so", buildStampText(), "(no store named on this bundle)")
has("no store → report says so", buildStampLines().join("\n"), "store: unknown")
has(
  "no store → on-disk unknown names the reason",
  buildStampLines().join("\n"),
  "on-disk: unknown (this bundle names no store)",
)

// ── the on-disk comparison (this bundle's own store) ──
const store = `${GLib.dir_make_tmp("tinshell-stamp-probe-XXXXXX")}/tinshell-bundle`
GLib.setenv("TINSHELL_BUILD_STORE", store, true)
const sidecar = `${store}/universal/build-stamp.json`
GLib.mkdir_with_parents(`${store}/universal`, 0o755)
const writeSidecar = (fingerprint: string): void => {
  GLib.file_set_contents(sidecar, JSON.stringify({ artifact: "universal", fingerprint }))
}
has("store → report names it", buildStampLines().join("\n"), `store: ${store}`)
has("store → text names it", buildStampText(), `from store ${store}`)
has(
  "store → text keeps the artifact, fingerprint and build time",
  `${buildStampText().startsWith(`universal built from sources ${FP.slice(0, 12)} at `)}`,
  "true",
)
has("no sidecar yet → unknown", buildStampLines().join("\n"), "on-disk: unknown")
writeSidecar("deadbeef")
writeSidecar(FP)
has(
  "same fingerprint → matches",
  buildStampLines().join("\n"),
  `on-disk: matches (${FP.slice(0, 12)})`,
)
writeSidecar("ffffffff")
has("moved-on fingerprint → DIFFERS", buildStampLines().join("\n"), "on-disk: DIFFERS")

// ── `<instance> debug build` answers through the dispatcher ──
registerBuildStampRequest("probeinst", () => ["set: dock"])
let reply = ""
dispatch(["probeinst", "debug", "build"], (r) => {
  reply = r
})
has("debug build answers the instance", reply, "instance: probeinst")
has("debug build answers the host context", reply, "set: dock")
has("debug build answers the artifact", reply, "artifact: universal")
has("debug build answers the fingerprint", reply, FP)
has("debug build points at the gate", reply, "npm run check:builds")

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`)
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`build-stamp probe failed: ${failed.length} check(s)`)
