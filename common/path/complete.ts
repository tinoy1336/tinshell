/**
 * Filesystem path completion — shared by the launcher's !p bang (path
 * autofill), promptd's input dialog, the dock's screengrab save-location entry
 * and the card path bar's Ctrl+L entry. Logic only: each surface wires its own inline Tab-cycling UI via
 * `createPathAutofill` (@common/path/autofill); all call `completePath`, and a
 * pattern query (`isGlobQuery`) is answered by `globPath`. `isPathShaped` is
 * the shared path-shape rule a surface gates its completion on.
 *
 * RUNTIME CONTRACT (gjs 1.88.1): the
 * Gio async methods have NO Promise overloads despite the @girs .d.ts, and
 * FileEnumerator has NO sync `next_files()` (TypeError — only the singular
 * `next_file()` loop below and the async variants exist). This module uses
 * SYNC enumeration: completion is key-driven (Tab) and needs results
 * synchronously. `GLib.dir_open` is NOT a function — Gio enumeration only.
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ignore } from "@common/log/logger"

/** One path-completion suggestion. */
export interface PathSuggestion {
  /** Full expanded absolute path (dirs: NO trailing slash). */
  path: string
  /** Basename / display name. */
  name: string
  isDir: boolean
}

interface CompletePathOpts {
  maxResults?: number
  /** Only directories (the screengrab save-location use). */
  dirsOnly?: boolean
}

/** Expand a leading `~` to $HOME. Tilde ONLY — no trimming, no
 *  canonicalization: "" stays "", and a relative path stays relative (the
 *  contract common/fs's `resolvePath` exposes). ONE implementation: every
 *  tilde expansion in the repo goes through here. */
export function expandTilde(p: string): string {
  return p.startsWith("~") ? GLib.get_home_dir() + p.slice(1) : p
}

/** Expand a typed path: trim, "" / "~" → home, "~/x" → home/x, then
 *  canonicalize (best-effort — falls back to the plain expanded path). */
export function expandPath(p: string): string {
  const trimmed = p.trim()
  const expanded = trimmed === "" ? GLib.get_home_dir() : expandTilde(trimmed)
  try {
    const canon = GLib.canonicalize_filename(expanded, null)
    if (canon) return canon
  } catch (e) {
    ignore("path canonicalize", e)
  }
  return expanded.startsWith("/") ? expanded : GLib.build_filenamev([GLib.get_home_dir(), expanded])
}

const LIST_ATTRS = "standard::name,standard::type,time::modified"

/** One directory entry as `enumerate_children` reports it. `mtime` is Unix
 *  seconds (0 when the attribute is absent). */
interface DirEntry {
  name: string
  isDir: boolean
  mtime: number
}

/** List a directory's children, synchronously. Never throws — [] on error. */
function listChildrenSync(dir: string): DirEntry[] {
  try {
    const file = Gio.File.new_for_path(dir)
    const enumerator = file.enumerate_children(LIST_ATTRS, Gio.FileQueryInfoFlags.NONE, null)
    const out: DirEntry[] = []
    for (;;) {
      const info = enumerator.next_file(null)
      if (info === null) break
      const name = info.get_name()
      if (name === "." || name === "..") continue
      out.push({
        name,
        isDir: info.get_file_type() === Gio.FileType.DIRECTORY,
        mtime: info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED),
      })
    }
    return out
  } catch (_) {
    return []
  }
}

/** True when the text names a path EXPLICITLY — a leading `/`, `~`, `./` or
 *  `../`. A bare word is deliberately NOT a path even when a directory of that
 *  name exists: resolving bare words would hijack ordinary word searches
 *  ("music" would complete a directory instead of naming the music player).
 *  That is a scope decision, not an oversight. This is the ONE path-shape rule
 *  — the launcher's path row and its entry autofill and promptd's input dialog
 *  all gate on it, so they cannot drift. */
export function isPathShaped(input: string): boolean {
  const q = input.trim()
  return q.startsWith("/") || q.startsWith("~") || q.startsWith("./") || q.startsWith("../")
}

/** Glob metacharacters a candidate pattern may use. */
const GLOB_META = /[*?]/

/** Default bound on the glob candidate list: a pattern matching thousands of
 *  entries must not build a thousands-long Tab cycle. */
export const GLOB_MAX_RESULTS = 50

