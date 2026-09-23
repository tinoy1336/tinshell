/**
 * Text and data shapes — the pure value tools a launcher row is built from:
 * base64 and percent encoding, JSON, colour codes, cron expressions, JWT
 * payloads, instants, the `/etc/services` port table, and the translate
 * target a text argument may carry.
 *
 * Pure: no gi, no GTK, no config, no filesystem. The bang catalogue
 * (`./bang-token.ts`) composes these into its rows, and
 * `./text-tools.probe.ts` asserts them under plain Node. Anything a shape
 * needs from the platform arrives as a parameter, so nothing here reaches for
 * a global.
 *
 * Every parser answers `null` rather than a guess: a shape that does not parse
 * produces no row, never a plausible-looking wrong answer.
 */

// ── base64 ─────────────────────────────────────────────────────────────────

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** Standard base64 of a string's UTF-8 bytes (padded). */
export function base64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 0x3f]
  }
  return out
}

/**
 * Decode base64 to a UTF-8 string, or null when the text is not base64.
 * Standard and url-safe alphabets are both accepted (`+`/`/` and `-`/`_`),
 * whitespace is ignored, and missing padding is supplied — the three forms a
 * copied token or JWT segment actually arrives in.
 */
export function base64Decode(text: string): string | null {
  const cleaned = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/")
  if (cleaned === "") return ""
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null
  const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4)
  const bytes: number[] = []
  for (let i = 0; i < padded.length; i += 4) {
    const chunk = padded.slice(i, i + 4)
    const values = [...chunk].map((ch) => (ch === "=" ? -1 : B64_ALPHABET.indexOf(ch)))
    if (values.some((v, k) => v < 0 && chunk[k] !== "=")) return null
    const [v0, v1, v2, v3] = values
    if (v0 < 0 || v1 < 0) return null
    bytes.push((v0 << 2) | (v1 >> 4))
    if (v2 >= 0) bytes.push(((v1 & 0x0f) << 4) | (v2 >> 2))
    if (v3 >= 0) bytes.push(((v2 & 0x03) << 6) | v3)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** base64 of the bytes' text is the same value — the row shows one form. */

// ── percent encoding ───────────────────────────────────────────────────────

/** Percent-encode a string (every reserved character, so the result is safe as
 *  one URL component). */
export function percentEncode(text: string): string {
  return encodeURIComponent(text)
}

/** Percent-decode, or null when the text carries a malformed escape. */
export function percentDecode(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "))
  } catch (_) {
    return null
  }
}

/** An argument as ONE URL component: trimmed, then percent-encoded, so a `&`,
 *  `#` or `?` typed into a query stays part of it instead of becoming a second
 *  parameter. The ONE encoder every site URL and search uses. */
export function urlArg(text: string): string {
  return percentEncode(text.trim())
}

// ── site URLs ──────────────────────────────────────────────────────────────

/** A GitHub argument of the `owner/repo` form names a repository directly
 *  instead of a search. */
const GITHUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/

/**
 * The canonical URL for a site argument, or null when the argument is empty.
 * ONE builder per site, shared by the `!bang` form (sources/bang-token.ts) and
 * the `scheme:` form (sources/urls.ts), so the two entry points to the same
 * site cannot disagree about its query URL.
 */
export const SITE = {
  /** A plain web search against a configured URL prefix. */
  search: (base: string, arg: string): string | null => (arg.trim() ? base + urlArg(arg) : null),
  wikipedia: (arg: string): string | null =>
    arg.trim() ? `https://en.wikipedia.org/w/index.php?search=${urlArg(arg)}` : null,
  archWiki: (arg: string): string | null =>
    arg.trim() ? `https://wiki.archlinux.org/index.php?search=${urlArg(arg)}` : null,
  github: (arg: string): string | null => {
    const q = arg.trim()
    if (!q) return null
    return GITHUB_REPO_RE.test(q)
      ? `https://github.com/${q}`
      : `https://github.com/search?q=${urlArg(q)}&type=repositories`
  },
  youtube: (arg: string): string | null =>
    arg.trim() ? `https://www.youtube.com/results?search_query=${urlArg(arg)}` : null,
  archPackage: (arg: string): string | null =>
    arg.trim() ? `https://archlinux.org/packages/?q=${urlArg(arg)}` : null,
  aur: (arg: string): string | null =>
    arg.trim() ? `https://aur.archlinux.org/packages?K=${urlArg(arg)}` : null,
  dictionary: (arg: string): string | null =>
    arg.trim() ? `https://en.wiktionary.org/wiki/${urlArg(arg)}` : null,
  translate: (text: string, target: string): string | null =>
    text.trim()
      ? `https://translate.google.com/?sl=auto&tl=${urlArg(target)}&text=${urlArg(text)}&op=translate`
      : null,
}

