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
 *
 * Answer verification: qalc never reports a target it cannot apply —
 * `10 grams to cad` comes back as `10 g` and `10 usd to cad/gal` as the plain
 * `usd`→`cad` rate, both with exit 0 and an empty stderr — so a zero exit says
 * nothing about whether the question was answered. A conversion is therefore
 * checked against what qalc makes of LESS of the same query (see
 * `targetApplied`), and a row that fails is dropped rather than shown.
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

/** Spelled-out currency names, mapped to the code qalc resolves as a currency.
 *  `dollar(s)` and `euro(s)` are unambiguous; `pound` is NOT in the table,
 *  because `10 pounds to kg` is a weight and mapping it to GBP would answer a
 *  different question than the one asked. */
const CURRENCY_WORDS: Record<string, string> = {
  dollar: "USD",
  dollars: "USD",
  buck: "USD",
  bucks: "USD",
  euro: "EUR",
  euros: "EUR",
  yen: "JPY",
  yuan: "CNY",
  renminbi: "CNY",
  rupee: "INR",
  rupees: "INR",
  franc: "CHF",
  francs: "CHF",
}

/** An amount as the launcher accepts it: grouped thousands, decimals, and
 *  scientific notation. `[+-]` and `1,250.50` and `2.5e3` are all amounts the
 *  user can type, so every shape that parses as one is matched here. */
const NUM = String.raw`[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?`

/** Normalize a raw query into qalc-friendly form. */
function normalize(q: string): string {
  // A spelled-out currency name becomes its code before anything else: qalc
  // does not know `dollars` as a currency and decomposes it into base units,
  // so `10 dollars to euros` came back as `0.0005817241415 B·€·L²` — a wrong
  // answer, not a refusal.
  const words = q.replace(/\b[a-z]+\b/gi, (w) => CURRENCY_WORDS[w.toLowerCase()] ?? w)
  // Grouped amounts lose their separators: qalc reads `1,250` as a two-element
  // vector and answers `[1 (CAD 358.3814)]`, which is not a conversion.
  const flat = words.replace(/(?<=\d),(?=\d{3}(?!\d))/g, "")
  // Rewrite " in " / " as " (convert-to intent) → " to " (qalc reads bare in=inch).
  // Case-insensitive: qalc reads a capitalized `To` as its own unit, so
  // `10 Usd To Cad` came back as `5.787178702 TB·€²` instead of a conversion.
  return flat.replace(/\s+(in|as|to)\s+/gi, " to ")
}

const CURRENCY_TOKENS =
  /\b(USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|bitcoin|btc|dollars?|euros?|pounds?)\b/i

/**
 * Is this line an ANSWER, or qalc echoing the question back?
 *
 * An expression qalc cannot finish is printed unchanged — `1/0` comes back as
 * `1 / 0` with exit 0, and a row showing the user's own text as the result is
 * worse than no row at all. The comparison folds whitespace and the operator
 * glyphs qalc substitutes, so the echo is recognised however it is spaced.
 */
function isEcho(answer: string, expr: string): boolean {
  const fold = (s: string) => s.toLowerCase().replace(/[−–]/g, "-").replace(/\s+/g, "")
  return fold(answer) === fold(expr)
}

/** A conversion query: "<amount> <unit> to <unit>", or the same with the amount
 *  after the unit ("USD 10 to CAD", the shape qalc itself accepts). Returns the
 *  two units and the amount text, or null. */
function parseConversion(expr: string): { amount: string; from: string; to: string } | null {
  const e = expr.trim()
  const amountFirst = e.match(new RegExp(`^(${NUM})\\s+(\\S+)\\s+to\\s+(\\S+)$`, "i"))
  if (amountFirst) return { amount: amountFirst[1], from: amountFirst[2], to: amountFirst[3] }
  const unitFirst = e.match(new RegExp(`^(\\S+)\\s+(${NUM})\\s+to\\s+(\\S+)$`, "i"))
  if (unitFirst) return { amount: unitFirst[2], from: unitFirst[1], to: unitFirst[3] }
  return null
}

/** The currency codes (and the few spelled forms) a rate question may name.
 *  Restricted on purpose: any three letters would make `you to cat` a rate
 *  query, and qalc answers that with `1.66E−54 B·t` instead of refusing. */
const CURRENCY_CODES = new Set([
  "usd",
  "eur",
  "gbp",
  "jpy",
  "cad",
  "aud",
  "chf",
  "cny",
  "inr",
  "brl",
  "mxn",
  "krw",
  "sek",
  "nok",
  "dkk",
  "nzd",
  "sgd",
  "hkd",
  "zar",
  "rub",
  "try",
  "pln",
  "thb",
  "idr",
  "ils",
  "czk",
  "huf",
  "bitcoin",
  "btc",
])

/** A bare rate question: "usd to cad", "eur in cad" — the pair with no amount.
 *  The row answers with the per-unit rate, which is the only thing such a query
 *  can mean. */
function parseRate(expr: string): { from: string; to: string } | null {
  const m = expr.trim().match(/^(\S+)\s+to\s+(\S+)$/i)
  if (!m) return null
  return CURRENCY_CODES.has(m[1].toLowerCase()) && CURRENCY_CODES.has(m[2].toLowerCase())
    ? { from: m[1], to: m[2] }
    : null
}

/** Does this query ask for a bare rate? The combiner's math gate asks, so a
 *  pair is recognized by the same rule that answers it. */
