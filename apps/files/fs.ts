/**
 * files fs backend — Gio filesystem operations.
 *
 * Listing (async enumeration), live watching (GFileMonitor), mkdir, rename,
 * trash/delete, open-with-default, free space, and the file-type → Nerd Font
 * glyph map. Errors NEVER throw out of the app: every operation returns
 * `{ ok, error? }` and the window surfaces failures in the status bar.
 *
 * Verified on this machine:
 *  - gvfs is NOT installed, yet `Gio.File.trash` works on real filesystems
 *    (ext4 → ~/.local/share/Trash) via GLib's built-in local trash. It fails
 *    with "Trashing on system internal mounts is not supported" on tmpfs
 *    (/tmp) — that failure surfaces as a status-bar error, never a crash.
 *  - The Gio async methods are CALLBACK-ONLY in this gjs (1.88.1) despite
 *    the @girs Promise overloads: enumerate_children_async needs 5 args,
 *    next_files_async 4, launch_default_for_uri_async 4 (finish =
 *    Gio.AppInfo.launch_default_for_uri_finish). Promisified below.
 *  - `GLib.dir_open` is NOT a function in gjs (C macro) — Gio enumeration
 *    only (the notes GOTCHA).
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ignore, log } from "@common/log/logger"
import { expandTilde } from "@common/path/complete"

export interface DirEntry {
  /** raw file name */
  name: string
  /** display name (standard::display-name) */
  displayName: string
  /** absolute path */
  path: string
  isDir: boolean
  isSymlink: boolean
  isExecutable: boolean
  /** name starts with a dot (hidden) */
  hidden: boolean
  /** bytes (0 for dirs/symlinks) */
  size: number
  /** mtime ms epoch */
  modifiedMs: number
}

/** Result of a mutating/launch operation — never throws; error is status-bar text. */
export interface OpResult {
  ok: boolean
  error?: string
}

/** Attributes fetched in ONE query batch per file (no content-type — extra
 *  queries per row are slow on big dirs; classification is by type + ext). */
const LIST_ATTRS =
  "standard::name,standard::type,standard::size,standard::display-name,time::modified,unix::mode"

/** List a directory asynchronously. NOFOLLOW_SYMLINKS so symlinks stay
 *  SYMBOLIC_LINK type (symlink glyphs + resolve-on-open in the UI).
 *
 *  RUNTIME CONTRACT (gjs 1.88.1 on this machine): the Gio
 *  async methods have NO Promise overloads despite the @girs .d.ts —
 *  enumerate_children_async requires 5 args (callback), next_files_async 4
 *  args (callback). The promisify helpers below are the binding-gap fix. */
export async function listDirAsync(
  dir: string,
  cancellable: Gio.Cancellable | null,
): Promise<{ ok: boolean; items?: DirEntry[]; error?: string }> {
  try {
    const file = Gio.File.new_for_path(dir)
    const enumerator = await enumerateChildrenAsync(
      file,
      LIST_ATTRS,
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      cancellable,
    )
    const items: DirEntry[] = []
    for (;;) {
      const infos = await nextFilesAsync(enumerator, 512, cancellable)
      if (infos.length === 0) break
      for (const info of infos) {
        const name = info.get_name()
        if (name === "." || name === "..") continue
        const type = info.get_file_type()
        items.push({
          name,
          displayName: info.get_display_name() || name,
          path: GLib.build_filenamev([dir, name]),
          isDir: type === Gio.FileType.DIRECTORY,
          isSymlink: type === Gio.FileType.SYMBOLIC_LINK,
          isExecutable: (info.get_attribute_uint32("unix::mode") & 0o111) !== 0,
          hidden: name.startsWith("."),
          size: info.get_size(),
          // to_unix() returns SECONDS — modifiedMs and formatDate() are ms epoch
          modifiedMs: (info.get_modification_date_time()?.to_unix() ?? 0) * 1000,
        })
      }
    }
    return { ok: true, items }
  } catch (e) {
    const msg = String(e)
    log(`[fs] list failed ${dir}: ${msg}`)
    return { ok: false, error: friendlyError(msg) }
  }
}

