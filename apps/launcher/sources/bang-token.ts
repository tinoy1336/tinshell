/**
 * Bang token grammar — the ONE owner of the bang catalogue, of what a typed
 * token names, of how a catalogue hint may rewrite the entry, and of the row a
 * bang produces.
 *
 * Pure (no gi, no GTK): `bangs.ts` dispatches through it, `Launcher.tsx` calls
 * it for the autofill extract and for the catalogue apply, and
 * `./bang-token.probe.ts` exercises it under plain Node. One owner is what
 * keeps the hint list, the abbreviation rule, the alias rule, the dispatch
 * argument and the row from disagreeing: an abbreviated or aliased token
 * reaches the SAME command as its full spelling, with the argument the user
 * typed intact.
 *
 * A catalogue entry declares ONE of three row builders, so adding a bang is
 * adding data here and no dispatch code in bangs.ts:
 *   - `url`     the row opens that URL through the desktop's own handler
 *               (`sources/xdg-row.ts` — the same row the path and URL sources
 *               offer, so there is one spawn implementation).
 *   - `compute` the row shows a value built in-process; Enter copies it.
 *   - `spawn`   the row runs that argv; Enter spawns it and the launcher hides.
 * A builder answers `null` when the argument names nothing it can serve, which
 * is how a bang with no argument shows no row.
 *
 * An entry may also OPT INTO a preview (`enrich`): the URL row is shown at once
 * and a fetched payload replaces it on the combiner's async slot, keeping the
 * bang's own title, its Enter target and its degradation (see
 * `sources/bang-preview.ts` and `sources/bang-preview-fetch.ts`). The preview a
 * bang may opt into is declared here for the same reason the row builders are:
 * the hint list, the dispatch and the fetch read one list.
 *
 * The builders stay pure by taking the host facilities they need as the
 * `BangEnv` parameter (a checksum, a random UUID, the browser commands, the
 * searched-on `/etc/services` table) — this module never reaches for a global.
 */

import { type EnrichKind, previewArgs } from "./bang-preview.ts"
import {
  base64Decode,
  base64Encode,
  decodeJwt,
  describeCron,
  formatInstant,
  formatRelative,
  jsonSize,
  languageName,
  parseColour,
  parseEpochInput,
  parseJson,
  parsePort,
  percentDecode,
  percentEncode,
  prettyJson,
  SITE,
  splitTranslateTarget,
} from "./text-tools.ts"

/** One catalogue entry: a bang as it is shown and inserted, the argument it
 *  takes, and the command it names. */
export interface BangEntry {
  /** The spelling inserted into the entry (trailing space included). */
  prefix: string
  title: string
  description: string
  /** Themed icon name. */
  icon: string
  /** The argument is a PATH: the launcher Tab-completes it through the shared
   *  autofill (`common/path/autofill`). */
  pathArg?: boolean
  /** Row title prefix: a produced row reads `<label>: <argument>`. */
  label?: string
  /** Full row-title override, for a bang whose title is not `<label>: <arg>`. */
  rowTitle?: (arg: string, env: BangEnv) => string
  /** Pure URL builder — the row opens this URL with the desktop's handler. */
  url?: (arg: string, env: BangEnv) => string | null
  /** Pure value builder — the row shows the value; Enter copies `copy`. A row
   *  with no `copy` is a refusal: Enter keeps the launcher open. */
  compute?: (arg: string, env: BangEnv) => BangValue | null
  /** Pure argv builder — Enter spawns it. */
  spawn?: (arg: string, env: BangEnv) => string[] | null
  /** The preview this bang opts into (`sources/bang-preview.ts`): the payload a
   *  URL row fetches on the async slot and carries in its description. A bang
   *  without one keeps the row its `url` builder produces. */
  enrich?: EnrichKind
  /** SHORTHAND spellings of this bang, resolved at the same precedence as the
   *  canonical spelling (`resolveBang`). An entry declares one only where the
   *  prefix rule cannot already reach it in that many characters — a token that
   *  names nothing today because it prefixes SEVERAL bangs — and it may never be
   *  a canonical spelling or another entry's alias, which `./bang-token.probe.ts`
   *  asserts over the whole catalogue. */
  aliases?: string[]
}

