/**
 * Application indexer — the "applications" source:
 *   - list .desktop entries via Gio.AppInfo.get_all()
 *   - keep only GioUnix.DesktopAppInfo that should_show() (excludes
 *     NoDisplay, Hidden, OnlyShowIn/NotShowIn mismatches)
 *   - score against name (10x weight) + keywords + genericName + description
 *   - row: icon (themed) + display name (title) + comment (description)
 *   - the entries that declare a file placeholder (%f/%F) also back the
 *     FILE rows `fileRows()` builds for a typed path — the launcher's one
 *     launch context that carries a file
 *
 * Launch path: NOT app.launch([]) — that doesn't pin the new window to the
 * workspace active at launch time, so an app started during a multi-second
 * startup delay lands on whatever workspace is active when it maps. Instead
 * we shell out to `hyprctl dispatch "hl.dsp.exec_cmd(cmd, {workspace=N})"`,
 * pinning the launch to the active workspace (captured BEFORE launch). This
 * is Hyprland's PID-scoped initial-workspace mechanism (survives the startup
 * delay; does NOT move existing same-class windows). Falls back to
 * app.launch(files) if hyprctl/the workspace read fails.
 *
 * Exec handling: the entry's Exec is parsed to argv (GLib.shell_parse_argv)
 * and its field codes are expanded against the launch (exec-fields.ts), then
 * each argument is shell-quoted back into ONE command line (shq) — the string
 * `hl.dsp.exec_cmd` hands to `sh -c`. So a file (or an entry name) carrying a
 * space stays a single argument, a placeholder is never handed over as literal
 * text, and the quotes survive the Lua string literal the dispatch wraps the
 * command in (`common/hyprland/lua-string`). A launch with no file omits the
 * file placeholders instead of running the app with a missing argument.
 *
 * Uses GioUnix.DesktopAppInfo (NOT Gio.DesktopAppInfo) — the class lives in
 * gi://GioUnix on this GLib; get_all() and the field getters work there.
 *
 * No live .desktop watching — reload() is called on demand via the
 * `apps reload` request.
 */
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import { launchPinned } from "@common/hyprland/dispatch"
import { ignore } from "@common/log/logger"
import { shq } from "@common/subprocess/quote"
import { fuzzyScore, rank } from "@common/text"
import { log } from "../log"
import type { Result, SourceResponse } from "../types"
import { expandExec } from "./exec-fields"

export interface AppEntry {
  app: GioUnix.DesktopAppInfo
  name: string
  display: string
  description: string
  keywords: string
  generic: string
  /** the entry's declared MimeType list, empty when it declares none */
  mimeType: string
  /** first themed icon name, if any */
  iconName: string | null
}

let cache: AppEntry[] = []

function iconNameOf(app: GioUnix.DesktopAppInfo): string | null {
  const icon = app.get_icon()
  if (!icon) return null
  if (icon instanceof Gio.ThemedIcon && icon.names && icon.names.length) {
    return icon.names[0]
  }
  return null
}

export function reload(): void {
  const all = [...Gio.AppInfo.get_all()]
  cache = all
    .filter(
      (a): a is GioUnix.DesktopAppInfo => a instanceof GioUnix.DesktopAppInfo && a.should_show(),
    )
    .map((app) => ({
      app,
      name: app.get_name() ?? "",
      display: app.get_display_name() ?? app.get_name() ?? "",
      description: app.get_description() ?? "",
      keywords: app.get_string("Keywords") ?? "",
      generic: app.get_string("GenericName") ?? "",
      mimeType: app.get_string("MimeType") ?? "",
      iconName: iconNameOf(app),
    }))
  log(`apps: indexed ${cache.length} visible applications`)
}

/** The entry's Exec as argv — GLib's own parse, with a whitespace split as the
 *  fallback for an Exec whose quoting GLib rejects. */
function execArgvOf(raw: string): string[] {
  try {
    const [ok, argv] = GLib.shell_parse_argv(raw) as [boolean, string[]]
    if (ok && argv) return argv
  } catch (e) {
    ignore("exec parse", e)
  }
  return raw.trim().split(/\s+/).filter(Boolean)
}

/** The file's URI, so a file launch can also satisfy `%u`/`%U`. */
function fileUri(path: string): string | null {
  try {
    return Gio.File.new_for_path(path).get_uri()
  } catch (e) {
    ignore("file uri", e)
    return null
  }
}

/**
 * The type at `path`, or null when nothing is there or the query fails. ONE
 * stat helper for every path question the launcher asks. `follow` decides
 * symlink handling: the path source does NOT follow, so a dangling symlink
 * reads as a symlink rather than as its absent target, while a `!p`/`!a` path
 * argument does — those bangs ask what the pipeline would open, not how the
 * entry is spelled on disk.
 */
export function fileTypeAt(path: string, opts: { follow?: boolean } = {}): Gio.FileType | null {
  try {
    const flags = opts.follow
      ? Gio.FileQueryInfoFlags.NONE
      : Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS
    const type = Gio.File.new_for_path(path).query_file_type(flags, null)
    return type === Gio.FileType.UNKNOWN ? null : type
  } catch (e) {
    ignore("file type", e)
    return null
  }
}

/**
 * The command line to run for this entry: its Exec argv with the field codes
 * expanded against the launch context, each argument shell-quoted — the pinned
 * launch runs the string through `sh -c`, so an argument's spaces, quotes and
 * metacharacters must be quoted for that shell, not for the Lua dispatch that
 * carries the string (`common/hyprland/lua-string`).
 * `file` is the file the launch carries — the file placeholders (%f/%F) and
 * the URL placeholders (%u/%U, as the file's URI) take it; a launch without
 * one omits them. Returns null when the entry declares no Exec.
 */