/** Promisify Gio.File.enumerate_children_async (callback-only in this gjs). */
function enumerateChildrenAsync(
  file: Gio.File,
  attrs: string,
  flags: Gio.FileQueryInfoFlags,
  cancellable: Gio.Cancellable | null,
): Promise<Gio.FileEnumerator> {
  return new Promise((resolve, reject) => {
    try {
      file.enumerate_children_async(attrs, flags, GLib.PRIORITY_DEFAULT, cancellable, (_f, res) => {
        try {
          resolve(file.enumerate_children_finish(res))
        } catch (e) {
          reject(e)
        }
      })
    } catch (e) {
      reject(e)
    }
  })
}

/** Promisify Gio.FileEnumerator.next_files_async (callback-only in this gjs). */
function nextFilesAsync(
  enumerator: Gio.FileEnumerator,
  num: number,
  cancellable: Gio.Cancellable | null,
): Promise<Gio.FileInfo[]> {
  return new Promise((resolve, reject) => {
    try {
      enumerator.next_files_async(num, GLib.PRIORITY_DEFAULT, cancellable, (_e, res) => {
        try {
          resolve(enumerator.next_files_finish(res))
        } catch (e) {
          reject(e)
        }
      })
    } catch (e) {
      reject(e)
    }
  })
}

// ── sorting (dirs first, then the chosen column — Intl.Collator by name) ──

const collator = new Intl.Collator("en", { sensitivity: "base" })

/** The columns a header click can sort the listing by. */
export type SortKey = "name" | "size" | "modified"

/** The listing order: which column to sort by, and which way. */
interface SortOrder {
  key: SortKey
  ascending: boolean
}

/** THE listing comparator: the config's dirs-first rule (folders stay on top
 *  whichever way the sort runs), then the chosen column in the chosen direction,
 *  and name ASCENDING to break ties — two files of one size, or of one modified
 *  second, then keep one readable order rather than the enumeration order, and
 *  the direction applies to the sorted COLUMN, not to the tie-break. The name
 *  column is the tie-break itself, so its own direction applies to it. Shared
 *  by the render sort and the column sorters the headers carry. */
export function compareEntries(
  a: DirEntry,
  b: DirEntry,
  order: SortOrder,
  dirsFirst: boolean,
): number {
  if (dirsFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1
  if (order.key !== "name") {
    const byKey = order.key === "size" ? a.size - b.size : a.modifiedMs - b.modifiedMs
    const signed = order.ascending ? byKey : -byKey
    if (signed !== 0) return signed
  }
  const byName = collator.compare(a.displayName, b.displayName)
  return order.key === "name" && !order.ascending ? -byName : byName
}

// ── mutations (sync — fast local ops; errors returned, never thrown) ──

export function mkdirSync(path: string): OpResult {
  try {
    Gio.File.new_for_path(path).make_directory(null)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: friendlyError(String(e)) }
  }
}

export function renameSync(from: string, newName: string): OpResult {
  const clean = newName.trim()
  if (!clean || clean === "." || clean === ".." || clean.includes("/")) {
    return { ok: false, error: "invalid name" }
  }
  try {
    // @ts-expect-error runtime-correct; TS TS2554 is a @girs typing gap
    Gio.File.new_for_path(from).set_display_name(clean)
    return { ok: true }
  } catch (e) {
    // Fallback: explicit move with overwrite (also handles case-only renames).
    try {
      const target = GLib.build_filenamev([GLib.path_get_dirname(from), clean])
      Gio.File.new_for_path(from).move(
        Gio.File.new_for_path(target),
        Gio.FileCopyFlags.OVERWRITE,
        null,
        null,
      )
      return { ok: true }
    } catch (e2) {
      return { ok: false, error: friendlyError(String(e2)) }
    }
  }
}

export function trashSync(path: string): OpResult {
  try {
    Gio.File.new_for_path(path).trash(null)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: friendlyError(String(e)) }
  }
}

