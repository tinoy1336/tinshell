/**
 * Bang previews — the payload half: which request an enriched bang makes, and
 * how the response becomes rows.
 *
 * Pure (no gi, no socket): every endpoint URL and every parser lives here, so
 * `./bang-preview.probe.ts` shapes the real response bodies of the five
 * enriched bangs without a network. The transport half is
 * `./bang-preview-fetch.ts` — the Soup session, the cache, the row mapping —
 * and it asks this module for a plan.
 *
 * A bang opts into enrichment by declaring `enrich` on its catalogue entry
 * (`./bang-token.ts`); a bang that declares none keeps the row it has today.
 * Each source is the endpoint that answers a QUERY (never one that needs a key
 * or a page the user already has):
 *   - wikipedia   `generator=search` + `exintro` answers in ONE request, but
 *                 its top hit is not always about the query (the live answer
 *                 for `greetd` is the page `Phosh`), so a hit becomes a row
 *                 only when its title names the query.
 *   - archwiki    the wiki has no page-summary handler (`/rest.php/v1/page/…/
 *                 summary` is a 404) and no `prop=extracts`; the lead section
 *                 comes from `rvsection=0` revisions, which is 905 B for
 *                 `Greetd` against 17 KB for the whole page.
 *   - wiktionary  the definition endpoint, plus Datamuse for synonyms
 *                 (Wiktionary ships no `synonyms` field).
 *   - archpackage the package JSON API, with the version installed on this
 *                 machine read from the local pacman database (the repo and the
 *                 local database genuinely differ).
 *   - aur         RPC v5 `info`, whose exact-name answer carries the votes,
 *                 popularity and maintainer the AUR page shows.
 *
 * Item 0 of a plan's rows is the ENRICHED BANG ROW: the launcher keeps the
 * bang's own title and Enter target for it, so its DESCRIPTION is what the
 * user reads. Items 1.. are the payload's other items, emitted as rows beneath
 * it, each opening the browser at that item.
 */

import { splitTranslateTarget, urlArg } from "./text-tools.ts"

/** The preview sources a catalogue entry may name. */
export type EnrichKind =
  | "wikipedia"
  | "archwiki"
  | "wiktionary"
  | "archpackage"
  | "aur"
  | "ddg"
  | "translate"
  | "youtube"

/** pkgname → the version installed here (`/var/lib/pacman/local`). */
export type InstalledIndex = Record<string, string>

/** One row a preview produces. */
export interface PreviewItem {
  title: string
  /** Item 0's description is the enriched row's summary line; a row beneath
   *  carries its own. */
  description: string
  /** The page this item opens. */
  url: string
}

/** What to request next, and what the collected payloads mean. Build one per
 *  query: the closures hold that query's own state. */ export interface PreviewPlan {
  /** The URL of the next request, given the payloads already collected — null
   *  when the plan has all it needs. A later request may depend on an earlier
   *  payload (the Arch Wiki lead needs the article title the search named). */
  next(done: string[]): string | null
  /** The rows for the payloads, or null when a payload does not parse. An
   *  empty list is a real answer: the payload names no such item. */
  items(payloads: string[], installed: InstalledIndex): PreviewItem[] | null
}

/** How much of a summary line a row keeps. The preview row's description
 *  budget is `DESC_LINES_PREVIEW` × the label's characters per line (`../
 *  row-caps.ts`: 4 × 53 = 212 at the configured width), so 200 is the length at
 *  which the CLIP starts binding instead of the line count — the row shows the
 *  whole summary rather than a sentence cut in half. */
export const MAX_SUMMARY = 200

/** How long a fetched payload stays fresh, per source. Article prose does not
 *  move; a package version does. */
const TTL_MS: Record<EnrichKind, number> = {
  wikipedia: 24 * 60 * 60 * 1000,
  archwiki: 24 * 60 * 60 * 1000,
  wiktionary: 24 * 60 * 60 * 1000,
  archpackage: 60 * 60 * 1000,
  aur: 60 * 60 * 1000,
  // The instant-answer API rate-limits bursts (measured 429s), and an answer
  // moves slowly, so this is the shortest of the long-lived entries.
  ddg: 15 * 60 * 1000,
  // A translation of a fixed string does not change.
  translate: 6 * 60 * 60 * 1000,
  // The results page is scraped, so its answer is cached long: one request per
  // settled query, and a day of reuse for a query already answered.
  youtube: 24 * 60 * 60 * 1000,
}