/** What a produced bang row holds. */
export interface BangValue {
  title: string
  description?: string
  /** Text Enter puts on the clipboard; absent = a refusal row. */
  copy?: string
}

/**
 * The host facilities a bang row may use. The launcher supplies them
 * (`bangs.ts`), so the catalogue holds no gi import and no machine fact.
 */
export interface BangEnv {
  /** The TINSHELL home (`~/dev/tinshell`) — the launcher's own scripts live there. */
  tinshellDir: string
  browserFirefox: string
  browserChromium: string
  /** The configured search URL prefix (`bangs.searchUrl`). */
  searchUrl: string
  /** GLib's own checksum, so no hash is re-implemented here. */
  checksum: (algo: "sha256" | "md5", text: string) => string
  /** A random v4 UUID (GLib's generator). */
  randomUuid: () => string
  /** The IANA service names `/etc/services` declares for a port — [] when the
   *  file is unreadable or declares none. */
  servicesForPort: (port: number) => string[]
}

/** The argument as ONE URL component: percent-encoded, so a `&`, `#` or `?`
 *  typed into a query stays part of it instead of becoming a second parameter.
 *  Every site URL is built by `text-tools`' `SITE` table, which is the one
 *  place a site's query URL is spelled out (`urls.ts`'s `scheme:` form reads
 *  the same table). */

/** `<label>: <argument>`, or the label alone for a bang that takes none. */
function titled(entry: BangEntry, arg: string, env: BangEnv): string {
  if (entry.rowTitle) return entry.rowTitle(arg, env)
  const trimmed = arg.trim()
  if (!entry.label) return trimmed
  return trimmed ? `${entry.label}: ${trimmed}` : entry.label
}

/** A refusal row: the argument named nothing this bang can serve. */
function refusal(title: string, description: string): BangValue {
  return { title, description }
}

/**
 * The bang catalogue — shown as separate rows when the user types `!` (or a
 * token that names no bang). Each row describes one command; selecting it
 * inserts that bang's canonical prefix into the entry (so the user keeps
 * typing the query). A `!`-prefixed row's argument is everything after the
 * token, so a bang never sees a partial argument.
 *
 * An entry may also declare `aliases` — shorthand spellings resolved at the
 * same precedence as the canonical one (`resolveBang`). Aliases are declared
 * only where the prefix rule cannot reach the bang in that many characters, and
 * the probe asserts the whole table over this list: no alias is a canonical
 * spelling, no two entries share one, and every alias names a bang that is
 * still here.
 */