export function deleteSync(path: string): OpResult {
  try {
    Gio.File.new_for_path(path).delete(null)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: friendlyError(String(e)) }
  }
}

/** Open a file with its xdg-mime default app (respects the user's defaults;
 *  directories are NOT opened here — the UI navigates into them).
 *
 *  RUNTIME CONTRACT: launch_default_for_uri_async needs 4
 *  args (callback) and its finish is Gio.AppInfo.launch_default_for_uri_finish
 *  (NOT ..._async_finish). Falls back to the sync launch on any failure. */
export function openWithDefault(path: string): Promise<OpResult> {
  const uri = Gio.File.new_for_path(path).get_uri()
  return new Promise((resolve) => {
    try {
      Gio.AppInfo.launch_default_for_uri_async(uri, null, null, (_src, res) => {
        try {
          const ok = Gio.AppInfo.launch_default_for_uri_finish(res)
          resolve(ok ? { ok: true } : { ok: false, error: "no default application" })
        } catch (e) {
          resolve(launchSync(uri))
        }
      })
    } catch (e) {
      resolve(launchSync(uri))
    }
  })
}

function launchSync(uri: string): OpResult {
  try {
    const ok = Gio.AppInfo.launch_default_for_uri(uri, null)
    return ok ? { ok: true } : { ok: false, error: "no default application" }
  } catch (e) {
    log(`[fs] open failed ${uri}: ${e}`)
    return { ok: false, error: friendlyError(String(e)) }
  }
}

// ── free space ──

export function freeSpace(path: string): { free: number; total: number } | null {
  try {
    const info = Gio.File.new_for_path(path).query_filesystem_info(
      "filesystem::free,filesystem::size",
      null,
    )
    const total = info.get_attribute_uint64("filesystem::size")
    if (total === 0) return null
    return { free: info.get_attribute_uint64("filesystem::free"), total }
  } catch (e) {
    log(`[fs] freeSpace failed ${path}: ${e}`)
    return null
  }
}

// ── live watching ──

interface DirMonitor {
  cancel(): void
}

/** Watch a directory; `onChanged` fires (debounced by the caller) for any
 *  filesystem event. WATCH_MOVES is required for RENAMED/MOVED_IN/MOVED_OUT.
 *  Known limitation (documented in AGENTS.md): GFileMonitor is unreliable on
 *  some filesystems (FUSE/network mounts) — Ctrl+R is the manual fallback. */
export function monitorDir(path: string, onChanged: () => void): DirMonitor {
  let monitor: Gio.FileMonitor | null = null
  try {
    monitor = Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)
    monitor.connect("changed", () => onChanged())
  } catch (e) {
    log(`[fs] monitor failed ${path}: ${e}`)
  }
  return {
    cancel() {
      if (monitor) {
        try {
          monitor.cancel()
        } catch (e) {
          // The kernel watch is already gone (path unmounted/removed).
          ignore("file monitor cancel", e)
        }
        monitor = null
      }
    },
  }
}

// ── paths ──

/** Resolve a possibly-relative/`~` path to an absolute canonical path. Tilde
 *  expansion is the shared `expandTilde` (`common/path/complete`) — the ONE
 *  implementation every tilde expansion in the repo goes through — and this
 *  function keeps only the `file://` handling and the absolute-form fallback
 *  the browser's navigation needs. */
export function absolutePath(p: string): string {
  let raw = p.trim() || "~"
  if (raw.startsWith("file://")) {
    raw = raw.slice("file://".length)
    if (raw.startsWith("localhost")) raw = raw.slice("localhost".length)
    try {
      raw = decodeURIComponent(raw)
    } catch (e) {
      // Malformed escapes stay as-is — the raw path is still usable.
      ignore("uri decode", e)
    }
  }
  const expanded = expandTilde(raw)
  try {
    const canon = GLib.canonicalize_filename(expanded, null)
    if (canon) return canon
  } catch (e) {
    ignore("path canonicalize", e)
  }
  return expanded.startsWith("/") ? expanded : GLib.build_filenamev([GLib.get_home_dir(), expanded])
}