// ── JSON ───────────────────────────────────────────────────────────────────

/** Text's canonical 2-space JSON form, or null when it does not parse. */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch (_) {
    return null
  }
}

/** How many top-level entries a parsed JSON value holds (0 for a scalar). */
export function jsonSize(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (value !== null && typeof value === "object") return Object.keys(value as object).length
  return 0
}

/** The parsed JSON value, or null when the text does not parse. */
export function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch (_) {
    return null
  }
}

// ── colour ─────────────────────────────────────────────────────────────────

export interface ColourInfo {
  /** `#RRGGBB`, upper case. */
  hex: string
  /** `#RRGGBBAA` when the colour is not fully opaque. */
  hexAlpha: string
  r: number
  g: number
  b: number
  /** 0..1 */
  a: number
  /** `rgb(r, g, b)` / `rgba(r, g, b, a)`. */
  css: string
  /** `hsl(H, S%, L%)`. */
  hsl: string
  /** WCAG relative luminance, 0..1. */
  luminance: number
  /** WCAG contrast ratio against white / black, 1..21. */
  contrastOnWhite: number
  contrastOnBlack: number
}

const HEX_RE = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_RE =
  /^rgba?\(\s*([0-9]{1,3})\s*[, ]\s*([0-9]{1,3})\s*[, ]\s*([0-9]{1,3})\s*(?:[,/]\s*([0-9.]+%?)\s*)?\)$/i

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function hexPair(byte: number): string {
  return clampByte(byte).toString(16).padStart(2, "0").toUpperCase()
}

function hslOf(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

function luminanceOf(r: number, g: number, b: number): number {
  const channel = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: number, b: number): number {
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Parse a colour code: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (with or
 * without the `#`) or `rgb()`/`rgba()`. Null when the text names no colour.
 */
export function parseColour(input: string): ColourInfo | null {
  const text = input.trim()
  if (!text) return null
  let r: number
  let g: number
  let b: number
  let a = 1
  const hex = HEX_RE.exec(text)
  if (hex) {
    const digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      r = parseInt(digits[0] + digits[0], 16)
      g = parseInt(digits[1] + digits[1], 16)
      b = parseInt(digits[2] + digits[2], 16)
      if (digits.length === 4) a = parseInt(digits[3] + digits[3], 16) / 255
    } else {
      r = parseInt(digits.slice(0, 2), 16)
      g = parseInt(digits.slice(2, 4), 16)
      b = parseInt(digits.slice(4, 6), 16)
      if (digits.length === 8) a = parseInt(digits.slice(6, 8), 16) / 255
    }
  } else {
    const m = RGB_RE.exec(text)
    if (!m) return null
    r = Number(m[1])
    g = Number(m[2])
    b = Number(m[3])
    if (r > 255 || g > 255 || b > 255) return null
    if (m[4] !== undefined) {
      const raw = m[4]
      const value = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw)
      if (!Number.isFinite(value) || value < 0 || value > 1) return null
      a = value
    }
  }
  const { h, s, l } = hslOf(r, g, b)
  const lum = luminanceOf(r, g, b)
  const rgbText =
    a < 1 ? `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})` : `rgb(${r}, ${g}, ${b})`
  return {
    hex: `#${hexPair(r)}${hexPair(g)}${hexPair(b)}`,
    hexAlpha: `#${hexPair(r)}${hexPair(g)}${hexPair(b)}${hexPair(a * 255)}`,
    r,
    g,
    b,
    a,
    css: rgbText,
    hsl: `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`,
    luminance: lum,
    contrastOnWhite: contrast(lum, 1),
    contrastOnBlack: contrast(lum, 0),
  }
}

// ── instants ───────────────────────────────────────────────────────────────

