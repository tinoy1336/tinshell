/**
 * URL source — a typed URL offers one row that opens it with xdg-open, the
 * desktop's own "open this" contract.
 *
 * Detection: a query is a URL when it begins with an explicit scheme —
 * `[a-zA-Z][a-zA-Z0-9+.-]*:` followed by at least one more character — AND
 * that scheme is either one a real URI uses (the list below), one the desktop
 * actually has a handler for, or one of the SHORTCUT schemes this source
 * answers itself (`gh:`, `wiki:`, `aur:` …). A scheme outside all three is far
 * more likely to be a typed label than a URL: without that test `note: buy
 * milk` would be claimed as a URL, suppress the app search and answer "no
 * application handles the note scheme". A BARE DOMAIN (`example.com`) is
 * deliberately NOT a URL: the app search and the `!f`/`!c` bangs own that
 * shape, so claiming it here would replace their rows with one link row. Those
 * are scope decisions, not oversights.
 *
 * Shortcut schemes are the typed-query spelling of the site bangs: `gh:` is
 * `!gh`, `wiki:` is `!wiki`. Each rewrites the argument into the real URL
 * through `text-tools`' `SITE` table — the SAME builder the bang uses — so the
 * two entry points cannot disagree about a site's query URL, and the row then
 * opens a URL the desktop can actually handle.
 *
 * Handler: `Gio.AppInfo.get_default_for_uri_scheme` names the application the
 * desktop associates with the scheme (http/https/mailto → the browser; a
 * scheme no application handles → null). The row states that name, or states
 * that no application handles the scheme. The lookup is an in-process read
 * GLib caches, so it runs as the row is built; a lookup failure falls back to
 * the generic wording rather than losing the row.
 *
 * Activating the row hands the URL to `xdg-open`, so the desktop resolves the
 * handler itself. The launcher never guesses a handler and never imports
 * another app's modules.
 */
import Gio from "gi://Gio"
import { ignore } from "@common/log/logger"
import { get } from "../config"
import type { SourceResponse } from "../types"
import { SITE } from "./text-tools"
import { xdgOpenRow } from "./xdg-row"

/** Explicit scheme, then a non-empty remainder. */
const URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):([\s\S]+)$/

/** Schemes a URI really uses. Membership lets the row say that nothing handles
 *  an unhandled one (`ftp` here) instead of staying silent, which is the whole
 *  point of naming the handler. Anything outside this set must resolve to a
 *  real handler to count as a URL at all. */
const URI_SCHEMES = new Set([
  "http",
  "https",
  "ftp",
  "ftps",
  "file",
  "mailto",
  "magnet",
  "nfs",
  "sftp",
  "smb",
  "sms",
  "ssh",
  "tel",
  "webcal",
])

/**
 * The schemes this source answers ITSELF: the argument after the colon is
 * rewritten into the real URL, so `aur:hyprland` opens the AUR search page
 * without a bang. Every builder is the site table's, shared with the bang of
 * the same name — one declaration of each site's query URL.
 */
const SHORTCUT_SCHEMES: Record<string, (rest: string) => string | null> = {
  g: (rest) =>
    SITE.search(get<string>("bangs.searchUrl", "https://www.google.com/search?q="), rest),
  gh: (rest) => SITE.github(rest),
  wiki: (rest) => SITE.wikipedia(rest),
  aw: (rest) => SITE.archWiki(rest),
  yt: (rest) => SITE.youtube(rest),
  pac: (rest) => SITE.archPackage(rest),
  aur: (rest) => SITE.aur(rest),
  def: (rest) => SITE.dictionary(rest),
}

/** URL-shaped query — an explicit URI scheme, a scheme with a handler, or one
 *  of the shortcut schemes. See the module note for why a bare domain and a
 *  handlerless made-up scheme are both excluded. */
export function isUrlQuery(input: string): boolean {
  const parsed = parseUrl(input)
  if (!parsed) return false
  const scheme = parsed.scheme.toLowerCase()
  if (scheme in SHORTCUT_SCHEMES) return true
  if (URI_SCHEMES.has(scheme)) return true
  // A scheme nobody implements is a label, not a URL. The lookup is an
  // in-process read GLib caches, so this stays cheap per keystroke.
  return typeof handlerName(scheme) === "string"
}

function parseUrl(input: string): { scheme: string; url: string; rest: string } | null {
  const trimmed = input.trim()
  const m = URL_RE.exec(trimmed)
  if (!m) return null
  return { scheme: m[1], url: trimmed, rest: m[2] }
}

/** Name of the application that handles `scheme`: null when no application
 *  does, undefined when the lookup itself failed. */
function handlerName(scheme: string): string | null | undefined {
  try {
    const info = Gio.AppInfo.get_default_for_uri_scheme(scheme)
    if (!info) return null
    return info.get_name() ?? info.get_display_name() ?? undefined
  } catch (e) {
    ignore("url scheme handler", e)
    return undefined
  }
}

/** The handler's name, the absence of one, or the generic wording when the
 *  lookup is unavailable. Exported so a bang row that opens a URL can name its
 *  handler through this ONE lookup (sources/bangs.ts). */
export function schemeHandlerDescription(scheme: string): string {
  const name = handlerName(scheme)
  if (name === undefined) return "open with the default application"
  if (name === null) return `no application handles the ${scheme} scheme`
  return `open with ${name}`
}

export function urls(input: string): SourceResponse {
  const parsed = parseUrl(input)
  if (!parsed) return { sync: [] }
  const scheme = parsed.scheme.toLowerCase()
  // A shortcut scheme rewrites the argument into the URL the desktop opens;
  // everything else hands the typed URL over unchanged.
  const shortcut = SHORTCUT_SCHEMES[scheme]?.(parsed.rest) ?? null
  const target = shortcut ?? parsed.url
  const open = xdgOpenRow({
    target,
    tag: "urls",
    description: schemeHandlerDescription(shortcut ? "https" : scheme),
    icon: "insert-link",
    category: "url",
  })
  return { sync: [open] }
}