export const BANG_CATALOGUE: BangEntry[] = [
  {
    prefix: "!py ",
    title: "!py <expr>",
    description: "evaluate python (expressions + statements)",
    icon: "utilities-terminal",
  },
  {
    prefix: "!q ",
    title: "!q <expr>",
    description: "force calculator (units / constants / currency)",
    icon: "accessories-calculator",
  },

  // ── web search ──
  {
    prefix: "!f ",
    title: "!f <query>",
    description: "search the web in firefox",
    icon: "firefox",
  },
  {
    prefix: "!c ",
    title: "!c <query>",
    description: "search the web in chromium",
    icon: "chromium",
  },
  {
    prefix: "!g ",
    title: "!g <query>",
    description: "search the web in the default browser",
    icon: "system-search",
    label: "Search",
    url: (arg, env) => SITE.search(env.searchUrl, arg),
    enrich: "ddg",
  },
  {
    prefix: "!fp ",
    title: "!fp <query>",
    description: "search in a firefox private window",
    icon: "firefox",
    label: "Private search",
    spawn: (arg, env) => {
      const url = SITE.search(env.searchUrl, arg)
      return url ? [env.browserFirefox, "--private-window", url] : null
    },
  },
  {
    prefix: "!ci ",
    title: "!ci <query>",
    description: "search in a chromium incognito window",
    icon: "chromium",
    label: "Incognito search",
    spawn: (arg, env) => {
      const url = SITE.search(env.searchUrl, arg)
      return url ? [env.browserChromium, "--incognito", url] : null
    },
  },
  {
    prefix: "!wiki ",
    title: "!wiki <query>",
    description: "search Wikipedia",
    icon: "help-browser",
    label: "Wikipedia",
    url: (arg) => SITE.wikipedia(arg),
    enrich: "wikipedia",
    aliases: ["!w"],
  },
  {
    prefix: "!aw ",
    title: "!aw <query>",
    description: "search the Arch Wiki",
    icon: "help-browser",
    label: "ArchWiki",
    url: (arg) => SITE.archWiki(arg),
    enrich: "archwiki",
  },
  {
    prefix: "!gh ",
    title: "!gh <query|owner/repo>",
    description: "search GitHub, or open an owner/repo directly",
    icon: "applications-development",
    label: "GitHub",
    url: (arg) => SITE.github(arg),
  },
  {
    prefix: "!yt ",
    title: "!yt <query>",
    description: "search YouTube",
    icon: "applications-multimedia",
    label: "YouTube",
    url: (arg) => SITE.youtube(arg),
    enrich: "youtube",
  },
  {
    prefix: "!def ",
    title: "!def <word…>",
    description: "look one or more words up in Wiktionary",
    icon: "accessories-dictionary",
    label: "Define",
    url: (arg) => SITE.dictionary(arg),
    enrich: "wiktionary",
    aliases: ["!d", "!df"],
    rowTitle: (arg) => {
      // A greedy argument names no single word, so the row that stands while
      // the fetch runs names the FIRST one and an ellipsis; the fetched batch
      // replaces it with one row per word (`previewArgs` owns the split).
      const words = previewArgs("wiktionary", arg)
      return words.length > 1 ? `Define: ${words[0]} …` : `Define: ${arg.trim()}`
    },
  },
  {
    prefix: "!tr ",
    title: "!tr <text> [to <lang>]",
    description: "translate text (English unless a `to <lang>` tail says otherwise)",
    icon: "accessories-dictionary",
    enrich: "translate",
    rowTitle: (arg) => {
      const { target } = splitTranslateTarget(arg)
      return `Translate to ${languageName(target)}`
    },
    url: (arg) => {
      const { text, target } = splitTranslateTarget(arg)
      return SITE.translate(text, target)
    },
  },

  // ── packages and pages on this machine ──
  {
    prefix: "!pac ",
    title: "!pac <package>",
    description: "search the Arch package database",
    icon: "package-x-generic",
    label: "Arch package",
    url: (arg) => SITE.archPackage(arg),
    enrich: "archpackage",
  },
  {
    prefix: "!aur ",
    title: "!aur <package>",
    description: "search the Arch User Repository",
    icon: "package-x-generic",
    label: "AUR",
    url: (arg) => SITE.aur(arg),
    enrich: "aur",
  },
  {
    prefix: "!man ",
    title: "!man <page>",
    description: "read a manual page in a terminal",
    icon: "utilities-terminal",
    label: "Man page",
    // The session's terminal (hyprland.lua `terminal`); --single-instance
    // hands the page to the running kitty instead of starting a second one.
    spawn: (arg) => (arg.trim() ? ["kitty", "--single-instance", "man", arg.trim()] : null),
  },
  {
    prefix: "!port ",
    title: "!port <number>",
    description: "name the service a port belongs to",
    icon: "network-server",
    label: "Port",
    compute: (arg, env) => {
      const port = parsePort(arg)
      if (port === null) {
        return arg.trim() ? refusal("Not a port number", "a port is 1-65535") : null
      }
      const names = env.servicesForPort(port)
      if (names.length === 0) {
        return refusal(`Port ${port}`, "no service in /etc/services declares this port")
      }
      return {
        title: `Port ${port} — ${names.slice(0, 3).join(", ")}`,
        description: `${names.length} /etc/services entr${names.length === 1 ? "y" : "ies"}`,
        copy: names.join(" "),
      }
    },
  },

  // ── the desktop itself ──
  {
    prefix: "!grab ",
    title: "!grab",
    description: "capture a screen region (the Print-key pipeline)",
    icon: "camera-photo",
    label: "Capture region",
    spawn: (_arg, env) => [`${env.tinshellDir}/common/shell/ensure-screengrab.sh`],
  },
  {
    prefix: "!pick ",
    title: "!pick",
    description: "pick a screen colour onto the clipboard",
    icon: "applications-graphics",
    label: "Pick a colour",
    spawn: () => ["hyprpicker", "-a"],
  },
  {
    prefix: "!kill ",
    title: "!kill <name>",
    description: "SIGTERM every process with this exact name",
    icon: "window-close",
    label: "Kill",
    // -x matches the process NAME exactly (never -f, which would match any
    // command line mentioning the text). SIGTERM is graceful: the app still
    // gets to save or ask. No match is a no-op with a non-zero exit.
    spawn: (arg) => (arg.trim() ? ["pkill", "-TERM", "-x", arg.trim()] : null),
  },
  {
    prefix: "!mixer ",
    title: "!mixer",
    description: "open the PipeWire mixer (pavucontrol)",
    icon: "audio-volume-high",
    label: "Audio mixer",
    spawn: () => ["pavucontrol"],
  },

  // ── text and data ──
  {
    prefix: "!b64 ",
    title: "!b64 <text>",
    description: "base64-encode text",
    icon: "text-x-generic",
    label: "Base64",
    aliases: ["!be"],
    compute: (arg) => {
      if (!arg.trim()) return null
      const encoded = base64Encode(arg)
      return { title: encoded, description: "base64 — Enter copies it", copy: encoded }
    },
  },
  {
    prefix: "!b64d ",
    title: "!b64d <text>",
    description: "base64-decode text",
    icon: "text-x-generic",
    label: "Base64 decode",
    aliases: ["!bd"],
    compute: (arg) => {
      if (!arg.trim()) return null
      const decoded = base64Decode(arg)
      if (decoded === null) {
        return refusal("Not base64", "expected standard or url-safe base64")
      }
      return { title: decoded, description: "decoded — Enter copies it", copy: decoded }
    },
  },
  {
    prefix: "!enc ",
    title: "!enc <text>",
    description: "percent-encode text for a URL",
    icon: "text-x-generic",
    label: "Encoded",
    compute: (arg) => {
      if (!arg.trim()) return null
      const encoded = percentEncode(arg)
      return { title: encoded, description: "percent-encoded — Enter copies it", copy: encoded }
    },
  },
  {
    prefix: "!dec ",
    title: "!dec <text>",
    description: "percent-decode URL text",
    icon: "text-x-generic",
    label: "Decoded",
    compute: (arg) => {
      if (!arg.trim()) return null
      const decoded = percentDecode(arg)
      if (decoded === null) return refusal("Not percent-encoded", "a malformed % escape")
      return { title: decoded, description: "percent-decoded — Enter copies it", copy: decoded }
    },
  },
  {
    prefix: "!json ",
    title: "!json <text>",
    description: "validate and format JSON",
    icon: "text-x-generic",
    label: "JSON",
    compute: (arg) => {
      if (!arg.trim()) return null
      const pretty = prettyJson(arg)
      if (pretty === null) return refusal("Not JSON", "the text does not parse as JSON")
      const value = parseJson(arg)
      const size = jsonSize(value)
      const shape = Array.isArray(value)
        ? `${size} ${size === 1 ? "item" : "items"}`
        : size > 0
          ? `${size} ${size === 1 ? "key" : "keys"}`
          : "a value"
      return {
        title: `Valid JSON — ${shape}`,
        description: `${pretty.split("\n").length} lines formatted — Enter copies them`,
        copy: pretty,
      }
    },
  },
  {
    prefix: "!rgb ",
    title: "!rgb <colour>",
    description: "read a colour code as rgb / hsl / contrast",
    icon: "applications-graphics",
    label: "Colour",
    compute: (arg) => {
      if (!arg.trim()) return null
      const colour = parseColour(arg)
      if (colour === null) {
        return refusal("Not a colour code", "expected #rrggbb, #rgb, #rrggbbaa or rgb(r, g, b)")
      }
      const copy = colour.a < 1 ? colour.hexAlpha : colour.hex
      return {
        title: `${colour.hex} — ${colour.css}`,
        description:
          `${colour.hsl} · luminance ${colour.luminance.toFixed(3)} · contrast ` +
          `${colour.contrastOnWhite.toFixed(2)}:1 on white, ${colour.contrastOnBlack.toFixed(2)}:1 on black ` +
          `— Enter copies ${copy}`,
        copy,
      }
    },
  },
  {
    prefix: "!cron ",
    title: "!cron <expr>",
    description: "read a cron expression out loud",
    icon: "appointment-soon",
    label: "Cron",
    compute: (arg) => {
      if (!arg.trim()) return null
      const description = describeCron(arg)
      if (description === null) {
        return refusal(
          "Not a cron expression",
          "expected five fields, or @daily / @hourly / @weekly…",
        )
      }
      return {
        title: description,
        description: `cron: ${arg.trim()} — Enter copies it`,
        copy: arg.trim(),
      }
    },
  },
  {
    prefix: "!jwt ",
    title: "!jwt <token>",
    description: "decode a JWT (claims, not verified)",
    icon: "dialog-password",
    label: "JWT",
    compute: (arg) => {
      if (!arg.trim()) return null
      const parts = decodeJwt(arg)
      if (parts === null) return refusal("Not a JWT", "expected header.payload.signature")
      const payload = parts.payload
      const bits = [`alg ${String(parts.header.alg ?? "none")}`]
      const exp = typeof payload.exp === "number" ? payload.exp * 1000 : null
      if (exp !== null) {
        bits.push(`expires ${formatInstant(exp).utc} (${formatRelative(exp, Date.now())})`)
      } else {
        const claims = Object.keys(payload)
        if (claims.length > 0) bits.push(`claims: ${claims.slice(0, 6).join(", ")}`)
      }
      return {
        title: "JWT",
        description: `${bits.join(" · ")} — decode only, the signature is NOT verified`,
        copy: JSON.stringify(payload, null, 2),
      }
    },
  },
  {
    prefix: "!epoch ",
    title: "!epoch [number]",
    description: "read an epoch (or the current time) as a date",
    icon: "clock",
    label: "Epoch",
    compute: (arg) => {
      const trimmed = arg.trim()
      const ms = trimmed ? parseEpochInput(trimmed) : Date.now()
      if (ms === null)
        return refusal("Not an epoch", "expected seconds, milliseconds or a date string")
      const instant = formatInstant(ms)
      return {
        title: instant.utc,
        description:
          `${instant.local} local · ${formatRelative(ms, Date.now())} · ${instant.ms} ms ` +
          `— Enter copies ${instant.iso}`,
        copy: instant.iso,
      }
    },
  },
  {
    prefix: "!sha ",
    title: "!sha <text>",
    description: "SHA-256 of the text",
    icon: "security-high",
    label: "SHA-256",
    compute: (arg, env) => {
      if (!arg.trim()) return null
      const digest = env.checksum("sha256", arg)
      return { title: digest, description: "sha256 — Enter copies it", copy: digest }
    },
  },
  {
    prefix: "!md5 ",
    title: "!md5 <text>",
    description: "MD5 of the text",
    icon: "security-high",
    label: "MD5",
    compute: (arg, env) => {
      if (!arg.trim()) return null
      const digest = env.checksum("md5", arg)
      return { title: digest, description: "md5 — Enter copies it", copy: digest }
    },
  },
  {
    prefix: "!uuid ",
    title: "!uuid",
    description: "generate a random v4 UUID",
    icon: "dialog-password",
    label: "UUID",
    compute: (_arg, env) => {
      const uuid = env.randomUuid()
      return { title: uuid, description: "random v4 UUID — Enter copies it", copy: uuid }
    },
  },
  {
    prefix: "!wc ",
    title: "!wc <text>",
    description: "count words in text",
    icon: "text-x-generic",
  },
  {
    prefix: "!cc ",
    title: "!cc <text>",
    description: "count characters in text",
    icon: "text-x-generic",
  },

  // ── the launcher's own files and apps ──
  {
    prefix: "!n ",
    title: "!n <name>",
    description: "open or create a note (TINSHELL notes app)",
    icon: "text-x-generic",
  },
  {
    prefix: "!p ",
    title: "!p <path-or-url>",
    description: "open media in the TINSHELL media app",
    icon: "video-x-generic",
    pathArg: true,
  },
  {
    prefix: "!code ",
    title: "!code <path>",
    description: "open a file or directory in VS Code",
    icon: "vscode",
    pathArg: true,
  },
  {
    prefix: "!a ",
    title: "!a <path>",
    description: "annotate an image (TINSHELL annotate app)",
    icon: "applications-graphics",
    pathArg: true,
  },
]