/** Gate a path before navigating to it: only an existing directory passes.
 *  The check opens the directory the way the listing does and closes it again
 *  without reading it, so a path that is gone, is not a directory, or cannot
 *  be read answers the LISTING's own error text — the same status line a
 *  navigation into a vanished directory produces. Synchronous, like the other
 *  path gates (mkdirSync/trashSync/freeSpace): it runs on the Enter press. */
export function checkDir(path: string): OpResult {
  try {
    const enumerator = Gio.File.new_for_path(path).enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    enumerator.close(null)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: friendlyError(String(e)) }
  }
}

// ── formatting (status bar + size/modified columns) ──

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let v = n
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatDate(ms: number): string {
  if (!ms) return ""
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  })
}

// ── file-type → Nerd Font glyph (JetBrainsMono Nerd Font, suite aesthetic).
// MDI codepoints all sit above the BMP, so the escape MUST carry braces:
// "\u{f024b}" is the folder glyph, while the same 5 hex digits unbraced parse
// as U+F024 followed by a literal "b" — one wrong icon plus one stray
// character per row. Pick and verify glyphs with the `nf` tool
// (`nf search <name>` / `nf audit <dir>`). Unmapped extensions fall back to the
// generic file glyph (the long tail is accepted — content-type-based icons are
// a v2 refinement). ──

const GLYPH_FOLDER = "\u{f024b}" // md-folder
const GLYPH_FILE = "\u{f0214}" // md-file
const GLYPH_TEXT = "\u{f0219}" // md-file_document
const GLYPH_IMAGE = "\u{f021f}" // md-file_image
const GLYPH_AUDIO = "\u{f0223}" // md-file_music
const GLYPH_VIDEO = "\u{f022b}" // md-file_video
const GLYPH_ARCHIVE = "\u{f003c}" // md-archive
const GLYPH_PDF = "\u{f0226}" // md-file_pdf_box
const GLYPH_CODE = "\u{f022e}" // md-file_code
const GLYPH_EXEC = "\u{f08c6}" // md-application
const GLYPH_LINK = "\u{f0337}" // md-link
const GLYPH_DB = "\u{f01bc}" // md-database
const GLYPH_HTML = "\u{f031d}" // md-language_html5
const GLYPH_CSS = "\u{f031c}" // md-language_css3
const GLYPH_JS = "\u{f031e}" // md-language_javascript
const GLYPH_PY = "\u{f0320}" // md-language_python
const GLYPH_C = "\u{f0671}" // md-language_c
const GLYPH_CPP = "\u{f0672}" // md-language_cpp
const GLYPH_GO = "\u{f07d3}" // md-language_go
const GLYPH_JPG = "\u{f0225}" // md-file_jpg_box
const GLYPH_PNG = "\u{f0e2d}" // md-file_png_box
const GLYPH_GIF = "\u{f0d78}" // md-file_gif_box
const GLYPH_ZIP = "\u{f05c4}" // md-zip_box
const GLYPH_WORD = "\u{f022c}" // md-file_word
const GLYPH_XLS = "\u{f021b}" // md-file_excel
const GLYPH_PPT = "\u{f0227}" // md-file_powerpoint

