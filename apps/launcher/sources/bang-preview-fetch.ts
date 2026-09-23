/**
 * Bang previews — the transport half: run a plan's requests in process, cache
 * the rows, and degrade to the bang's own row when anything fails.
 *
 * The HTTP is `Soup-3.0` in gjs: no subprocess, so an enriched bang spends no
 * spawn budget on a keystroke, and the fetch rides the async slot calc already
 * uses (the combiner's debounce, its `onBusy` spinner bracket and its
 * latest-query guard — see `../combiner.ts`). The session is built on the
 * first fetch, never at module scope, and one request times out at
 * `REQUEST_TIMEOUT_S`; a query change cancels the request it superseded.
 *
 * DEGRADATION: the promise always RESOLVES, and an empty batch is the failure
 * answer — the combiner then keeps the bang's own row, which is the row the
 * bang showed before previews existed. The reason is logged and kept for
 * `launcher debug preview` (`../commands.ts`); the card has no status line and
 * shows no error row.
 *
 * CACHING: per process, keyed on the source and the case-folded argument
 * (`./bang-preview.ts` owns the key, the per-source TTL and the
 * transient-vs-definitive rule). A second request for a key already in flight
 * shares that promise instead of firing again, so typing back and forth over
 * one word does not refetch it. Only an ANSWER is cached: rows for their
 * source's TTL, a definite negative (a 404/410, or a payload that names
 * nothing) for `DEFINITIVE_NEGATIVE_TTL_MS`. A TRANSIENT failure — a timeout, a
 * socket error, a 5xx, a 429, a body that did not parse — is cached for
 * nothing, so a network spike cannot hide the preview for the rest of the
 * minute and the next attempt retries.
 *
 * The rows: item 0 of a preview KEEPS the bang's own title and Enter target —
 * the bang's identity and what Enter does are unchanged — and only its
 * description carries the payload. Items 1.. become rows beneath it, each
 * opening the browser at that item.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Soup from "gi://Soup"
import { bytesToUtf8 } from "@common/fs/bytes"
import { ignore } from "@common/log/logger"
import { log } from "../log"
import type { Result } from "../types"
import {
  classifyStatus,
  DEFINITIVE_NEGATIVE_TTL_MS,
  type EnrichKind,
  greedyDefineItems,
  type InstalledIndex,
  type PreviewItem,
  type PreviewOutcomeKind,
  previewArgs,
  previewCacheKey,
  previewPlan,
  previewTimeoutS,
  previewTtlFor,
  previewWordCount,
} from "./bang-preview"
import { xdgOpenRow } from "./xdg-row"

/** The user agent every preview request carries. The scraped results page is
 *  the one source that answers a crawler UA with a consent or bot page, so it
 *  sends a browser-shaped one instead (`BROWSER_UA`). */
const PREVIEW_UA = "tinshell-launcher-preview/1.0"
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
/** A plan's requests are sequential and few (one per source, two for the wiki
 *  and the dictionary); the cap keeps a malformed plan from looping. */
const MAX_REQUESTS = 3
const CACHE_MAX = 200
const RECENT_MAX = 20
const PACMAN_LOCAL_DB = "/var/lib/pacman/local"

interface CacheEntry {
  at: number
  items: PreviewItem[]
  /** How long THIS entry stays valid — a source's TTL for rows, the definite
   *  negative TTL for a 404 or an empty answer. A transient failure is never
   *  stored, so it has no entry to carry one. */
  ttlMs: number
}

let session: Soup.Session | null = null
let installedCache: InstalledIndex | null = null

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<PreviewItem[] | null>>()
const recent: PreviewOutcome[] = []

let current: Gio.Cancellable | null = null
let seq = 0
let busyDepth = 0

export interface PreviewOutcome {
  key: string
  outcome: "rows" | "empty" | "error"
  /** Whether the answer is definitive (cached) or a transient condition (the
   *  next attempt retries) — the split `launcher debug preview` reads back. */
  kind: PreviewOutcomeKind
  reason: string
  at: number
}

export interface PreviewRequest {
  kind: EnrichKind
  arg: string
  /** The row the bang produces today: the enriched row keeps its title and its
   *  Enter target. */
  title: string
  target: string
  icon: string
  onBusy: (busy: boolean) => void
}

function soupSession(): Soup.Session {
  if (!session) {
    session = new Soup.Session()
    session.user_agent = PREVIEW_UA
  }
  return session
}

/** A non-2xx answer, carried as a status so the caller can tell a DEFINITE
 *  negative (404/410) from a transient condition (5xx, 429, …). */
class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

/** One GET, resolved with its body. A non-2xx status and a transport failure
 *  both reject — the caller turns either into the empty batch. */
