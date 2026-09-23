/**
 * Bang commands source.
 *
 *   !py <expr>   evaluate python; Enter copies the result (long outputs
 *                truncated + spooled to a temp file)
 *   !q  <expr>   force qalc (units/constants/currency) even when an app matches
 *   !f  <query>  open Firefox with a Google search; Enter spawns + closes
 *   !c  <query>  open Chromium with a Google search; Enter spawns + closes
 *   !n  <name>   open or create a note (TINSHELL notes app)
 *   !p  <path|glob|url>  open media in the TINSHELL media app (one row per file the
 *                argument resolves to — `~`, a relative path and a `*`/`?`
 *                pattern are resolved BEFORE the spawn)
 *   !code <path>  open a file or directory in Visual Studio Code
 *   !a  <path|glob>  open an image in the TINSHELL annotate app — resolved like
 *                `!p` and filtered to still images
 *   !wc <text>   count words (Enter copies the number)
 *   !cc <text>   count characters (Enter copies the number)
 *   !<other>     the catalogue-driven bangs, whose whole behaviour is declared
 *                as data in sources/bang-token.ts (a URL to open, a value to
 *                copy, an argv to run): web search and site search
 *                (!g/!wiki/!aw/!gh/!yt/!def/!tr/!fp/!ci), packages
 *                (!pac/!aur), the desktop (!man/!port/!grab/!pick/!kill/
 *                !mixer) and text/data (!b64/!b64d/!enc/!dec/!json/!rgb/!cron/
 *                !jwt/!epoch/!sha/!md5/!uuid). Adding one is a catalogue entry
 *                with a builder, never a branch in this file.
 *   !<unknown>   usage-hint row (so typing just `!` shows the menu)
 *
 * Only fires on a leading `!`. The token may be ABBREVIATED: an exact spelling
 * wins, then an alias, else the one catalogue bang the token is a strict prefix
 * of dispatches with the typed argument intact (`!co ~/x` runs the `!code` bang
 * on `~/x`), so a partially typed bang is never a dead end
 * (sources/bang-token.ts owns that grammar and the alias table). Empty query
 * for a known bang → no row (so the hint doesn't preempt the actual bang once
 * typed). Python uses python3 -c
 * with eval() — intentional: it's a deliberate "local python scratchpad"
 * affordance. The eval footgun is noted in launcher/AGENTS.md.
 *
 * Returns sync results for !f/!c/usage, and an async batch for !py/!q (those
 * shell out). `onBusy` reports whether an async bang is still in flight, so the
 * UI can show its loading indicator.
 *
 * A catalogue entry may OPT INTO a preview (`entry.enrich`,
 * sources/bang-token.ts): its URL row is returned sync as always and a fetched
 * payload — Arch Wiki lead, Wikipedia summary, Wiktionary senses, package
 * version — replaces it on the async slot, carrying its summary in the row's
 * DESCRIPTION and any further items as rows beneath (`sources/
 * bang-preview-fetch.ts`). The row keeps the bang's title, its Enter target and
 * its degradation: a payload that never lands shows nothing else and the row
 * the user already sees stays.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { copy } from "@common/clipboard"
import { bytesToUtf8 } from "@common/fs/bytes"
import { ignore } from "@common/log/logger"
import { isStillImage } from "@common/media/classify"
import { expandPath, globPath, isGlobQuery } from "@common/path/complete"
import { run, spawnDetached } from "@common/subprocess/run"
import { get } from "../config"
import { log } from "../log"
import type { Result, SourceResponse } from "../types"
import { fileTypeAt } from "./apps"
import { previewFor } from "./bang-preview-fetch"
import {
  BANG_CATALOGUE,
  type BangEntry,
  type BangEnv,
  bangRow,
  catalogueEntry,
  resolveBang,
  splitBang,
} from "./bang-token"
import { calc } from "./calc"
import { parseServices, type ServiceTable, servicesForPort, urlArg } from "./text-tools"
import { schemeHandlerDescription } from "./urls"
import { xdgOpenRow } from "./xdg-row"

function searchUrl(query: string): string {
  const base = get<string>("bangs.searchUrl", "https://www.google.com/search?q=")
  // urlArg percent-encodes the query as ONE URL component: a `&` typed into a
  // search stays part of it instead of starting a second parameter.
  return base + urlArg(query)
}

/** Shared row builder for the web-search bangs (!f / !c). */
function webSearchBang(key: string, icon: string, title: string, q: string): Result {
  return {
    title: `${title}: ${q}`,
    description: `open in ${icon}`,
    icon,
    category: "bang",
    run: () => {
      const browser = get<string>(key, icon)
      spawnDetached([browser, searchUrl(q)])
      return true
    },
  }
}