export interface Instant {
  ms: number
  /** `2023-11-14 22:13:20 UTC` */
  utc: string
  /** The machine's own zone, same layout. */
  local: string
  iso: string
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0")
}

function stampOf(date: Date, utc: boolean): string {
  const y = utc ? date.getUTCFullYear() : date.getFullYear()
  const mo = utc ? date.getUTCMonth() : date.getMonth()
  const d = utc ? date.getUTCDate() : date.getDate()
  const h = utc ? date.getUTCHours() : date.getHours()
  const mi = utc ? date.getUTCMinutes() : date.getMinutes()
  const s = utc ? date.getUTCSeconds() : date.getSeconds()
  return `${y}-${pad(mo + 1)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`
}

/**
 * Text as an instant: a Unix epoch (seconds for 1–10 digits, milliseconds for
 * 11–13) or a date string `Date.parse` accepts. Null when it names neither.
 */
export function parseEpochInput(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  if (/^-?\d+$/.test(t)) {
    const digits = t.replace("-", "").length
    const n = Number(t)
    if (!Number.isFinite(n)) return null
    if (digits <= 10) return n * 1000
    if (digits <= 13) return n
    return null
  }
  const parsed = Date.parse(t)
  return Number.isNaN(parsed) ? null : parsed
}

/** A millisecond instant rendered for the row, in UTC and in the local zone. */
export function formatInstant(ms: number): Instant {
  if (!Number.isFinite(ms)) return { ms: 0, utc: "", local: "", iso: "" }
  const date = new Date(ms)
  let iso = ""
  try {
    iso = date.toISOString()
  } catch (_) {
    iso = ""
  }
  return {
    ms,
    utc: `${stampOf(date, true)} UTC`,
    local: stampOf(date, false),
    iso,
  }
}

/** A coarse relative phrase for an instant ("3 hours ago"). Pure: the current
 *  time arrives as a parameter. */
export function formatRelative(ms: number, nowMs: number): string {
  const delta = nowMs - ms
  const past = delta >= 0
  const seconds = Math.abs(delta) / 1000
  if (seconds < 45) return "just now"
  let unit = "minute"
  let divisor = 60
  for (const [name, secondsPerUnit] of [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
    ["month", 2592000],
    ["year", 31536000],
  ] as [string, number][]) {
    if (seconds >= secondsPerUnit) {
      unit = name
      divisor = secondsPerUnit
    }
  }
  const count = Math.max(1, Math.floor(seconds / divisor))
  return `${count} ${unit}${count === 1 ? "" : "s"} ${past ? "ago" : "from now"}`
}

// ── cron ───────────────────────────────────────────────────────────────────

