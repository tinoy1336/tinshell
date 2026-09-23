/**
 * Calculator source — the launcher's arithmetic and conversions.
 *
 * Two halves: the curated unit table (`sources/units.ts`: temperature, length,
 * mass, volume, data size, data rate, speed, time, numerals) answers the
 * compact conversion shapes instantly and in every companion scale, and qalc
 * (`qalc -t`) answers everything the table does not parse — arithmetic,
 * constants, currency, and any unit pair the table omits.
 *
 * Currency handling: qalc needs `-e` to refresh exchange rates (network).
 * To avoid a network call on every keystroke, rates are refreshed on demand
 * only when stale (older than currency.cacheMs, default 24h). The busy
 * callback reports whether the call is still in flight, so the UI can show its
 * loading indicator through the (possibly network) delay. Until the refresh
 * completes, stale rates answer instantly; the refresh runs once per TTL window.
 *
 * Currency conversion results also show the current rate as the row
 * description (e.g. "1 USD = 0.92 EUR"), fetched via a second qalc call that
 * computes the per-unit ratio. This makes the effective rate visible without
 * the user having to ask for it separately.
 *
 * Input normalization: qalc parses bare `in` as `inch`, so "1 hour in
 * seconds" → "1 hour to seconds" (the user-meaningful "convert to" form).
 * `as` is rewritten the same way.
 */

import { copy } from "@common/clipboard"
import { ignore } from "@common/log/logger"
import { run, TimeoutError } from "@common/subprocess/run"
import { get } from "../config"
import { log } from "../log"
import type { Result } from "../types"
import { unitConversions } from "./units"

let ratesLastRefresh = 0 // epoch ms; 0 = never

/**
 * The curated conversion rows (sources/units.ts) — sync and subprocess-free, so
 * they answer on the keystroke while qalc is still being spawned.
 */
export function unitRows(query: string): Result[] {
  return unitConversions(query).map((c) => ({
    title: c.title,
    description: c.description,
    icon: "accessories-calculator",
    category: "calc" as const,
    run: () => {
      copy(c.title)
      return true
    },
  }))
}

/** Whether qalc rates are considered stale and need `-e` refresh. */
function ratesStale(): boolean {
  const ttl = get<number>("currency.cacheMs", 86400000)
  return ttl <= 0 || ratesLastRefresh === 0 || Date.now() - ratesLastRefresh > ttl
}

/** Normalize a raw query into qalc-friendly form. */
function normalize(q: string): string {
  // Rewrite " in " / " as " (convert-to intent) → " to " (qalc reads bare in=inch)
  return q.replace(/\s+(in|as)\s+/g, " to ")
}

const CURRENCY_TOKENS =
  /\b(USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|bitcoin|btc|dollars?|euros?|pounds?)\b/i

/** A conversion query: "<amount> <unit> to <unit>". Returns the two units or null. */
function parseConversion(expr: string): { amount: string; from: string; to: string } | null {
  const m = expr.trim().match(/^([\d.]+)\s+(\S+)\s+to\s+(\S+)$/i)
  if (!m) return null
  return { amount: m[1], from: m[2], to: m[3] }
}

/**
 * For a currency conversion, fetch the per-unit rate (e.g. "1 USD = 0.92 EUR")
 * to show alongside the converted amount. Returns null on any failure — the
 * amount alone is still useful.
 */
async function fetchRate(
  conv: { amount: string; from: string; to: string },
  needRefresh: boolean,
): Promise<string | null> {
  try {
    const res = await run(
      ["qalc", ...(needRefresh ? ["-e"] : []), "-t", `1 ${conv.from} to ${conv.to}`],
      { timeoutMs: get<number>("currency.timeoutMs", 6000) },
    )
    if (res.exit !== 0) return null
    const r = res.stdout.trim().split("\n")[0].trim()
    if (!r) return null
    return `1 ${conv.from} = ${r}`
  } catch (e) {
    // qalc failed to run (missing binary, timeout, invalid expression).
    ignore("qalc currency conversion", e)
    return null
  }
}

/**
 * Evaluate `query` via qalc. Resolves with a Result (title=answer) or null
 * when qalc has nothing to say (non-zero exit / empty answer). `onBusy`
 * brackets the async phases so the UI can spin its loading indicator.
 */
export async function calc(query: string, onBusy: (busy: boolean) => void): Promise<Result | null> {
  const raw = query.trim()
  if (!raw) return null
  const expr = normalize(raw)
  const timeoutMs = get<number>("calc.timeoutMs", 4000)

  // Decide whether this query touches currency (needs fresh rates). Cheap
  // heuristic: a currency token is present. If so and rates are stale, do the
  // refresh; otherwise plain qalc.
  const looksMonetary = CURRENCY_TOKENS.test(expr)
  const needRefresh = looksMonetary && ratesStale()

  try {
    onBusy(true)
    const res = await run(["qalc", ...(needRefresh ? ["-e"] : []), "-t", expr], {
      timeoutMs: needRefresh ? get<number>("currency.timeoutMs", 6000) : timeoutMs,
    })
    const answer = res.stdout.trim()
    if (res.exit !== 0 || !answer) return null
    // qalc -t emits a single line; guard against noisy multi-line fallbacks.
    const firstLine = answer.split("\n")[0].trim()
    if (!firstLine) return null
    if (needRefresh) ratesLastRefresh = Date.now()

    // For currency conversions, also show the per-unit rate as the description.
    let description = raw
    if (looksMonetary) {
      const conv = parseConversion(expr)
      if (conv) {
        const rate = await fetchRate(conv, needRefresh)
        if (rate) description = `${rate}  (${raw})`
      }
    }

    return {
      title: firstLine,
      description,
      icon: "accessories-calculator",
      category: "calc",
      run: () => {
        copy(firstLine)
        return true
      },
    }
  } catch (e) {
    if (e instanceof TimeoutError) {
      log(`calc: timeout on "${expr}"`)
    } else {
      log(`calc: error on "${expr}": ${(e as Error).message}`)
    }
    return null
  } finally {
    onBusy(false)
  }
}