/**
 * One request's budget, per source class. Measured medians: the synonym and
 * dictionary endpoints 0.09-0.23 s, the Wikipedia summary ~0.19 s, the Arch
 * wiki/package/AUR endpoints up to ~1.0 s with a 10.18 s tail. Each class is
 * set well above its own p95 so a slow-but-alive source is never cut off, and
 * a genuinely stuck one still gives up.
 */
const TIMEOUT_S: Record<EnrichKind, number> = {
  wiktionary: 3,
  ddg: 3,
  translate: 3,
  wikipedia: 4,
  archwiki: 8,
  archpackage: 8,
  aur: 8,
  youtube: 8,
}

export function previewTimeoutS(kind: EnrichKind): number {
  return TIMEOUT_S[kind]
}

export function previewTtlMs(kind: EnrichKind): number {
  return TTL_MS[kind]
}

/** How long a DEFINITE negative stays cached: an answer that will be the same
 *  next time (a 404, or a payload that names nothing). */
export const DEFINITIVE_NEGATIVE_TTL_MS = 60_000

/** What one preview attempt produced — the three cases the cache policy
 *  separates (`previewTtlFor`). */
export type PreviewOutcomeKind = "rows" | "definitive-negative" | "transient"

/**
 * A non-success HTTP status as a kind of failure: a 404 or a 410 is an ANSWER
 * (the source has nothing for this query and will say so again), while a 5xx, a
 * 429 or any other unexpected status is a CONDITION that may be over by the next
 * attempt.
 */
export function classifyStatus(status: number): "definitive" | "transient" {
  return status === 404 || status === 410 ? "definitive" : "transient"
}

/**
 * How long an attempt's result may stay cached, or null when it must not be
 * cached at all.
 *
 * Rows keep their source's TTL and a definite negative keeps
 * `DEFINITIVE_NEGATIVE_TTL_MS`, but a TRANSIENT failure — a timeout, a socket
 * error, a 5xx, a 429, a payload that did not parse — is cached for nothing: a
 * one-off network spike must not hide the preview for the rest of the minute,
 * so the user's next attempt on the same query retries it.
 */
export function previewTtlFor(kind: EnrichKind, outcome: PreviewOutcomeKind): number | null {
  if (outcome === "transient") return null
  return outcome === "rows" ? previewTtlMs(kind) : DEFINITIVE_NEGATIVE_TTL_MS
}

/** The cache key of one query: the source plus the argument case-folded and
 *  whitespace-collapsed, so `!AW Greetd` and `!aw  greetd` share an entry. */
export function previewCacheKey(kind: EnrichKind, arg: string): string {
  return `${kind}:${arg.trim().toLowerCase().replace(/\s+/g, " ")}`
}

/** How many words a greedy `!def` defines in one query. Five is what one
 *  keypress should cost: each word is up to two sequential requests under the
 *  query's one cancellable, and the list SCROLLS (`listHeight`) instead of
 *  being cut, so a longer answer stays readable. */
export const DEFINE_WORD_CAP = 5

/** The units one preview fetch works in — the per-word CACHE KEYS.
 *
 *  Wiktionary's bang takes EVERYTHING typed after the token and defines each
 *  word (`!def archaic obsolete`), so the argument is split once, here, and
 *  every other module reads the units from this function: the runtime fetches
 *  and caches per word (so `!def archaic obsolete` after `!def archaic` costs
 *  one new word), and the catalogue builds the row title from the same units.
 *
 *  Words are separated by whitespace, commas or semicolons; each unit is
 *  trimmed of surrounding punctuation (a hyphen INSIDE a word is part of it —
 *  `well-being`), empty units are dropped and units are de-duplicated
 *  case-insensitively (the first spelling wins, so `Archaic archaic` is one
 *  lookup). The result is capped at `DEFINE_WORD_CAP`; `previewWordCount`
 *  answers how many were typed, and the first row reports the overflow rather
 *  than dropping it silently. Every other source takes its argument whole.
 */
export function previewArgs(kind: EnrichKind, arg: string): string[] {
  if (kind !== "wiktionary") return arg.trim() ? [arg.trim()] : []
  return splitWords(arg).slice(0, DEFINE_WORD_CAP)
}

/** How many distinct words the argument names, BEFORE the cap — what a capped
 *  greedy row reports against. */