// !py output handling: row titles are collapsed + truncated to MAX_TITLE
// chars; outputs longer than MAX_COPY are spooled to a temp file and Enter
// copies the path instead (the full text stays reachable via the file).
const MAX_TITLE = 160
const MAX_COPY = 5000

/** Write !py output to a temp file when it's too long for the row/clipboard. */
function writeTempOutput(text: string): string | null {
  try {
    const path = `${GLib.get_tmp_dir()}/tinshell-py-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`
    GLib.file_set_contents(path, new TextEncoder().encode(text))
    return path
  } catch (e) {
    log(`bangs: failed to write temp output: ${(e as Error).message}`)
    return null
  }
}

/**
 * The bang catalogue lives in sources/bang-token.ts (with the token grammar):
 * the hint rows and the dispatch both read it, so an abbreviation resolves
 * against the very list the user is shown here.
 *
 * The catalogue row's prefix goes into the entry through a sink the launcher
 * owns (setEntryApply) — it rewrites the leading TOKEN only, never the whole
 * entry, so accepting a hint cannot cost the typed argument.
 */
export type BangApplySink = (prefix: string) => void

let entryApply: BangApplySink = () => {}
export function setEntryApply(fn: BangApplySink): void {
  entryApply = fn
}

/** The schemes the media pipeline plays as URLs — anything else is a local
 *  path (`common/media/pipeline` `toUri`). */
const URL_SCHEME = /^(https?|rtsp|rtmp|mms|srt|ftp|udp|tcp):\/\//i

/** What a bang's path argument names: the files to offer, or the reason it
 *  names none. ONE resolution rule for `!p` and `!a` — they differ only in what
 *  their app then accepts of the result (the media pipeline plays any media
 *  kind, the editor decodes stills; see each branch).
 *
 *  Resolution goes through the shared path helpers the entry's Tab autofill
 *  uses — `expandPath` (tilde + canonical form) and, for a pattern in the last
 *  segment, `globPath` (newest first, capped) — so the rows and the completion
 *  cannot disagree about what a typed path means. Only REGULAR FILES are
 *  offered: a directory, a special file or a pattern matching nothing is a
 *  REFUSAL, not a row that opens a window showing nothing (both apps refuse the
 *  same paths: apps/media/window.tsx `resolveTarget`, apps/annotate/window.tsx
 *  `resolveTarget`). `url` lets an app whose own loader plays a URL (`!p` — the
 *  media pipeline) take one instead of a local path. */
function pathTargets(
  query: string,
  opts: { url?: boolean } = {},
): {
  files: string[]
  error?: string
} {
  const typed = query.trim()
  if (opts.url && URL_SCHEME.test(typed)) return { files: [typed] }
  if (isGlobQuery(typed)) {
    const matches = globPath(typed).suggestions.filter(
      (s) => !s.isDir && fileTypeAt(s.path, { follow: true }) === Gio.FileType.REGULAR,
    )
    if (matches.length > 0) return { files: matches.map((s) => s.path) }
    return { files: [], error: `no file matches ${typed}` }
  }
  const path = expandPath(typed)
  const type = fileTypeAt(path, { follow: true })
  if (type === null) return { files: [], error: `no such file or directory: ${path}` }
  if (type === Gio.FileType.DIRECTORY) return { files: [], error: `is a directory: ${path}` }
  if (type !== Gio.FileType.REGULAR) return { files: [], error: `not a regular file: ${path}` }
  return { files: [path] }
}

/** One `!p` row: the media bang's launch for a RESOLVED file. */
function playRow(path: string): Result {
  return {
    title: `Play: ${path}`,
    description: "open in the TINSHELL media app",
    icon: "video-x-generic",
    category: "bang",
    run: () => {
      // ensure-open.sh: warm → request `open <path>`; cold → run.sh with the
      // args (the app loads the media directly — no double open).
      spawnDetached([`${GLib.get_user_config_dir()}/tinshell/apps/media/ensure-open.sh`, path])
      return true
    },
  }
}

/** One `!a` row: the annotate bang's launch for a RESOLVED still image. */
function annotateRow(path: string): Result {
  return {
    title: `Annotate: ${path}`,
    description: "open the image in the TINSHELL annotate app",
    icon: "applications-graphics",
    category: "bang",
    run: () => {
      // ensure-open.sh: routes `annotate open <path>` through the shared
      // router (tinshell-route) — the LIVE instance hosting the app serves it,
      // the shell in production. Never `ags -i annotate` (the app usually
      // has no instance of its own) and never a per-app bundle.
      spawnDetached([`${GLib.get_user_config_dir()}/tinshell/apps/annotate/ensure-open.sh`, path])
      return true
    },
  }
}