/** The catalogue spelling of every bang (no trailing space). */
const CANONICAL: string[] = BANG_CATALOGUE.map((b) => b.prefix.trim())

/** Alias spelling → the canonical spelling it names, built from the catalogue so
 *  an alias is declared once, on the entry it belongs to. */
const ALIASES: Map<string, string> = new Map(
  BANG_CATALOGUE.flatMap((b) => (b.aliases ?? []).map((a) => [a, b.prefix.trim()] as const)),
)

/** The bangs whose argument is a path — derived from the catalogue, so a new
 *  path bang is declared in exactly one place. */
const PATH_BANGS = new Set(BANG_CATALOGUE.filter((b) => b.pathArg).map((b) => b.prefix.trim()))

/** The catalogue entry a canonical spelling names, or null. */
export function catalogueEntry(spelling: string): BangEntry | null {
  return BANG_CATALOGUE.find((b) => b.prefix.trim() === spelling) ?? null
}

/** The row a produced bang offers: a URL to open, a value to show, an argv to
 *  run, or null when the argument names nothing this bang can serve. */
export function bangRow(
  entry: BangEntry,
  arg: string,
  env: BangEnv,
):
  | { kind: "url"; url: string; title: string }
  | { kind: "value"; value: BangValue }
  | { kind: "spawn"; argv: string[]; title: string }
  | null {
  if (entry.url) {
    const url = entry.url(arg, env)
    return url ? { kind: "url", url, title: titled(entry, arg, env) } : null
  }
  if (entry.compute) {
    const value = entry.compute(arg, env)
    return value ? { kind: "value", value } : null
  }
  if (entry.spawn) {
    const argv = entry.spawn(arg, env)
    return argv ? { kind: "spawn", argv, title: titled(entry, arg, env) } : null
  }
  return null
}