export function looksLikeRate(q: string): boolean {
  return parseRate(normalize(q)) !== null
}

/** A bare amount in a currency ("5 usd", "1,000 euros") — the question qalc
 *  answers by converting to the machine's own currency. The combiner's math
 *  gate asks this too, so the shape that answers is the shape that enters. */
export function looksLikeMonetaryAmount(q: string): boolean {
  const m = normalize(q)
    .trim()
    .match(new RegExp(`^(${NUM})\\s+(\\S+)$`))
  return !!m && CURRENCY_CODES.has(m[2].toLowerCase())
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
 * Ask qalc one expression and return its first output line, or null when qalc
 * fails: a missing binary, a timeout, a refusal. Rates are never refreshed
 * here — a probe has to read the same rates the answer it verifies was
 * computed from.
 *
 * AUTOCONVERSION IS OFF for the probes, and that is what makes them usable as
 * a reference: with qalc's default (`autoconversion 1`) a bare currency amount
 * is converted to the local currency on its own, so `10 usd` and
 * `10 usd to cad` print the SAME line and every real currency conversion read
 * as an ignored target. With it off the source alone reads `USD 10`, and a
 * target qalc cannot apply still prints the source unchanged, which is exactly
 * the signal `targetApplied` compares against.
 */
async function askQalc(expr: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await run(["qalc", "-t", "-s", "autoconversion 0", expr], { timeoutMs })
    if (res.exit !== 0) return null
    return res.stdout.trim().split("\n")[0].trim() || null
  } catch (e) {
    ignore("qalc probe", e)
    return null
  }
}

/**
 * Did qalc actually answer the question it was asked?
 *
 * A target qalc cannot apply is silently discarded: `10 grams to cad` is the
 * source quantity unchanged, and a compound target is applied factor by factor,
 * so `10 usd to cad/gal` is exactly the plain `cad` rate. Both are caught by
 * asking qalc for the same query with less of it — the source alone, and a
 * compound target reduced to its first factor — and rejecting an answer that
 * either one already produced. A probe that cannot run proves nothing, so the
 * answer stands; only an answer that matches a smaller query is dropped.
 */
async function targetApplied(
  conv: { amount: string; from: string; to: string },
  answer: string,
  timeoutMs: number,
): Promise<boolean> {
  // A conversion onto the unit it already has is not a question qalc answers
  // by doing nothing: `10 usd to usd` legitimately reads `USD 10`, and the
  // source-only probe below would match it and drop a correct answer.
  if (conv.from.toLowerCase() === conv.to.toLowerCase()) return true

  const source = await askQalc(`${conv.amount} ${conv.from}`, timeoutMs)
  if (source !== null && source === answer) return false

  const [first] = conv.to.split("/")
  if (first && first !== conv.to) {
    const reduced = await askQalc(`${conv.amount} ${conv.from} to ${first}`, timeoutMs)
    if (reduced !== null && reduced === answer) return false
  }
  return true
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

  // A bare currency pair asks for the rate, which needs no evaluation: qalc
  // would answer `usd to cad` with the same number `1 usd to cad` gives, but a
  // row that states the pair is what the user asked for.
  const rate = parseRate(expr)
  if (rate && !parseConversion(expr)) {
    try {
      onBusy(true)
      const line = await fetchRate({ amount: "1", from: rate.from, to: rate.to }, needRefresh)
      if (!line) return null
      // Same compound-unit guard as the evaluated path: a rate line that
      // carries a unit the pair never named is qalc decomposing a word.
      if (line.includes("·")) return null
      ratesLastRefresh = Date.now()
      return {
        title: line,
        description: raw,
        icon: "accessories-calculator",
        category: "calc",
        run: () => {
          copy(line)
          return true
        },
      }
    } catch (e) {
      ignore("qalc rate", e)
      return null
    } finally {
      onBusy(false)
    }
  }

  try {
    onBusy(true)
    const conv = parseConversion(expr)
    const res = await run(["qalc", ...(needRefresh ? ["-e"] : []), "-t", expr], {
      timeoutMs: needRefresh ? get<number>("currency.timeoutMs", 6000) : timeoutMs,
    })
    const answer = res.stdout.trim()
    if (res.exit !== 0 || !answer) return null
    // qalc -t emits a single line; guard against noisy multi-line fallbacks.
    const firstLine = answer.split("\n")[0].trim()
    if (!firstLine) return null
    if (isEcho(firstLine, expr)) return null
    // A conversion whose ANSWER is a compound unit the question never named is
    // qalc decomposing words it does not know (`10 Usd To Cad` → `TB·€²`, `you
    // to cat` → `B·t`). A legitimate compound target says so in the query.
    if (firstLine.includes("·") && !/[·*]/.test(conv?.from ?? "") && !/[·*]/.test(conv?.to ?? "")) {
      log(`calc: qalc read "${expr}" as a compound unit`)
      return null
    }
    if (needRefresh) ratesLastRefresh = Date.now()

    // A conversion qalc only half-read is not an answer: verify it before it
    // reaches the list (see `targetApplied`).
    if (conv && !(await targetApplied(conv, firstLine, timeoutMs))) {
      log(`calc: qalc ignored the target on "${expr}"`)
      return null
    }

    // For currency conversions, also show the per-unit rate as the description.
    let description = raw
    if (looksMonetary && conv) {
      const rate = await fetchRate(conv, needRefresh)
      if (rate) description = `${rate}  (${raw})`
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