const CRON_MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** Parse one cron field into its sorted value list, or null when malformed. */
function parseCronField(
  raw: string,
  min: number,
  max: number,
  names: Record<string, number> | null,
): number[] | null {
  const values = new Set<number>()
  for (const part of raw.split(",")) {
    if (part === "") return null
    const [rangePart, stepPart] = part.split("/")
    let step = 1
    if (stepPart !== undefined) {
      step = Number(stepPart)
      if (!Number.isInteger(step) || step <= 0) return null
    }
    const bound = (token: string): number | null => {
      const key = token.toLowerCase()
      if (names && key in names) return names[key]
      if (!/^\d+$/.test(token)) return null
      const n = Number(token)
      return Number.isInteger(n) ? n : null
    }
    let from: number
    let to: number
    if (rangePart === "*") {
      from = min
      to = max
    } else {
      const [a, b] = rangePart.split("-")
      const start = bound(a)
      if (start === null) return null
      from = start
      if (b === undefined) {
        to = stepPart === undefined ? start : max
      } else {
        const end = bound(b)
        if (end === null) return null
        to = end
      }
    }
    if (from < min || to > max || from > to) return null
    for (let v = from; v <= to; v += step) values.add(v)
  }
  return [...values].sort((a, b) => a - b)
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ""
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

/** Collapse a value list into a readable phrase, using `A to B` for runs of
 *  three or more consecutive values. */
function rangesText(values: number[], labels: string[] | null, pad = false): string {
  const runs: [number, number][] = []
  for (const v of values) {
    const last = runs[runs.length - 1]
    if (last && v === last[1] + 1) last[1] = v
    else runs.push([v, v])
  }
  return joinList(
    runs.map(([a, b]) => {
      const name = (n: number): string => (labels ? labels[n] : pad ? pad2(n) : String(n))
      if (a === b) return name(a)
      return b - a >= 2 ? `${name(a)} to ${name(b)}` : joinList([name(a), name(b)])
    }),
  )
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/**
 * A cron expression in words, or null when the text is not a cron expression.
 * Both the 5-field form and the `@daily` macros are read; an expression whose
 * fields use constructs outside the plain grammar is refused rather than
 * described wrongly.
 */
export function describeCron(expr: string): string | null {
  const text = expr.trim()
  if (!text) return null
  const lower = text.toLowerCase()
  if (lower === "@reboot") return "At every boot"
  const expanded = lower.startsWith("@") ? CRON_MACROS[lower] : text
  if (!expanded) return null
  const fields = expanded.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minute = parseCronField(fields[0], 0, 59, null)
  const hour = parseCronField(fields[1], 0, 23, null)
  const dom = parseCronField(fields[2], 1, 31, null)
  const month = parseCronField(fields[3], 1, 12, MONTH_NAMES)
  const dow = parseCronField(fields[4], 0, 7, DOW_NAMES)
  if (!minute || !hour || !dom || !month || !dow) return null
  const dowNormalized = [...new Set(dow.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b)

  const minuteAny = minute.length === 60
  const hourAny = hour.length === 24
  const stepOf = (raw: string): number | null => {
    const m = /^\*\/(\d+)$/.exec(raw.trim())
    return m ? Number(m[1]) : null
  }
  const minuteStep = stepOf(fields[0])
  const hourStep = stepOf(fields[1])

  let time: string
  if (minuteAny && hourAny) time = "Every minute"
  else if (minuteStep !== null && hourAny) time = `Every ${minuteStep} minutes`
  else if (minuteStep !== null)
    time = `Every ${minuteStep} minutes in hour ${rangesText(hour, null)}`
  else if (hourStep !== null && minute.length === 1)
    time = `Every ${hourStep} hours at minute ${pad2(minute[0])}`
  else if (minuteAny) time = `Every minute of hour ${rangesText(hour, null)}`
  else if (hourAny) time = `Every hour at minute ${rangesText(minute, null, true)}`
  else if (minute.length === 1 && hour.length === 1) time = `At ${pad2(hour[0])}:${pad2(minute[0])}`
  else if (minute.length === 1)
    time = `At ${pad2(minute[0])} minutes past hour ${rangesText(hour, null)}`
  else if (hour.length === 1)
    time = `At minute ${rangesText(minute, null, true)} of hour ${pad2(hour[0])}`
  else time = `At minute ${rangesText(minute, null, true)} of hours ${rangesText(hour, null)}`

  const dateParts: string[] = []
  if (dom.length !== 31) dateParts.push(`on day ${rangesText(dom, null)} of the month`)
  if (month.length !== 12) {
    dateParts.push(
      `in ${rangesText(
        month.map((m) => m - 1),
        MONTH_LABELS,
      )}`,
    )
  }
  if (dowNormalized.length !== 7) dateParts.push(`on ${rangesText(dowNormalized, DOW_LABELS)}`)
  const date = dateParts.length > 0 ? ` ${dateParts.join(", ")}` : ""
  // Standard cron ORs a restricted day-of-month with a restricted weekday.
  const bothDays = dom.length !== 31 && dowNormalized.length !== 7
  return `${time}${date}${bothDays ? " (day-of-month or weekday)" : ""}`
}

// ── JWT ────────────────────────────────────────────────────────────────────

export interface JwtParts {
  header: Record<string, unknown>
  payload: Record<string, unknown>
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  const json = base64Decode(segment)
  if (json === null) return null
  const value = parseJson(json)
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * A JWT's header and payload, decoded but NOT verified — the row states what
 * the token claims, and verification needs the key, which a launcher row has
 * no business holding.
 */
export function decodeJwt(token: string): JwtParts | null {
  const t = token.trim().replace(/^bearer\s+/i, "")
  const parts = t.split(".")
  if (parts.length < 2) return null
  const header = decodeSegment(parts[0])
  const payload = decodeSegment(parts[1])
  if (!header || !payload) return null
  return { header, payload }
}

// ── /etc/services ──────────────────────────────────────────────────────────

export interface ServiceTable {
  /** Port → the service entries that declare it (`ssh/tcp`). */
  byPort: Map<number, string[]>
}

/**
 * Parse the `/etc/services` text (the file's contents arrive as a parameter —
 * this module reads nothing itself). Blank lines and `#` comments are ignored;
 * each entry is `name port/proto [aliases…]`.
 */
export function parseServices(text: string): ServiceTable {
  const byPort = new Map<number, string[]>()
  for (const line of text.split("\n")) {
    const body = line.split("#")[0].trim()
    if (!body) continue
    const fields = body.split(/\s+/)
    if (fields.length < 2) continue
    const [name, portProto] = fields
    const slash = portProto.indexOf("/")
    if (slash <= 0) continue
    const port = Number(portProto.slice(0, slash))
    const proto = portProto.slice(slash + 1)
    if (!Number.isInteger(port) || port < 0 || port > 65535) continue
    const entry = `${name}/${proto}`
    const list = byPort.get(port)
    if (list) {
      if (!list.includes(entry)) list.push(entry)
    } else {
      byPort.set(port, [entry])
    }
  }
  return { byPort }
}

/** The service entries that declare a port, capped so a common port's alias
 *  list cannot fill the row. */
export function servicesForPort(table: ServiceTable, port: number, cap = 6): string[] {
  const list = table.byPort.get(port)
  return list ? list.slice(0, cap) : []
}

/** A port number the table could name — 1..65535. */
export function parsePort(text: string): number | null {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  const port = Number(t)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

// ── translate ──────────────────────────────────────────────────────────────

/** The language codes a `to <code>` tail may name, with their English names. */
export const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic",
  bg: "Bulgarian",
  ca: "Catalan",
  cs: "Czech",
  cy: "Welsh",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  eo: "Esperanto",
  es: "Spanish",
  et: "Estonian",
  fa: "Persian",
  fi: "Finnish",
  fr: "French",
  ga: "Irish",
  he: "Hebrew",
  hi: "Hindi",
  hr: "Croatian",
  hu: "Hungarian",
  id: "Indonesian",
  is: "Icelandic",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  la: "Latin",
  lt: "Lithuanian",
  lv: "Latvian",
  mk: "Macedonian",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sk: "Slovak",
  sl: "Slovenian",
  sq: "Albanian",
  sr: "Serbian",
  sv: "Swedish",
  sw: "Swahili",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  ur: "Urdu",
  vi: "Vietnamese",
  zh: "Chinese",
}

/** The language name for a code, or the code itself when it is unknown. */
export function languageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] ?? code
}

/**
 * Split a translate argument into the text to translate and the target
 * language: a trailing `to <code>` naming a known language sets the target,
 * anything else leaves it at English — the common direction for a snippet
 * pasted from elsewhere. A trailing `to` that names no language stays part of
 * the text ("I want to go" is not a request for Go).
 */
export function splitTranslateTarget(text: string): { text: string; target: string } {
  const m = /\s+to\s+([A-Za-z]{2}(?:-[A-Za-z]{2})?)\s*$/.exec(text)
  if (m) {
    const code = m[1].toLowerCase()
    const base = code.split("-")[0]
    if (base in LANGUAGE_NAMES) {
      return { text: text.slice(0, m.index).trim(), target: code }
    }
  }
  return { text: text.trim(), target: "en" }
}

// ── IPv4 ───────────────────────────────────────────────────────────────────

export interface Ipv4Address {
  /** The four octets. */
  octets: [number, number, number, number]
  /** CIDR prefix length 0..32; 32 when the text named none. */
  prefix: number
  /** The address as one 32-bit number. */
  value: number
}

/** Parse `a.b.c.d` or `a.b.c.d/n`, or null when the text is neither. */
export function parseIpv4(input: string): Ipv4Address | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(input.trim())
  if (!m) return null
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (octets.some((o) => o > 255)) return null
  const prefix = m[5] === undefined ? 32 : Number(m[5])
  if (prefix > 32) return null
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  return { octets: octets as [number, number, number, number], prefix, value }
}

function ipv4Text(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    ".",
  )
}