/** Split a `!bang arg…` query into its token and its argument (the argument
 *  whitespace-trimmed; an absent argument is the empty string). */
export function splitBang(input: string): { bang: string; query: string } {
  const sp = input.indexOf(" ")
  if (sp < 0) return { bang: input, query: "" }
  return { bang: input.slice(0, sp), query: input.slice(sp + 1).trim() }
}

/**
 * The bang a typed token names, or null when it names none.
 *
 * Precedence, in this order:
 *   1. an EXACT canonical spelling — `!c` stays the chromium search even though
 *      `!code` starts with it, and `!p` stays the media bang even though `!py`
 *      does;
 *   2. an EXACT ALIAS, at the same precedence — `!w` is Wikipedia while `!wc`
 *      stays the word count;
 *   3. a token that is a strict prefix of exactly ONE canonical bang, so `!co`
 *      is `!code` and `!cod` is `!code`;
 *   4. a token matching several (`!`) or none (`!zz`) names nothing.
 * Case-folded, matching the catalogue's own narrowing.
 */
export function resolveBang(token: string): string | null {
  const lower = token.toLowerCase()
  if (CANONICAL.includes(lower)) return lower
  const alias = ALIASES.get(lower)
  if (alias) return alias
  const matches = CANONICAL.filter((c) => c.startsWith(lower))
  return matches.length === 1 ? matches[0] : null
}