/** The refusal row a bang shows when its argument resolved to no file its app
 *  can open: the description states what was tried, so the failure surfaces
 *  HERE instead of in a spawned window showing nothing. Enter does nothing (the
 *  card has no status line, and the launcher stays open so the path can be
 *  corrected). */
function refusalRow(verb: string, query: string, error: string): Result {
  return {
    title: `Nothing to ${verb}: ${query.trim()}`,
    description: error,
    icon: "dialog-warning",
    category: "bang",
    run: () => false,
  }
}

function catalogueRow(b: BangEntry): Result {
  // The hint names the shorthand too, when the entry declares one: the alias
  // table is data on this entry, so the list that teaches the bang cannot
  // disagree with the token that reaches it.
  const shorthands = b.aliases?.length ? ` · also ${b.aliases.join(", ")}` : ""
  return {
    title: b.title,
    description: `${b.description}${shorthands}`,
    icon: b.icon,
    category: "bang",
    run: () => {
      // Insert the bang prefix into the entry; the user keeps typing.
      entryApply(b.prefix)
      return false // keep the launcher open
    },
  }
}

function catalogueRows(spelling?: string): Result[] {
  // A spelling given = the bang an abbreviated token names: its own row alone
  // (so `!co` shows the `!code` hint and nothing else).
  if (spelling) return BANG_CATALOGUE.filter((b) => b.prefix.trim() === spelling).map(catalogueRow)
  return BANG_CATALOGUE.map(catalogueRow)
}

// ── the catalogue-driven bangs ──
//
// A catalogue entry that declares a row builder (sources/bang-token.ts) is
// dispatched here: the pure builder says what the row IS (a URL to open, a
// value to copy, an argv to run) and this file supplies the host side of it
// (the row's spawn, the clipboard, the platform facilities the builders take
// as `BangEnv`). Adding a bang is then one catalogue entry and no code here.

/** The newline-free, length-bounded form of a value for a row title. */
function valueTitle(text: string): string {
  const single = text.replace(/\s+/g, " ").trim()
  return single.length > MAX_TITLE ? `${single.slice(0, MAX_TITLE).trimEnd()}…` : single
}

/** The scheme of a URL the catalogue built, so the row can name the handler
 *  the desktop associates with it. */
function schemeOf(url: string): string {
  return /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1].toLowerCase() ?? "https"
}

/** The parsed `/etc/services` table, built on the first `!port` and kept: the
 *  file is 300 KB and does not change under a running session, so the parse is
 *  deterministic content shared by every caller. */
let servicesTable: ServiceTable | null = null

function serviceTable(): ServiceTable {
  if (servicesTable) return servicesTable
  let text = ""
  try {
    const [ok, bytes] = GLib.file_get_contents("/etc/services") as [boolean, Uint8Array]
    if (ok) text = bytesToUtf8(bytes)
  } catch (e) {
    ignore("bangs: /etc/services", e)
  }
  servicesTable = parseServices(text)
  return servicesTable
}

/** The host facilities the pure row builders read. Built per dispatch — the
 *  browser and search URL come from the live config, so a config change must
 *  not be frozen into a cached object. */
function bangEnvironment(): BangEnv {
  return {
    tinshellDir: `${GLib.get_user_config_dir()}/ags`,
    browserFirefox: get<string>("bangs.browserFirefox", "firefox"),
    browserChromium: get<string>("bangs.browserChromium", "chromium"),
    searchUrl: get<string>("bangs.searchUrl", "https://www.google.com/search?q="),
    checksum: (algo, text) =>
      GLib.compute_checksum_for_string(
        algo === "sha256" ? GLib.ChecksumType.SHA256 : GLib.ChecksumType.MD5,
        text,
        -1,
      ) ?? "",
    randomUuid: () => GLib.uuid_string_random(),
    servicesForPort: (port) => servicesForPort(serviceTable(), port),
  }
}