/** The address's scope, as the reserved ranges name it. */
function ipv4Scope({ octets }: Ipv4Address): string {
  const [a, b] = octets
  if (a === 127) return "loopback"
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
    return "private (RFC1918)"
  if (a === 169 && b === 254) return "link-local"
  if (a === 100 && b >= 64 && b <= 127) return "carrier NAT"
  if (a >= 224 && a <= 239) return "multicast"
  if (a >= 240) return "reserved"
  return "public"
}

/**
 * The bare typed shapes a launcher can answer WITHOUT a bang prefix: a colour
 * code, a JWT, and an IPv4 address or CIDR block. Each is one row whose
 * `copy` text is what Enter puts on the clipboard.
 *
 * Deliberately narrow. A bare NUMBER is qalc's (and the unit table's), and a
 * bare 5-field cron expression or a base64-looking word is claimed by neither
 * confidently enough to answer — those stay `!cron` / `!b64` bangs, where the
 * user asked for the reading. `sources/combiner.ts` does not call this yet; it
 * is the one place the pure shapes are assembled, so wiring it is one call.
 */
export function shapeRows(input: string): { title: string; description: string; copy?: string }[] {
  const text = input.trim()
  if (!text) return []

  // A colour code is claimed only when it is SPELLED as one (`#rgb`, `#rrggbb`,
  // `rgb(...)`) — a bare `fff` is a word search, not a colour.
  if (text.startsWith("#") || /^rgba?\(/i.test(text)) {
    const colour = parseColour(text)
    if (colour) {
      const copy = colour.a < 1 ? colour.hexAlpha : colour.hex
      return [
        {
          title: `${colour.hex} — ${colour.css}`,
          description:
            `${colour.hsl} · luminance ${colour.luminance.toFixed(3)} · contrast ` +
            `${colour.contrastOnWhite.toFixed(2)}:1 on white, ${colour.contrastOnBlack.toFixed(2)}:1 on black ` +
            `— Enter copies ${copy}`,
          copy,
        },
      ]
    }
  }

  // A JWT is three dot-separated base64url segments, the first two JSON
  // objects — the decode is the test, so ordinary dotted text is not claimed.
  if (text.split(".").length === 3) {
    const parts = decodeJwt(text)
    if (parts) {
      const exp = typeof parts.payload.exp === "number" ? parts.payload.exp * 1000 : null
      const bits = [`alg ${String(parts.header.alg ?? "none")}`]
      if (exp !== null) {
        bits.push(`expires ${formatInstant(exp).utc} (${formatRelative(exp, Date.now())})`)
      } else {
        const claims = Object.keys(parts.payload)
        if (claims.length > 0) bits.push(`claims: ${claims.slice(0, 6).join(", ")}`)
      }
      return [
        {
          title: "JWT",
          description: `${bits.join(" · ")} — decode only, the signature is NOT verified`,
          copy: JSON.stringify(parts.payload, null, 2),
        },
      ]
    }
  }

  const ip = parseIpv4(text)
  if (ip) {
    if (ip.prefix === 32) {
      return [
        {
          title: `${ipv4Text(ip.value)} — ${ipv4Scope(ip)}`,
          description:
            `integer ${ip.value} · hex 0x${ip.value.toString(16).toUpperCase().padStart(8, "0")} ` +
            `· binary ${ip.octets.map((o) => o.toString(2).padStart(8, "0")).join(".")}`,
          copy: ipv4Text(ip.value),
        },
      ]
    }
    const mask = ip.prefix === 0 ? 0 : (0xffffffff << (32 - ip.prefix)) >>> 0
    const network = (ip.value & mask) >>> 0
    const broadcast = (network | (~mask >>> 0)) >>> 0
    const hosts = ip.prefix >= 31 ? 0 : 2 ** (32 - ip.prefix) - 2
    const cidr = `${ipv4Text(network)}/${ip.prefix}`
    return [
      {
        title: `${cidr} — ${hosts} host${hosts === 1 ? "" : "s"}`,
        description:
          `network ${ipv4Text(network)} · broadcast ${ipv4Text(broadcast)} · mask ${ipv4Text(mask)} ` +
          `· ${ipv4Text(ip.value)} is ${ip.value === network ? "the network address" : "a host address"} — Enter copies ${cidr}`,
        copy: cidr,
      },
    ]
  }

  return []
}
