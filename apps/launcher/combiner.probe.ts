/**
 * combiner.probe — the launcher's conversion rows through the REAL query path
 * (combiner.ts → sources/calc.ts `unitRows` → sources/units.ts), not through
 * the table alone.
 *
 * The launcher exposes no request surface that enumerates rows for a query, so
 * this drives `Combiner.queryDidChange` in a throwaway process: no window is
 * opened, nothing is spawned, and the list it prints is the list the popup
 * would render (every source, the priority order and the `maxEntries` cap
 * included). It pins what a keystroke produces — the metric cooking measures
 * with their convention line, the two readings of `k`, the SI-first row order
 * of a bare amount, the bare typed shapes (a colour code, a JWT, an IPv4 CIDR
 * block) and that a conversion the table answered never also reaches qalc.
 *
 * Needs the config store and the emoji state store, so it runs under the TINSHELL
 * runtime rather than plain node:
 *   ags bundle --gtk 4 apps/launcher/combiner.probe.ts /tmp/combiner-probe.sh
 *   bash /tmp/combiner-probe.sh    # exit 1 on any wrong row
 *   QUERIES="1 cup to ml|4k" bash /tmp/combiner-probe.sh   # dump rows instead
 */
import GLib from "gi://GLib"
import { Combiner } from "./combiner"
import type { Result } from "./types"

/** The rows the popup would render for `query` — every source, in order. */
function rowsFor(query: string): Result[] {
  let out: Result[] = []
  const combiner = new Combiner({
    onResults: (batch) => {
      out = batch.results
    },
    onBusy: () => {},
  })
  combiner.queryDidChange(query)
  return out
}

/** `rowsFor` plus the async batch: the dump waits out the debounce (and any
 *  in-flight source) so a calc-only query shows the row the popup renders. */
function rowsWithAsync(query: string): Result[] {
  let out: Result[] = []
  let busy = false
  const combiner = new Combiner({
    onResults: (batch) => {
      out = batch.results
    },
    onBusy: (b) => {
      busy = b
    },
  })
  combiner.queryDidChange(query)
  const ctx = GLib.MainContext.default()
  const start = GLib.get_monotonic_time()
  const deadline = start + 5_000_000
  while (GLib.get_monotonic_time() < deadline) {
    ctx.iteration(false)
    // Past the debounce window and nothing in flight: the list is settled.
    if (GLib.get_monotonic_time() - start > 700_000 && !busy) break
  }
  return out
}

const checks: [string, string, string][] = []

/** `<query>` → the rows the popup would show, as `[title, description][]`. */
function rows(query: string, ...expected: [string, string][]): void {
  const actual = rowsFor(query).map((r) => [r.title, r.description ?? ""])
  checks.push([query, JSON.stringify(actual), JSON.stringify(expected)])
}

/** `<query>` → the row TITLES the popup would show. The content of a shape row
 *  is pinned by text-tools.probe.ts; this pins that those rows reach the list
 *  through the real query path, and that nothing else joins them. */
function titles(query: string, ...expected: string[]): void {
  const actual = rowsFor(query).map((r) => r.title)
  checks.push([query, JSON.stringify(actual), JSON.stringify(expected)])
}

/** `titles` for an ASYNC row (calc): the combiner debounces the kickoff, so
 *  the main context is pumped until the list stops being empty. */
function asyncTitles(query: string, ...expected: string[]): void {
  let out: Result[] = []
  const combiner = new Combiner({
    onResults: (batch) => {
      out = batch.results
    },
    onBusy: () => {},
  })
  combiner.queryDidChange(query)
  const ctx = GLib.MainContext.default()
  const deadline = GLib.get_monotonic_time() + 5_000_000
  while (out.length === 0 && GLib.get_monotonic_time() < deadline) ctx.iteration(false)
  checks.push([query, JSON.stringify(out.map((r) => r.title)), JSON.stringify(expected)])
}

// LIVE=1: the same query through the SETTLED path — the async preview replaces
// the sync row (one row, with the fetched description) instead of doubling it.
// It runs BEFORE the fixture checks: those leave their own debounce timers
// armed, and a preview in flight is cancelled by the next preview that starts
// (a query change supersedes the request it replaced), so this dump needs the
// only preview in the process. Opt-in — the checks themselves never fetch.
if (GLib.getenv("LIVE") === "1") {
  const dump = rowsWithAsync("!aw greetd").map((r) => [r.title, r.description ?? ""])
  console.log(`live !aw greetd -> ${JSON.stringify(dump)}`)
}

// ── cooking measures: metric by default, the convention named ──
rows("1 cup to ml", ["1 cup = 250 mL", "1 cup = 250 mL  ·  metric (Canadian)"])
rows("2 tbsp to tsp", ["2 tbsp = 6 tsp", "1 tbsp = 3 tsp  ·  metric (Canadian)"])
rows("3 us tsp to ml", ["3 US tsp = 14.7868 mL", "1 US tsp = 4.92892 mL  ·  US customary"])
rows(
  "2 cups",
  ["2 cup = 500 mL", "1 cup = 250 mL  ·  metric (Canadian)"],
  ["2 cup = 2.11338 US cup", "1 cup = 1.05669 US cup  ·  metric (Canadian)  ·  US customary"],
)
// ── `k`: thousand on its own, kelvin when the target says temperature ──
rows("100k to c", ["100 K = -173.15 °C", "= -279.67 °F"])
rows("4k")
// ── SI first, imperial underneath ──
rows("20C", ["20 °C = 293.15 K", "= 68 °F"], ["20 °C = 68 °F", "= 293.15 K"])
// ── bare typed shapes: one row, and never also a qalc row ──
titles("#ff0000", "#FF0000 — rgb(255, 0, 0)")
titles("192.168.1.10/24", "192.168.1.0/24 — 254 hosts")
titles(
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.sig",
  "JWT",
)
// ── percent-of: qalc reads `%` as a remainder, so the combiner rewrites the
// shape it cannot parse (`15% of 200` → `15% * 200`) before the kickoff ──
asyncTitles("15% of 200", "30")

// ── an enriched bang shows its OWN row on the keystroke ──
// The preview is a thunk the combiner calls on the settled query, so the sync
// batch already carries the bang's row (its title — and its Enter target, built
// by the same xdgOpenRow) and no request is made while typing.
function firstTitle(query: string, expected: string): void {
  const actual = rowsFor(query)[0]?.title ?? ""
  checks.push([query, JSON.stringify(actual), JSON.stringify(expected)])
}
firstTitle("!aw greetd", "ArchWiki: greetd")
firstTitle("!pac greetd", "Arch package: greetd")
firstTitle("!wiki hyprland", "Wikipedia: hyprland")

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${JSON.stringify(name)}${ok ? "" : `\n     got  ${actual}\n     want ${expected}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`combiner probe failed: ${failed.length} check(s)`)

// `QUERIES="<query>|<query>" bash /tmp/combiner-probe.sh` prints the rows of
// each query instead of stopping at the checks — the same path, read back by
// hand for a query the checks do not pin.
const queries = (GLib.getenv("QUERIES") ?? "")
  .split("|")
  .map((q) => q.trim())
  .filter((q) => q !== "")
for (const query of queries) {
  const dump = rowsWithAsync(query).map((r) => [r.title, r.description ?? ""])
  console.log(`${JSON.stringify(query)} -> ${JSON.stringify(dump)}`)
}