export function bangs(input: string, onBusy: (busy: boolean) => void): SourceResponse {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith("!")) return { sync: [] }
  const { bang, query } = splitBang(trimmed)

  const sync: Result[] = []

  // A bare `!` (no space, no recognized bang) → show the catalogue as rows.
  // Typing further narrows it: e.g. `!co` shows just the !code row.
  if (bang === "!") {
    return { sync: catalogueRows() }
  }

  // An abbreviated token dispatches as the bang it uniquely names, with the
  // typed argument intact: `!co ~/shot.png` runs the `!code` bang on that
  // path. The catalogue hint stays the surface for a token that names nothing
  // (or names a bang without any argument yet).
  const cmd = resolveBang(bang) ?? bang

  // An abbreviation with no argument yet is the hint's own case (Enter
  // completes the spelling through setEntryApply, nothing typed is lost); an
  // EXACT token with an empty argument instead shows no row, so the hint never
  // preempts the bang itself (see the file header).
  if (cmd !== bang && !query) {
    return { sync: catalogueRows(cmd) }
  }

  if (cmd === "!f") {
    if (!query) return { sync: [] }
    sync.push(webSearchBang("bangs.browserFirefox", "firefox", "Search Firefox", query))
    return { sync }
  }

  if (cmd === "!c") {
    if (!query) return { sync: [] }
    sync.push(webSearchBang("bangs.browserChromium", "chromium", "Search Chromium", query))
    return { sync }
  }

  if (cmd === "!n") {
    if (!query) return { sync: [] }
    sync.push({
      title: `Note: ${query}`,
      description: "open or create in the notes app",
      icon: "text-x-generic",
      category: "bang",
      run: () => {
        // ensure-new.sh: warm → request `open <name>`; cold → run.sh with the
        // args (the app opens the note directly — no default extra note).
        spawnDetached([`${GLib.get_user_config_dir()}/tinshell/apps/notes/ensure-new.sh`, "open", query])
        return true
      },
    })
    return { sync }
  }

  if (cmd === "!p") {
    if (!query) return { sync: [] }
    const targets = pathTargets(query, { url: true })
    if (targets.error) {
      // Loud on both surfaces: the refusal row is the launcher's (no status
      // line to put it on), the log line is the one that survives a session.
      log(`bangs: !p: ${targets.error}`)
      sync.push(refusalRow("play", query, targets.error))
      return { sync }
    }
    for (const path of targets.files) sync.push(playRow(path))
    // Inline path autofill (Tab-cycling) lives in Launcher.tsx via
    // common/path/autofill — this branch only renders the Play rows.
    return { sync }
  }

  if (cmd === "!code") {
    if (!query) return { sync: [] }
    sync.push({
      title: `VS Code: ${query}`,
      description: "open file or directory in Visual Studio Code",
      icon: "vscode",
      category: "bang",
      run: () => {
        spawnDetached(["code", expandPath(query)])
        return true
      },
    })
    // Inline path autofill (Tab-cycling) covers `!code` too — see
    // Launcher.tsx's pathAutofill extract.
    return { sync }
  }

  if (cmd === "!a") {
    if (!query) return { sync: [] }
    // annotate edits STILLS: the resolved files are filtered through the shared
    // predicate the viewer and files recognise an image with, so a path the
    // editor cannot decode is refused here instead of opening an editor on
    // nothing. The resolution itself is the ONE rule shared with `!p`
    // (pathTargets).
    const targets = pathTargets(query)
    const images = targets.files.filter(isStillImage)
    if (images.length === 0) {
      const error = targets.error ?? `not a still image: ${query.trim()}`
      log(`bangs: !a: ${error}`)
      sync.push(refusalRow("annotate", query, error))
      return { sync }
    }
    for (const path of images) sync.push(annotateRow(path))
    // Inline path autofill (Tab-cycling) covers `!a` too — see
    // Launcher.tsx's pathAutofill extract.
    return { sync }
  }

  if (cmd === "!wc") {
    if (!query) return { sync: [] }
    const n = query.trim().split(/\s+/).filter(Boolean).length
    const shown = query.length > MAX_TITLE ? `${query.slice(0, MAX_TITLE).trimEnd()}…` : query
    sync.push({
      title: `${n} word${n === 1 ? "" : "s"}`,
      description: `word count of "${shown}"`,
      icon: "text-x-generic",
      category: "bang",
      run: () => {
        copy(String(n))
        return true
      },
    })
    return { sync }
  }

  if (cmd === "!cc") {
    if (!query) return { sync: [] }
    const n = [...query].length
    const shown = query.length > MAX_TITLE ? `${query.slice(0, MAX_TITLE).trimEnd()}…` : query
    sync.push({
      title: `${n} char${n === 1 ? "" : "s"}`,
      description: `char count of "${shown}"`,
      icon: "text-x-generic",
      category: "bang",
      run: () => {
        copy(String(n))
        return true
      },
    })
    return { sync }
  }

  if (cmd === "!py") {
    if (!query) return { sync: [] }
    const async = (async (): Promise<Result[]> => {
      onBusy(true)
      try {
        // Try eval() first (pure expressions: 2+2, [x for x in ...]). On
        // SyntaxError (statements: assignments, for-loops, multi-statement
        // `a=1;b=2`, imports) fall back to exec() and capture printed stdout.
        const prog =
          "import sys\n" +
          "_q = sys.argv[1]\n" +
          "try:\n" +
          "    print(eval(_q, {'__builtins__': __builtins__}, {}))\n" +
          "except SyntaxError:\n" +
          "    import io, contextlib\n" +
          "    _b = io.StringIO()\n" +
          "    with contextlib.redirect_stdout(_b):\n" +
          "        exec(_q, {'__builtins__': __builtins__}, {})\n" +
          "    sys.stdout.write(_b.getvalue())\n"
        const res = await run(["python3", "-c", prog, query], {
          timeoutMs: get<number>("calc.timeoutMs", 4000),
        })
        const out = res.stdout.trim()
        if (res.exit !== 0 || !out) return []

        // Long outputs: keep the row readable and the clipboard sane. The
        // title is always collapsed to one line + truncated; outputs beyond
        // MAX_COPY are written to a temp file and Enter copies the path.
        const singleLine = out.replace(/\s+/g, " ").trim()
        const title =
          singleLine.length > MAX_TITLE
            ? `${singleLine.slice(0, MAX_TITLE).trimEnd()}…`
            : singleLine
        let copyText = out
        let description = `python: ${query}`
        if (out.length > MAX_COPY) {
          const path = writeTempOutput(out)
          if (path) {
            description += ` · full output: ${path}`
            copyText = path
          }
        }
        return [
          {
            title,
            description,
            icon: "utilities-terminal",
            category: "bang",
            run: () => {
              copy(copyText)
              return true
            },
          },
        ]
      } catch (e) {
        log(`bangs: !py error on "${query}": ${(e as Error).message}`)
        return []
      } finally {
        onBusy(false)
      }
    })()
    return { sync: [], async }
  }

  if (cmd === "!q") {
    if (!query) return { sync: [] }
    const async = (async (): Promise<Result[]> => {
      const r = await calc(query, onBusy)
      return r ? [r] : []
    })()
    return { sync: [], async }
  }

  // A catalogue entry that owns a row builder — web search, packages, the
  // desktop, text and data. The hint row, the dispatch and the produced row all
  // read ONE catalogue, so an abbreviation cannot reach a different command
  // than the spelling it stands for.
  const entry = catalogueEntry(cmd)
  if (entry && (entry.url || entry.compute || entry.spawn)) {
    const produced = bangRow(entry, query, bangEnvironment())
    if (!produced) return { sync: [] }
    if (produced.kind === "url") {
      sync.push(
        xdgOpenRow({
          target: produced.url,
          title: produced.title,
          tag: "bangs",
          description: schemeHandlerDescription(schemeOf(produced.url)),
          icon: entry.icon,
          category: "bang",
        }),
      )
      // An enriched bang fetches its payload on the debounced slot calc rides
      // and replaces this row with it; the fetched rows keep this row's title
      // and target, so the bang's identity and what Enter does are unchanged.
      // The fetch is handed over as a THUNK: it starts when the combiner runs
      // the settled query, never on the keystroke that scheduled it.
      if (entry.enrich && query) {
        const kind = entry.enrich
        return {
          sync,
          async: () =>
            previewFor({
              kind,
              arg: query,
              title: produced.title,
              target: produced.url,
              icon: entry.icon,
              onBusy,
            }),
          replace: true,
        }
      }
      return { sync }
    }
    if (produced.kind === "value") {
      const value = produced.value
      sync.push({
        title: valueTitle(value.title),
        description: value.description,
        icon: entry.icon,
        category: "bang",
        run: () => {
          // No copy text = a refusal row (the argument named nothing this bang
          // serves): Enter keeps the launcher open so it can be corrected.
          if (value.copy === undefined) return false
          copy(value.copy)
          return true
        },
      })
      return { sync }
    }
    sync.push({
      title: valueTitle(produced.title),
      description: entry.description,
      icon: entry.icon,
      category: "bang",
      run: () => {
        spawnDetached(produced.argv)
        return true
      },
    })
    return { sync }
  }

  // Unknown bang (e.g. `!x`, `!xyz`): show the catalogue filtered by the
  // typed bang prefix, falling back to the full catalogue if nothing matches.
  // This keeps the rows tidy (one per command) and discoverable.
  const lower = bang.toLowerCase()
  const filtered = BANG_CATALOGUE.filter((b) => b.prefix.trim().toLowerCase().startsWith(lower))
  return { sync: (filtered.length ? filtered : BANG_CATALOGUE).map(catalogueRow) }
}