function commandFor(app: GioUnix.DesktopAppInfo, file?: string): string | null {
  const raw = app.get_commandline()
  if (!raw) return null
  const uri = file ? fileUri(file) : null
  const argv = expandExec(execArgvOf(raw), {
    files: file ? [file] : [],
    urls: uri ? [uri] : [],
    name: app.get_name() ?? "",
    iconName: iconNameOf(app),
    desktopPath: app.get_filename(),
  })
  if (argv.length === 0) return null
  return argv.map(shq).join(" ")
}

/**
 * Launch an app, pinned to the workspace active at launch time. Uses the
 * shared Hyprland helper (common/hyprland/dispatch): hl.dsp.exec_cmd with a
 * workspace rule (PID-scoped initial workspace — survives the app's startup
 * delay; doesn't move existing same-class windows). When `float` is true the
 * launch also floats (stacked on top of the tiled layout) via the same
 * helper's float initial rule. The helper reads the active workspace and
 * falls back to a bare unpinned launch if hyprctl is unavailable.
 * Fire-and-forget (called from a click/Enter handler).
 */
function launch(app: GioUnix.DesktopAppInfo, opts: { float?: boolean; file?: string } = {}): void {
  const cmd = commandFor(app, opts.file)
  if (cmd) {
    void launchPinned(cmd, undefined, opts.float)
    return
  }
  // Fallback: GIO launch (inherits env but does NOT pin workspace). Its own
  // field-code expansion handles the file the same way.
  try {
    app.launch(opts.file ? [Gio.File.new_for_path(opts.file)] : [], null)
  } catch (e) {
    log(`apps: launch failed: ${(e as Error).message}`)
  }
}

/**
 * Launch on the NVIDIA dGPU via prime-run, workspace-pinned like `launch`.
 * Clears the suite's GPU-wake pins first: prime-run's
 * `__VK_LAYER_NV_optimus=NVIDIA_only` requires the NVIDIA Vulkan ICD to be
 * enumerable, and the session-wide VK_ICD_FILENAMES=radeon pin (which keeps
 * the dGPU suspended) would block it.
 */
function launchPrime(app: GioUnix.DesktopAppInfo, file?: string): void {
  const cmd = commandFor(app, file)
  if (!cmd) return
  void launchPinned(`env -u VK_ICD_FILENAMES -u __EGL_VENDOR_LIBRARY_FILENAMES prime-run ${cmd}`)
}

function toResult(entry: AppEntry): Result {
  return {
    title: entry.display || entry.name,
    description: entry.description || undefined,
    icon: entry.iconName ?? "application-x-executable",
    category: "app",
    run: () => {
      launch(entry.app)
      return true // hide after launch
    },
    runPrime: () => {
      launchPrime(entry.app)
      return true
    },
    runStack: () => {
      launch(entry.app, { float: true })
      return true
    },
  }
}

/**
 * A row for one of the entries that declare a file placeholder, carrying the
 * file: the row's launch threads `path` into the entry's Exec (%f/%F), so the
 * app receives the file the user typed instead of a bare executable.
 */
function fileResult(entry: AppEntry, path: string): Result {
  return {
    title: `Open with ${entry.display || entry.name}`,
    description: GLib.path_get_basename(path),
    icon: entry.iconName ?? "application-x-executable",
    category: "app",
    run: () => {
      launch(entry.app, { file: path })
      return true // hide after launch
    },
    runPrime: () => {
      launchPrime(entry.app, path)
      return true
    },
    runStack: () => {
      launch(entry.app, { float: true, file: path })
      return true
    },
  }
}

/**
 * The rows for an existing file: one per visible entry that declares a file
 * placeholder (GAppInfo.supports_files() — the Exec carries %f/%F). Ordered by
 * relevance to the file — the entries that declare its type, then the entries
 * that declare no type at all (they ask for any file), then the rest — because
 * the combiner caps the list. A DIRECTORY has no such rows (the path source
 * keeps its single row).
 */
export function fileRows(path: string, contentType: string | null): Result[] {
  if (cache.length === 0) reload()
  const relevance = (e: AppEntry): number => {
    if (contentType && e.mimeType.split(";").includes(contentType)) return 0
    return e.mimeType === "" ? 1 : 2
  }
  return cache
    .filter((e) => e.app.supports_files())
    .sort((a, b) => relevance(a) - relevance(b))
    .map((e) => fileResult(e, path))
}

/**
 * Score one entry against query. Name (and display) weighted 10x;
 * keywords/genericName get the base weight; description the lightest.
 */
function scoreEntry(entry: AppEntry, q: string): number {
  const name = fuzzyScore(q, entry.name)
  const display = fuzzyScore(q, entry.display)
  const kw = fuzzyScore(q, entry.keywords)
  const gen = fuzzyScore(q, entry.generic)
  const desc = fuzzyScore(q, entry.description)
  const nameBest = Math.max(name, display)
  return nameBest * 10 + kw + gen + desc
}

/** How many app rows the launcher offers: the SOURCE's own bound, since the
 *  list scrolls and carries no result cap. Every visible desktop entry is
 *  offered (~50 on this machine) and `rank` already ordered them best-first. */
const APP_LIMIT = 60

export function search(input: string): SourceResponse {
  const q = input.trim()
  if (!q) return { sync: [] }
  if (cache.length === 0) reload()
  const ranked = rank(cache, (e) => scoreEntry(e, q))
  return { sync: ranked.slice(0, APP_LIMIT).map((r) => toResult(r.item)) }
}