/**
 * The path argument of a path-taking bang (`!p`, `!code`, `!a`), or null when
 * the text is not one. The token may be an abbreviation: `!co ~/x` completes
 * as `~/x`, the same argument `!code ~/x` has.
 *
 * A bare token with nothing after it (`!p`, no argument separator) answers
 * null — there is no argument to complete. An EMPTY argument (`!p `) answers
 * the empty string: the bang is recognized and the path so far is empty, which
 * is the autofill's own contract for "complete from nothing".
 */
export function pathBangArgument(text: string): string | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("!")) return null
  const { bang, query } = splitBang(trimmed)
  const canonical = resolveBang(bang)
  if (!canonical || !PATH_BANGS.has(canonical)) return null
  // Bare token, nothing typed after it — no argument yet.
  if (trimmed.length === bang.length) return null
  return query
}

/**
 * Rewrite the entry's leading bang token to `prefix`, keeping everything typed
 * after it.
 *
 * A catalogue row is a HINT: it spells a bang out, it does not replace the
 * query. Rewriting the whole entry with the prefix would drop the argument the
 * user already typed (`!co ~/some/file` became `!code ` and the path was gone,
 * so the row then ran nothing at all).
 */
export function spliceBangToken(text: string, prefix: string): string {
  const token = /^[^ \t]*/.exec(text)?.[0] ?? ""
  return prefix + text.slice(token.length).trimStart()
}