/** True when the typed path's BASENAME (the segment after the last `/`) carries
 *  a glob metacharacter, e.g. `~/downloads/*.html`. Only that one segment is a
 *  pattern — the segments before it are a literal directory name, so a pattern
 *  in an earlier segment names a directory that does not exist and yields no
 *  candidates; a trailing separator leaves the last segment empty, so it lists
 *  nothing either. That is a scope decision: the cycle globs one directory
 *  level, and `*` and `?` are the only metacharacters (GPatternSpec has no
 *  bracket classes and no brace expansion, a pattern is never expanded by a
 *  shell, and — gjs exposing only `match_string` — matching is
 *  case-sensitive). */
export function isGlobQuery(input: string): boolean {
  const raw = input.trim()
  const lastSlash = raw.lastIndexOf("/")
  const base = lastSlash < 0 ? raw : raw.slice(lastSlash + 1)
  return GLOB_META.test(base)
}

/** Glob completion result: the candidate list plus how many matches the cap
 *  hid, so a caller can report a partial cycle instead of showing one
 *  silently. */
interface GlobResult {
  suggestions: PathSuggestion[]
  hidden: number
}

/** Candidates for a pattern query: the LAST directory's entries whose basename
 *  the pattern matches, NEWEST FIRST (mtime descending, name as the tie-break)
 *  so the file just downloaded is the first Tab. Hidden entries are excluded
 *  unless the pattern itself starts with a dot (`~/.config/.*`). Never throws —
 *  an empty result on any error. */
export function globPath(input: string, opts: CompletePathOpts = {}): GlobResult {
  try {
    const expanded = expandPath(input)
    const lastSlash = expanded.lastIndexOf("/")
    const dirPart = lastSlash <= 0 ? "/" : expanded.slice(0, lastSlash)
    const pattern = lastSlash < 0 ? expanded : expanded.slice(lastSlash + 1)
    const spec = new GLib.PatternSpec(pattern)
    const wantHidden = pattern.startsWith(".")
    const matches = listChildrenSync(dirPart).filter(
      (c) =>
        (wantHidden || !c.name.startsWith(".")) &&
        (!opts.dirsOnly || c.isDir) &&
        spec.match_string(c.name),
    )
    matches.sort(
      (a, b) => b.mtime - a.mtime || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    )
    const cap = Math.max(1, opts.maxResults ?? GLOB_MAX_RESULTS)
    const shown = matches.slice(0, cap)
    return {
      suggestions: shown.map((c) => ({
        path: dirPart === "/" ? "/" + c.name : dirPart + "/" + c.name,
        name: c.name,
        isDir: c.isDir,
      })),
      hidden: matches.length - shown.length,
    }
  } catch (_) {
    return { suggestions: [], hidden: 0 }
  }
}

/** Suggest dirs/files under the typed path's parent, prefix-matched (case-
 *  insensitive), dirs first. Never throws — [] on any error or empty match. */
export function completePath(input: string, opts: CompletePathOpts = {}): PathSuggestion[] {
  try {
    const expanded = expandPath(input)
    const raw = input.trim()

    const trailingSlash = raw.endsWith("/") || raw === "~" || raw.trim() === ""
    // Typing a trailing "/" lists that dir's children; otherwise split at the
    // last "/" into the parent dir + the partial basename being completed.
    const lastSlash = expanded.lastIndexOf("/")
    const dirPart = trailingSlash
      ? expanded.replace(/\/+$/, "") || "/"
      : lastSlash <= 0
        ? "/"
        : expanded.slice(0, lastSlash)
    const partial = trailingSlash ? "" : lastSlash < 0 ? expanded : expanded.slice(lastSlash + 1)

    const children = listChildrenSync(dirPart)
    if (children.length === 0) return []

    const wantHidden = partial.startsWith(".")
    const lcPartial = partial.toLowerCase()
    const sugs: PathSuggestion[] = []
    for (const c of children) {
      if (!wantHidden && c.name.startsWith(".")) continue
      if (!c.name.toLowerCase().startsWith(lcPartial)) continue
      if (opts.dirsOnly && !c.isDir) continue
      sugs.push({
        path: dirPart === "/" ? "/" + c.name : dirPart + "/" + c.name,
        name: c.name,
        isDir: c.isDir,
      })
    }
    sugs.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    })
    return sugs.slice(0, opts.maxResults ?? 12)
  } catch (_) {
    return []
  }
}