export function previewWordCount(kind: EnrichKind, arg: string): number {
  if (kind !== "wiktionary") return arg.trim() ? 1 : 0
  return splitWords(arg).length
}

/** The ONE word splitter: whitespace, commas and semicolons separate; each unit
 *  is trimmed of surrounding punctuation (a hyphen inside a word is part of
 *  it — `well-being`); empty units are dropped and units are de-duplicated
 *  case-insensitively, the first spelling winning. */
function splitWords(arg: string): string[] {
  const seen = new Set<string>()
  const words: string[] = []
  for (const raw of arg.split(/[\s,;]+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    if (!word) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    words.push(word)
  }
  return words
}

/**
 * The rows a GREEDY `!def` shows: one row per word, in the order typed, each
 * carrying that word's first sense and opening that word's Wiktionary page.
 *
 * A word the payloads do not have (no English entry, a failed fetch) is
 * SKIPPED, so one miss cannot take the other words' rows with it; when every
 * word missed, the result is empty and the caller keeps the bang's own row.
 * `typed` is how many words the user typed, so a row that survived the cap says
 * how many were answered.
 */
export function greedyDefineItems(
  words: string[],
  typed: number,
  perWord: (PreviewItem[] | null)[],
): PreviewItem[] {
  const items: PreviewItem[] = []
  for (let i = 0; i < words.length; i++) {
    const first = perWord[i]?.[0]
    if (!first) continue
    items.push({
      title: `Define: ${words[i]}`,
      description: first.description,
      url: first.url,
    })
  }
  if (items.length > 0 && words.length < typed) {
    items[0] = {
      ...items[0],
      description: `${items[0].description} · ${words.length} of ${typed} words`,
    }
  }
  return items
}

// ── endpoints ─────────────────────────────────────────────

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
const ARCHWIKI_API = "https://wiki.archlinux.org/api.php"
const WIKTIONARY_API = "https://en.wiktionary.org/api/rest_v1/page/definition/"
const DATAMUSE_API = "https://api.datamuse.com/words"
const ARCH_PACKAGE_API = "https://archlinux.org/packages/search/json/"
const AUR_INFO_API = "https://aur.archlinux.org/rpc/v5/info"

const WIKIPEDIA_ARTICLE = "https://en.wikipedia.org/wiki/"
const ARCHWIKI_ARTICLE = "https://wiki.archlinux.org/title/"
const WIKTIONARY_PAGE = "https://en.wiktionary.org/wiki/"
const ARCH_PACKAGE_PAGE = "https://archlinux.org/packages/"
const AUR_PACKAGE_PAGE = "https://aur.archlinux.org/packages/"

/** An article title as a page name: spaces are underscores, everything else is
 *  one URL component. */
function pageName(title: string): string {
  return urlArg(title.trim().replace(/\s+/g, "_"))
}

function wikipediaSearchUrl(q: string): string {
  return (
    `${WIKIPEDIA_API}?action=query&format=json&generator=search` +
    `&gsrsearch=${urlArg(q)}&gsrlimit=5&prop=extracts&exintro=1&explaintext=1` +
    `&exsentences=2&redirects=1`
  )
}

function translateUrl(arg: string): string | null {
  const { text, target } = splitTranslateTarget(arg)
  return text.trim()
    ? `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${urlArg(target)}&dt=t&q=${urlArg(text)}`
    : null
}

function youtubeSearchUrl(q: string): string {
  return `https://www.youtube.com/results?search_query=${urlArg(q)}`
}

function ddgUrl(q: string): string {
  return `https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${urlArg(q)}`
}

function archWikiSearchUrl(q: string): string {
  return `${ARCHWIKI_API}?action=query&format=json&list=search&srsearch=${urlArg(q)}&srlimit=1`
}

function archWikiLeadUrl(title: string): string {
  return (
    `${ARCHWIKI_API}?action=query&format=json&prop=revisions&rvprop=content` +
    `&rvslots=main&rvsection=0&titles=${urlArg(title)}&redirects=1`
  )
}

function wiktionaryDefinitionUrl(word: string): string {
  return `${WIKTIONARY_API}${urlArg(word)}`
}

function datamuseSynonymsUrl(word: string): string {
  return `${DATAMUSE_API}?rel_syn=${urlArg(word)}&max=8`
}

function archPackageSearchUrl(q: string): string {
  return `${ARCH_PACKAGE_API}?q=${urlArg(q)}&limit=8`
}

function aurInfoUrl(name: string): string {
  // The argument is a bracketed array parameter, so the brackets are encoded
  // (`arg[]=yay`).
  return `${AUR_INFO_API}?arg%5B%5D=${urlArg(name)}`
}

/**
 * The plan for one enriched bang and one argument, or null when the argument
 * names nothing (an empty argument produces no row at all, so it produces no
 * preview either).
 */
export function previewPlan(kind: EnrichKind, arg: string): PreviewPlan | null {
  const q = arg.trim()
  if (!q) return null
  switch (kind) {
    case "translate": {
      const url = translateUrl(q)
      return {
        next: (done) => (done.length === 0 ? url : null),
        items: (payloads) => (url === null ? [] : parseTranslate(payloads[0] ?? "")),
      }
    }
    case "youtube":
      return {
        next: (done) => (done.length === 0 ? youtubeSearchUrl(q) : null),
        items: (payloads) => parseYoutube(payloads[0] ?? ""),
      }
    case "ddg":
      return {
        next: (done) => {
          if (done.length === 0) return ddgUrl(q)
          // No instant answer: the title-guarded Wikipedia search answers.
          if (done.length === 1 && (parseDdg(done[0]) ?? []).length === 0) {
            return wikipediaSearchUrl(q)
          }
          return null
        },
        items: (payloads) => {
          const answered = parseDdg(payloads[0] ?? "")
          if (answered && answered.length > 0) return answered
          return payloads[1] === undefined ? [] : parseWikipedia(payloads[1], q)
        },
      }
    case "wikipedia":
      return {
        next: (done) => (done.length === 0 ? wikipediaSearchUrl(q) : null),
        items: (payloads) => parseWikipedia(payloads[0] ?? "", q),
      }
    case "archwiki":
      return {
        next: (done) => {
          if (done.length === 0) return archWikiSearchUrl(q)
          if (done.length === 1) {
            const title = archWikiSearchTitle(done[0])
            return title ? archWikiLeadUrl(title) : null
          }
          return null
        },
        items: (payloads) => parseArchWiki(payloads[0] ?? "", payloads[1]),
      }
    case "wiktionary":
      return {
        next: (done) =>
          done.length === 0
            ? wiktionaryDefinitionUrl(q)
            : done.length === 1
              ? datamuseSynonymsUrl(q)
              : null,
        items: (payloads) => parseWiktionary(payloads[0] ?? "", payloads[1], q),
      }
    case "archpackage":
      return {
        next: (done) => (done.length === 0 ? archPackageSearchUrl(q) : null),
        items: (payloads, installed) => parseArchPackages(payloads[0] ?? "", q, installed),
      }
    case "aur":
      return {
        next: (done) => (done.length === 0 ? aurInfoUrl(q) : null),
        items: (payloads) => parseAur(payloads[0] ?? "", q),
      }
  }
}

// ── text helpers ──────────────────────────────────────────

/** A value from a parsed payload as text; anything else is "". */
function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** A value from a parsed payload as a finite number, or null. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Collapse whitespace and cut to `max` at a word boundary (an ellipsis marks
 *  the cut). */
function clip(text: string, max = MAX_SUMMARY): string {
  const single = text.replace(/\s+/g, " ").trim()
  if (single.length <= max) return single
  const cut = single.slice(0, max)
  const space = cut.lastIndexOf(" ")
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

/**
 * An article extract as prose: the headword's pronunciation and audio glosses,
 * the citation brackets and a leading hatnote out. Wikipedia puts the
 * pronunciation right after the headword (`Arthropods ( AR-thrə-pod) are …`),
 * which is exactly where a one- or two-line row spends its first characters.
 */
function proseOf(text: string): string {
  const withoutGlosses = text.replace(/\(([^()]*)\)/g, (match, inner: string) =>
    isGloss(inner) ? " " : match,
  )
  return withoutGlosses
    .replace(/\[\d+\]/g, " ")
    .replace(/^(?:For [^.]*see [^.]*\.|This article is about [^.]*\.)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** A parenthetical that carries no prose: an audio or pronunciation cue, an
 *  IPA form between slashes, IPA characters, or a hyphenated syllable spelling
 *  of the headword (`AR-thrə-pod`). */
function isGloss(inner: string): boolean {
  const s = inner.trim()
  if (!s) return false
  if (/^(listen|help|info|audio|pronounced|pronunciation)$/i.test(s)) return true
  if (/^\/.*\/$/.test(s)) return true
  if (/[ˈˌːəɪʊɒθðʃʒŋɐɔɛ]/.test(s)) return true
  return /^[A-Za-z][A-Za-z'-]*(?:-[A-Za-z'-]+)+$/.test(s)
}

/** Definition text ships as HTML (`<a>` links, usage labels), so a row needs
 *  the text out of it. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codepoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codepoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim()
}

function codepoint(value: number): string {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : ""
}

/** A Wikitext lead section as prose: templates, categories, interlanguage
 *  links, files, references and the emphasis marks out; link labels, external
 *  link labels and plain text in. */
function stripWikitext(wikitext: string): string {
  let out = wikitext
  out = out.replace(/<!--[\s\S]*?-->/g, "")
  out = out.replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
  out = out.replace(/<[^>]*>/g, "")
  // Templates nest: strip the innermost ones until nothing changes.
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/\{\{[^{}]*\}\}/g, "")
    if (next === out) break
    out = next
  }
  // `[[Category:…]]`, `[[File:…]]` and the interlanguage `[[de:Greetd]]` all
  // carry a namespace colon; a plain article link does not.
  out = out.replace(/\[\[[A-Za-z][A-Za-z0-9 _-]*:[^\]|]*(\|[^\]]*)?\]\]/g, " ")
  out = out.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
  out = out.replace(/\[\[([^\]]*)\]\]/g, "$1")
  out = out.replace(/\[https?:\/\/\S+ ([^\]]*)\]/g, "$1")
  out = out.replace(/\[https?:\/\/\S+\]/g, "")
  out = out.replace(/'''?/g, "")
  return out.replace(/\s+/g, " ").trim()
}

/**
 * Does a search hit's title name the query?
 *
 * WORD-WISE, not substring: `generator=search` answers a multi-word query with
 * pages whose titles rarely contain the query's characters contiguously
 * (`rust ownership` ranks `Rust (programming language)`, `kernel linux` ranks
 * `Linux kernel`), and a folded-containment test rejected both while it also
 * MIS-accepted a shorter unrelated title whose letters happened to sit inside
 * the query (`kernel linux` accepted `Linux`). The test here compares the
 * title's significant words against the query's:
 *
 *   - a word is significant when it is not a stopword and is at least two
 *     characters long; a title's trailing parenthetical is a disambiguator
 *     (`Rust (programming language)`) and is scored on its own, not as part of
 *     the name — the parenthetical is what relates `Spiracle (arthropods)` to
 *     the query `arthropods`, and the name is what relates
 *     `Rust (programming language)` to `rust ownership`;
 *   - two words MATCH when they are equal, or one is a prefix of the other with
 *     the shorter at least four characters (plural and typo tolerance);
 *   - `recall` is the share of the query's words the title covers, `cover` the
 *     share of the title's words the query names, and the hit qualifies when
 *     `max(recall, cover)` reaches `TITLE_MATCH_THRESHOLD` over the NAME or over
 *     the parenthetical — so a title the query fully names qualifies at any
 *     query length, and a query that names the whole title qualifies even when
 *     the title is one word of several.
 *
 * The unrelated `Phosh` for `greetd` shares no word, so it scores zero and is
 * still refused. A query with no significant word left (`!wiki the`) falls back
 * to folded equality.
 */
function titleNamesQuery(title: string, query: string): boolean {
  const titleWords = significantWords(title)
  const queryWords = significantWords(query)
  if (titleWords.length === 0 || queryWords.length === 0) {
    const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
    return fold(title) !== "" && fold(title) === fold(query)
  }
  // The title's own name, then the disambiguating parenthetical on its own:
  // `Rust (programming language)` is named by `rust ownership` through the
  // name, and `Spiracle (arthropods)` is related to `arthropods` through the
  // parenthetical alone.
  const qualifier = significantWords(title, false).filter((w) => !titleWords.includes(w))
  return scores(titleWords, queryWords) || scores(qualifier, queryWords)
}

/** Does one side cover the other well enough to count as the same page?
 *  `recall` is the share of the query's words this side matches, `cover` the
 *  share of this side's words the query names. */
function scores(titleWords: string[], queryWords: string[]): boolean {
  if (titleWords.length === 0) return false
  const matchedQuery = queryWords.filter((q) => titleWords.some((t) => wordsMatch(t, q))).length
  const matchedTitle = titleWords.filter((t) => queryWords.some((q) => wordsMatch(t, q))).length
  const recall = matchedQuery / queryWords.length
  const cover = matchedTitle / titleWords.length
  return Math.max(recall, cover) >= TITLE_MATCH_THRESHOLD
}

/** How much of a title or a query has to be matched by the other side for a
 *  search hit to count as the page the user asked for. */
const TITLE_MATCH_THRESHOLD = 0.5

/** Words a title's or a query's words are compared on: case-folded, split on
 *  anything that is not a letter or a digit, stopwords and one-character words
 *  dropped. Only a TITLE's trailing parenthetical is removed — a query's
 *  parentheses may be part of what the user is looking for. */
function significantWords(text: string, stripParenthetical = true): string[] {
  const named = stripParenthetical ? text.replace(/\s*\([^()]*\)\s*$/, "") : text
  return named
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "vs",
  "with",
])

/** Two words name the same thing: equal, or one a prefix of the other when the
 *  shorter is long enough that the prefix is not a coincidence. */
function wordsMatch(titleWord: string, queryWord: string): boolean {
  if (titleWord === queryWord) return true
  const shorter = titleWord.length <= queryWord.length ? titleWord : queryWord
  const longer = titleWord.length <= queryWord.length ? queryWord : titleWord
  return shorter.length >= 4 && longer.startsWith(shorter)
}

// ── parsers ───────────────────────────────────────────────

/** Hits of a `query.pages` map, in the order the API ranked them. */
function pagesOf(payload: string): { title: string; extract: string; index: number }[] {
  const query = record(record(parseJson(payload))?.query)
  const pages = query ? record(query.pages) : null
  if (!pages) return []
  const hits: { title: string; extract: string; index: number }[] = []
  for (const page of Object.values(pages)) {
    const p = record(page)
    if (!p) continue
    hits.push({ title: str(p.title), extract: str(p.extract), index: num(p.index) ?? hits.length })
  }
  return hits.sort((a, b) => a.index - b.index)
}

function parseWikipedia(payload: string, q: string): PreviewItem[] | null {
  const hits = pagesOf(payload)
  if (hits.length === 0) return null
  const related = hits.filter((h) => h.title && h.extract && titleNamesQuery(h.title, q))
  if (related.length === 0) return []
  return related.map((h) => ({
    title: `Wikipedia — ${h.title}`,
    // The row's own title already names the page, so the description carries
    // the extract alone — no repeated headword, no pronunciation gloss.
    description: clip(proseOf(h.extract)),
    url: WIKIPEDIA_ARTICLE + pageName(h.title),
  }))
}

/**
 * The unofficial gtx endpoint's answer: `[[[translated, original, …], …], …]`.
 * The endpoint is undocumented and unversioned, so every step of the shape is
 * checked and anything unexpected answers [] — a shape change must degrade to
 * the bang's plain row, never throw into the query path.
 */
function parseTranslate(payload: string): PreviewItem[] | null {
  const root = parseJson(payload)
  if (!Array.isArray(root) || !Array.isArray(root[0])) return null
  const parts: string[] = []
  for (const segment of root[0]) {
    if (!Array.isArray(segment)) continue
    const piece = str(segment[0]).trim()
    if (piece) parts.push(piece)
  }
  const translated = parts.join(" ").trim()
  if (!translated) return []
  return [{ title: "Translation", description: clip(translated), url: "" }]
}

/** How much of the results page the scraper reads, and how many entries it may
 *  take from it: the embedded payload is bounded and the row count is capped,
 *  so a longer page costs nothing beyond this window. */
const YOUTUBE_SCAN_CHARS = 900_000
const YOUTUBE_MAX_ITEMS = 3

/**
 * The video results embedded in the results page. The page carries ONE
 * `ytInitialData` payload; the scan starts at it, walks `videoRenderer` entries
 * and reads each title from a bounded window after its id. A page whose shape
 * moved on answers [] (no rows, so the bang keeps its own row) rather than
 * throwing — scraping is the fragility this accepts.
 */
function parseYoutube(payload: string): PreviewItem[] | null {
  const start = payload.indexOf("ytInitialData")
  if (start < 0) return []
  const window = payload.slice(start, start + YOUTUBE_SCAN_CHARS)
  const entry = /\{"videoRenderer":\{"videoId":"([\w-]{11})"/g
  const items: PreviewItem[] = []
  for (const match of window.matchAll(entry)) {
    const id = match[1]
    const after = window.slice(match.index ?? 0, (match.index ?? 0) + 4000)
    const title = /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(after)
    if (!title) continue
    const text = clip(title[1].replace(/\\"/g, '"').replace(/\\u0026/g, "&"), 90)
    if (!text) continue
    items.push({
      title: text,
      description: `youtube.com/watch?v=${id}`,
      url: `https://www.youtube.com/watch?v=${id}`,
    })
    if (items.length >= YOUTUBE_MAX_ITEMS) break
  }
  return items
}

/**
 * The DuckDuckGo Instant Answer: the abstract, the answer or the definition,
 * then the related topics that carry their own first URL. An EMPTY answer is
 * ordinary — the API answers only some queries — and the plan then falls back
 * to the guarded Wikipedia search.
 */
function parseDdg(payload: string): PreviewItem[] | null {
  const root = record(parseJson(payload))
  if (!root) return null
  const text = [str(root.AbstractText), str(root.Answer), str(root.Definition)]
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  const items: PreviewItem[] = []
  if (text) {
    items.push({
      title: str(root.Heading) || "Instant answer",
      description: clip(proseOf(text)),
      url: str(root.AbstractURL),
    })
  }
  const related = Array.isArray(root.RelatedTopics) ? root.RelatedTopics : []
  for (const entry of related) {
    const topic = record(entry)
    const text = topic ? str(topic.Text) : ""
    const url = topic ? str(topic.FirstURL) : ""
    if (!text || !url) continue
    items.push({ title: `Related — ${clip(text, 60)}`, description: clip(proseOf(text)), url })
    if (items.length >= 3) break
  }
  return items
}

/** The article title a wiki search names, or null. */
function archWikiSearchTitle(payload: string): string | null {
  const query = record(record(parseJson(payload))?.query)
  const list = query?.search
  if (!Array.isArray(list) || list.length === 0) return null
  const first = record(list[0])
  return first ? str(first.title) || null : null
}

/** The lead-section wikitext of the `rvsection=0` answer, as prose. */
function archWikiLead(payload: string): string | null {
  const query = record(record(parseJson(payload))?.query)
  const pages = query ? record(query.pages) : null
  if (!pages) return null
  for (const page of Object.values(pages)) {
    const revisions = record(page)?.revisions
    if (!Array.isArray(revisions) || revisions.length === 0) continue
    const slots = record(record(revisions[0])?.slots)
    const main = slots ? record(slots.main) : null
    const prose = stripWikitext(main ? str(main["*"]) : "")
    if (prose) return prose
  }
  return null
}

function parseArchWiki(
  searchPayload: string,
  leadPayload: string | undefined,
): PreviewItem[] | null {
  const title = archWikiSearchTitle(searchPayload)
  // The lead is a second request; without it there is no article to describe,
  // so the bang keeps the row it has today.
  if (!title || leadPayload === undefined) return []
  const lead = archWikiLead(leadPayload)
  if (!lead) return []
  return [
    {
      title: `ArchWiki — ${title}`,
      // The row's own title names the article, so the description carries the
      // lead alone.
      description: clip(proseOf(lead)),
      url: ARCHWIKI_ARTICLE + pageName(title),
    },
  ]
}

/** The synonyms Datamuse ranks for a word, best first. */
function parseDatamuse(payload: string): string[] {
  const data = parseJson(payload)
  if (!Array.isArray(data)) return []
  const words: string[] = []
  for (const entry of data) {
    const word = record(entry) ? str(record(entry)?.word) : ""
    if (word) words.push(word)
  }
  return words
}

function parseWiktionary(
  defPayload: string,
  synPayload: string | undefined,
  word: string,
): PreviewItem[] | null {
  const root = record(parseJson(defPayload))
  if (!root) return null
  // The payload is keyed by language; English is the one the bang asks for,
  // and a word with no English entry answers an empty list.
  const blocks = Array.isArray(root.en) ? root.en : []
  const items: PreviewItem[] = []
  for (const block of blocks) {
    const b = record(block)
    if (!b) continue
    const pos = str(b.partOfSpeech)
    const definitions = Array.isArray(b.definitions) ? b.definitions : []
    const first = definitions.map(record).find((d) => d && str(d.definition))
    const definition = first ? clip(stripHtml(str(first.definition))) : ""
    if (!pos || !definition) continue
    items.push({
      title: `${word} — ${pos.toLowerCase()}`,
      description: `${pos.toLowerCase()} — ${definition}`,
      url: `${WIKTIONARY_PAGE}${urlArg(word)}#${urlArg(pos)}`,
    })
  }
  if (items.length === 0) return []
  const synonyms = synPayload === undefined ? [] : parseDatamuse(synPayload)
  if (synonyms.length > 0) {
    items.push({
      title: `Synonyms: ${clip(synonyms.join(" · "), 120)}`,
      description: "Wiktionary · Enter opens the entry",
      url: WIKTIONARY_PAGE + urlArg(word),
    })
  }
  return items
}

function packageVersion(p: Record<string, unknown>): string {
  const version = str(p.pkgver)
  const release = str(p.pkgrel)
  if (!version) return ""
  return release ? `${version}-${release}` : version
}

function packagePage(p: Record<string, unknown>): string {
  const repo = str(p.repo) || "extra"
  const arch = str(p.arch) || "x86_64"
  return `${ARCH_PACKAGE_PAGE}${urlArg(repo)}/${urlArg(arch)}/${urlArg(str(p.pkgname))}/`
}

function packageSummary(p: Record<string, unknown>, installed: InstalledIndex): string {
  const maintainers = Array.isArray(p.maintainers) ? p.maintainers.map(str).filter(Boolean) : []
  const local = installed[str(p.pkgname)]
  return clip(
    [
      str(p.pkgdesc),
      str(p.repo),
      packageVersion(p),
      maintainers.length > 0 ? `maintainer ${maintainers.join(", ")}` : "",
      local ? `installed ${local}` : "not installed",
    ]
      .filter(Boolean)
      .join(" · "),
  )
}

function parseArchPackages(
  payload: string,
  q: string,
  installed: InstalledIndex,
): PreviewItem[] | null {
  const root = record(parseJson(payload))
  const list = root && Array.isArray(root.results) ? root.results : null
  if (!list) return null
  const hits = list
    .map(record)
    .filter((p): p is Record<string, unknown> => p !== null && str(p.pkgname) !== "")
  if (hits.length === 0) return []
  // The search is fuzzy, so the exact package the user typed wins over the
  // ranking (`q=greetd` ranks `cosmic-greeter` first).
  const wanted = q.toLowerCase()
  const chosen = hits.find((p) => str(p.pkgname).toLowerCase() === wanted) ?? hits[0]
  const items: PreviewItem[] = [
    {
      title: `Arch package — ${str(chosen.pkgname)}`,
      description: packageSummary(chosen, installed),
      url: packagePage(chosen),
    },
  ]
  for (const hit of hits.filter((p) => p !== chosen).slice(0, 2)) {
    items.push({
      title: `${str(hit.pkgname)} ${packageVersion(hit)} (${str(hit.repo)})`,
      description: clip(str(hit.pkgdesc)),
      url: packagePage(hit),
    })
  }
  return items
}

function parseAur(payload: string, q: string): PreviewItem[] | null {
  const root = record(parseJson(payload))
  const list = root && Array.isArray(root.results) ? root.results : null
  if (!list) return null
  const hits = list
    .map(record)
    .filter((p): p is Record<string, unknown> => p !== null && str(p.Name) !== "")
  if (hits.length === 0) return []
  const wanted = q.toLowerCase()
  const chosen = hits.find((p) => str(p.Name).toLowerCase() === wanted) ?? hits[0]
  const votes = num(chosen.NumVotes)
  const popularity = num(chosen.Popularity)
  const maintainer = str(chosen.Maintainer)
  return [
    {
      title: `AUR — ${str(chosen.Name)}`,
      description: clip(
        [
          str(chosen.Description),
          str(chosen.Version),
          votes === null ? "" : `${votes} ${votes === 1 ? "vote" : "votes"}`,
          popularity === null ? "" : `popularity ${popularity.toFixed(1)}`,
          maintainer ? `maintainer ${maintainer}` : "orphan",
          str(chosen.OutOfDate) ? "flagged out of date" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      url: AUR_PACKAGE_PAGE + urlArg(str(chosen.Name)),
    },
  ]
}