function fetchText(url: string, kind: EnrichKind, cancellable: Gio.Cancellable): Promise<string> {
  return new Promise((resolve, reject) => {
    const msg = Soup.Message.new("GET", url)
    if (!msg) {
      reject(new Error(`unusable url: ${url}`))
      return
    }
    // One session, one timeout, set per request from the source's own class
    // (`previewTimeoutS`): the fetches are sequential, so this is the request's
    // budget and not a race with a sibling.
    soupSession().timeout = previewTimeoutS(kind)
    msg.request_headers.append("Accept", kind === "youtube" ? "text/html" : "application/json")
    if (kind === "youtube") msg.request_headers.append("User-Agent", BROWSER_UA)
    soupSession().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (sess, res) => {
      try {
        if (!sess) {
          reject(new Error("no session"))
          return
        }
        const bytes = sess.send_and_read_finish(res)
        // The installed libsoup typelib's Status enum has no 429, so reading a
        // rate-limited response THROWS in gjs. An unreadable status is a
        // transient condition like any other, and the reason names the likely
        // cause rather than the enum error.
        let status = 0
        try {
          status = Number(msg.get_status())
        } catch {
          reject(new Error("HTTP status outside the libsoup Status enum (likely 429 rate limit)"))
          return
        }
        if (status < 200 || status >= 300) {
          reject(new HttpStatusError(status))
          return
        }
        resolve(bytesToUtf8(bytes.get_data()))
      } catch (e) {
        reject(e as Error)
      }
    })
  })
}

/** The installed package versions, from the local pacman database: the
 *  directory name of each entry is `<name>-<version>-<release>`. Read once per
 *  process, and only for a package preview. */
function installedPackages(): InstalledIndex {
  if (installedCache) return installedCache
  const index: InstalledIndex = {}
  try {
    const dir = Gio.File.new_for_path(PACMAN_LOCAL_DB)
    const children = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    let info: Gio.FileInfo | null = children.next_file(null)
    while (info !== null) {
      const name = info.get_name()
      const release = name.lastIndexOf("-")
      const version = name.lastIndexOf("-", release - 1)
      if (version > 0) index[name.slice(0, version)] = name.slice(version + 1)
      info = children.next_file(null)
    }
    children.close(null)
  } catch (e) {
    // A missing or unreadable database costs the installed line, not the row.
    ignore("launcher preview: pacman local db", e)
  }
  installedCache = index
  return index
}

function cacheGet(key: string): PreviewItem[] | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > entry.ttlMs) {
    cache.delete(key)
    return null
  }
  return entry.items
}

function cacheSet(key: string, items: PreviewItem[], ttlMs: number): void {
  if (!cache.has(key) && cache.size >= CACHE_MAX) {
    let oldestKey: string | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [k, entry] of cache) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at
        oldestKey = k
      }
    }
    if (oldestKey) cache.delete(oldestKey)
  }
  cache.set(key, { at: Date.now(), items, ttlMs })
}

/** The spinner brackets the fetch the way the qalc source brackets its own,
 *  but counted: a superseded request may settle after its successor started,
 *  and only the LAST one in flight ends the wait. */
function bracketOpen(onBusy: (busy: boolean) => void): void {
  busyDepth++
  onBusy(true)
}

function bracketClose(onBusy: (busy: boolean) => void): void {
  busyDepth = Math.max(0, busyDepth - 1)
  if (busyDepth === 0) onBusy(false)
}

function record(
  key: string,
  outcome: PreviewOutcome["outcome"],
  kind: PreviewOutcomeKind,
  reason: string,
): void {
  recent.unshift({ key, outcome, kind, reason, at: Date.now() })
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX
}

/** The rows a preview batch contributes: the enriched bang row first, then the
 *  payload's other items. Every one of them is a PREVIEW row, the kind the
 *  launcher gives a second description line (`../row-caps.ts`). */
function rows(items: PreviewItem[], o: PreviewRequest): Result[] {
  if (items.length === 0) return []
  const [primary, ...rest] = items
  return [
    xdgOpenRow({
      target: o.target,
      title: o.title,
      tag: "bangs",
      description: primary.description,
      icon: o.icon,
      category: "bang",
      preview: true,
    }),
    ...rest.map((item) =>
      xdgOpenRow({
        target: item.url,
        title: item.title,
        tag: "bangs",
        description: item.description,
        icon: o.icon,
        category: "bang",
        preview: true,
      }),
    ),
  ]
}

/** Drop the in-flight preview: the card hid, or a newer query superseded it. */
export function cancelPreviews(): void {
  current?.cancel()
  current = null
  seq++
}

/**
 * One word's rows: the plan's staged requests, the cache read and write, and
 * the outcome record. A cached entry (rows or a definite negative) answers
 * without a request; a word already in flight is awaited rather than refetched.
 */