const EXT_GLYPHS: Record<string, string> = {
  // images
  jpg: GLYPH_JPG,
  jpeg: GLYPH_JPG,
  png: GLYPH_PNG,
  gif: GLYPH_GIF,
  bmp: GLYPH_IMAGE,
  webp: GLYPH_IMAGE,
  svg: GLYPH_IMAGE,
  tiff: GLYPH_IMAGE,
  tif: GLYPH_IMAGE,
  ico: GLYPH_IMAGE,
  heic: GLYPH_IMAGE,
  avif: GLYPH_IMAGE,
  // audio
  mp3: GLYPH_AUDIO,
  flac: GLYPH_AUDIO,
  wav: GLYPH_AUDIO,
  ogg: GLYPH_AUDIO,
  m4a: GLYPH_AUDIO,
  aac: GLYPH_AUDIO,
  opus: GLYPH_AUDIO,
  // video
  mp4: GLYPH_VIDEO,
  mkv: GLYPH_VIDEO,
  webm: GLYPH_VIDEO,
  avi: GLYPH_VIDEO,
  mov: GLYPH_VIDEO,
  m4v: GLYPH_VIDEO,
  wmv: GLYPH_VIDEO,
  flv: GLYPH_VIDEO,
  // archives
  zip: GLYPH_ZIP,
  "7z": GLYPH_ZIP,
  rar: GLYPH_ZIP,
  tar: GLYPH_ARCHIVE,
  gz: GLYPH_ARCHIVE,
  xz: GLYPH_ARCHIVE,
  bz2: GLYPH_ARCHIVE,
  zst: GLYPH_ARCHIVE,
  tgz: GLYPH_ARCHIVE,
  // documents
  pdf: GLYPH_PDF,
  md: GLYPH_TEXT,
  txt: GLYPH_TEXT,
  log: GLYPH_TEXT,
  rtf: GLYPH_TEXT,
  doc: GLYPH_WORD,
  docx: GLYPH_WORD,
  odt: GLYPH_WORD,
  xls: GLYPH_XLS,
  xlsx: GLYPH_XLS,
  ods: GLYPH_XLS,
  csv: GLYPH_XLS,
  ppt: GLYPH_PPT,
  pptx: GLYPH_PPT,
  odp: GLYPH_PPT,
  // code
  html: GLYPH_HTML,
  htm: GLYPH_HTML,
  css: GLYPH_CSS,
  scss: GLYPH_CSS,
  js: GLYPH_JS,
  mjs: GLYPH_JS,
  cjs: GLYPH_JS,
  ts: GLYPH_JS,
  tsx: GLYPH_JS,
  jsx: GLYPH_JS,
  py: GLYPH_PY,
  pyw: GLYPH_PY,
  c: GLYPH_C,
  h: GLYPH_C,
  cpp: GLYPH_CPP,
  hpp: GLYPH_CPP,
  cc: GLYPH_CPP,
  cxx: GLYPH_CPP,
  go: GLYPH_GO,
  rs: GLYPH_CODE,
  zig: GLYPH_CODE,
  json: GLYPH_CODE,
  yaml: GLYPH_CODE,
  yml: GLYPH_CODE,
  toml: GLYPH_CODE,
  xml: GLYPH_CODE,
  sh: GLYPH_CODE,
  bash: GLYPH_CODE,
  zsh: GLYPH_CODE,
  fish: GLYPH_CODE,
  lua: GLYPH_CODE,
  pl: GLYPH_CODE,
  rb: GLYPH_CODE,
  php: GLYPH_CODE,
  java: GLYPH_CODE,
  kt: GLYPH_CODE,
  swift: GLYPH_CODE,
  // data
  db: GLYPH_DB,
  sqlite: GLYPH_DB,
  sqlite3: GLYPH_DB,
  sql: GLYPH_DB,
}

export function glyphFor(entry: DirEntry): string {
  if (entry.isDir) return GLYPH_FOLDER
  if (entry.isSymlink) return GLYPH_LINK
  if (entry.isExecutable) return GLYPH_EXEC
  const dot = entry.name.lastIndexOf(".")
  if (dot <= 0) return GLYPH_FILE
  return EXT_GLYPHS[entry.name.slice(dot + 1).toLowerCase()] ?? GLYPH_FILE
}

// ── error text ──

/** Strip GLib error noise ("Gio.IOErrorEnum: …" / "Error calling method …")
 *  into a short status-bar-friendly line. */
function friendlyError(msg: string): string {
  const clean = msg
    .replace(/^.*ErrorEnum:\s*/i, "")
    .replace(/^Error calling method[^:]*:\s*/i, "")
    .replace(/^g-file-error-quark:\s*/i, "")
    .trim()
  return clean.slice(0, 140) || "operation failed"
}