async function fetchWord(
  kind: EnrichKind,
  word: string,
  cancellable: Gio.Cancellable,
  myseq: number,
): Promise<PreviewItem[] | null> {
  const plan = previewPlan(kind, word)
  if (!plan) return null
  const key = previewCacheKey(kind, word)

  const cached = cacheGet(key)
  if (cached) {
    const cachedKind: PreviewOutcomeKind = cached.length > 0 ? "rows" : "definitive-negative"
    record(key, cached.length > 0 ? "rows" : "empty", cachedKind, "cached")
    return cached
  }
  const pending = inflight.get(key)
  if (pending) return pending

  const run = (async (): Promise<PreviewItem[] | null> => {
    try {
      const payloads: string[] = []
      for (let i = 0; i < MAX_REQUESTS; i++) {
        const url = plan.next(payloads)
        if (!url) break
        payloads.push(await fetchText(url, kind, cancellable))
      }
      const items = plan.items(payloads, kind === "archpackage" ? installedPackages() : {})
      if (items === null) {
        // A payload that did not parse is a condition, not an answer: the body
        // is more likely a throttle or an error page than the source's verdict.
        record(key, "error", "transient", `unreadable ${kind} payload`)
        return null
      }
      const ttl = previewTtlFor(kind, items.length > 0 ? "rows" : "definitive-negative")
      if (ttl !== null) cacheSet(key, items, ttl)
      record(
        key,
        items.length > 0 ? "rows" : "empty",
        items.length > 0 ? "rows" : "definitive-negative",
        items.length > 0 ? `${items.length} row(s)` : "no match",
      )
      return items
    } catch (e) {
      // A superseded request is not a failure: the newer query owns the card.
      if (myseq === seq) {
        const reason = (e as Error).message
        // A 404 says the source has nothing for this query (cache it); a
        // timeout, a socket error, a 5xx or a 429 is a condition the next
        // attempt may well get past (cache nothing, so it does retry).
        const kindFailed: PreviewOutcomeKind =
          e instanceof HttpStatusError && classifyStatus(e.status) === "definitive"
            ? "definitive-negative"
            : "transient"
        log(`bangs: preview ${kind} "${word}": ${reason} (${kindFailed})`)
        record(key, "error", kindFailed, reason)
        if (previewTtlFor(kind, kindFailed) !== null) cacheSet(key, [], DEFINITIVE_NEGATIVE_TTL_MS)
      }
      return null
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, run)
  return run
}

/**
 * The rows for one enriched bang, or an empty batch when the payload did not
 * arrive or names nothing — the caller keeps the bang's own row then.
 *
 * A GREEDY argument (`!def archaic obsolete`, `previewArgs`) is fetched word by
 * word, SEQUENTIALLY and under this query's one cancellable: sequential keeps
 * the request rate at what the sources tolerate and preserves the typed order,
 * and one cancellable is what makes a superseding keystroke cancel the whole
 * batch rather than its first word. A word that comes back empty (no entry, a
 * transient failure) is skipped by `greedyDefineItems`, so the other words
 * still show; when every word misses, the batch is empty and today's row stays.
 */
export function previewFor(o: PreviewRequest): Promise<Result[]> {
  const words = previewArgs(o.kind, o.arg)
  if (words.length === 0) return Promise.resolve([])

  const single = words.length === 1

  current?.cancel()
  const mine = new Gio.Cancellable()
  current = mine
  const myseq = ++seq
  bracketOpen(o.onBusy)

  const run = (async (): Promise<Result[]> => {
    try {
      const perWord: (PreviewItem[] | null)[] = []
      for (const word of words) perWord.push(await fetchWord(o.kind, word, mine, myseq))
      if (myseq !== seq) return [] // superseded: the newer query owns the card
      if (single) return rows(perWord[0] ?? [], o)
      const items = greedyDefineItems(words, previewWordCount(o.kind, o.arg), perWord)
      return items.length > 0 ? greedyRows(items, o) : []
    } finally {
      if (current === mine) current = null
      bracketClose(o.onBusy)
    }
  })()
  return run
}

/** The rows a greedy batch shows: one per word, each opening that word's page
 *  (see `greedyDefineItems`) — the bang's own row is the FIRST of them, because
 *  a greedy argument has no single item for it to open. */
function greedyRows(items: PreviewItem[], o: PreviewRequest): Result[] {
  return items.map((item) =>
    xdgOpenRow({
      target: item.url,
      title: item.title,
      tag: "bangs",
      description: item.description,
      icon: o.icon,
      category: "bang",
      preview: true,
    }),
  )
}

/** The reason a preview showed nothing (or what it showed) — the debug
 *  surface's copy of a failure the card deliberately does not show. */
export function previewDebug(): string {
  return JSON.stringify({ inflight: [...inflight.keys()], cached: cache.size, recent }, null, 1)
}
