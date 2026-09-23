/**
 * Path source — a typed path offers one row that opens it with xdg-open, the
 * desktop's own "open this" contract.
 *
 * Detection: `isPathShaped` (@common/path/complete) — a query is path-shaped
 * when it starts with `/`, `~`, `./` or `../`. The shared rule's doc carries
 * why a bare word is deliberately NOT a path: resolving bare words would
 * hijack ordinary app searches ("music" would offer a directory instead of
 * the music player).
 *
 * Resolution: `resolvePath` (@common/fs/files) expands a leading `~`, then
 * `GLib.canonicalize_filename` makes the result absolute so the existence
 * check and the open request both resolve against one directory instead of
 * each process's own cwd. A row appears for any EXISTING path — file or
 * directory; a path-shaped query that names nothing offers the two CREATE
 * rows instead (see `createRows`), which is how a path that is not there yet
 * is still one Enter away.
 *
 * Handler: the row NAMES the application the desktop associates with the
 * type — `inode/directory` for a directory, the path's own
 * `standard::content-type` (one `query_info`) for a file — through
 * `Gio.AppInfo.get_default_for_type` with `mustSupportUris` FALSE, because the
 * path is opened locally and an entry with no URI support still owns its type
 * for a file. A type nothing handles, or an unavailable lookup, states that no
 * application handles the type / falls back to the generic wording; either way
 * the row survives. The lookup is an in-process read GLib caches, so it runs
 * as the row is built.
 *
 * Activating the row hands the path to `xdg-open`, so a file reaches whatever
 * application owns its type and a directory reaches whatever owns
 * `inode/directory`. The launcher never guesses a handler and never imports
 * another app's modules.
 *
 * A FILE also brings the rows of the desktop entries that declare a file
 * placeholder (`apps.fileRows` — the applications source owns the
 * entry/Exec handling): the apps that accept a file, each carrying this one,
 * so `%f` has the path to expand into. The xdg-open row stays first — it
 * keeps the priority-0 category — and a DIRECTORY keeps its single row.
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { resolvePath } from "@common/fs/files"
import { ignore } from "@common/log/logger"
import { isGlobQuery, isPathShaped } from "@common/path/complete"
import { log } from "../log"
import type { Result, SourceResponse } from "../types"
import { fileRows, fileTypeAt } from "./apps"
import { xdgOpenRow } from "./xdg-row"

/** Path-shaped query — an explicit path prefix. See `isPathShaped`
 *  (@common/path/complete) for why a bare word is excluded. */

/** Tilde-expanded absolute path (relative prefixes resolve against the cwd),
 *  or the expanded path when canonicalization is unavailable. */
function absolutePath(input: string): string {
  const expanded = resolvePath(input)
  try {
    const canon = GLib.canonicalize_filename(expanded, null)
    if (canon) return canon
  } catch (e) {
    ignore("path canonicalize", e)
  }
  return expanded
}

/** The file's type as the desktop names it, or null when the query fails or
 *  the file declares none. ONE query_info: the type is all the row needs. */
function contentTypeOf(path: string): string | null {
  try {
    const info = Gio.File.new_for_path(path).query_info(
      "standard::content-type",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    return info.get_content_type() ?? null
  } catch (e) {
    ignore("path content-type", e)
    return null
  }
}

/** Name of the application that handles `contentType`: null when no
 *  application does, undefined when the lookup itself failed. `mustSupportUris`
 *  is FALSE — a path is opened as a local file. */
function handlerName(contentType: string): string | null | undefined {
  try {
    const info = Gio.AppInfo.get_default_for_type(contentType, false)
    if (!info) return null
    return info.get_name() ?? info.get_display_name() ?? undefined
  } catch (e) {
    ignore("content-type handler", e)
    return undefined
  }
}

/** The handler's name, the absence of one, or the generic wording when the
 *  type or the lookup is unavailable. */
function description(isDirectory: boolean, contentType: string | null): string {
  const fallback = isDirectory ? "open with the file manager" : "open with the default application"
  if (!contentType) return fallback
  const name = handlerName(contentType)
  if (name === undefined) return fallback
  if (name === null)
    return isDirectory
      ? "no application handles directories"
      : `no application handles ${contentType}`
  return `open with ${name}`
}

/** The directory a path lives in (`/x` → `/`). */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash <= 0 ? "/" : path.slice(0, slash)
}

/** One create row: make the thing, then open it through the shared xdg-open
 *  row (one spawn implementation for every "open this" the launcher offers).
 *  Creating is an in-process Gio call, so Enter costs no child process. */
function createRow(path: string, kind: "directory" | "file"): Result {
  const isDirectory = kind === "directory"
  const open = xdgOpenRow({
    target: path,
    tag: "paths",
    description: isDirectory ? "create it, then open the directory" : "create it, then open it",
    icon: isDirectory ? "folder" : "file",
    category: "path",
  })
  return {
    title: `${isDirectory ? "Create directory" : "Create file"} — ${path}`,
    description: isDirectory
      ? "make the directory, then open it"
      : "make an empty file, then open it",
    icon: isDirectory ? "folder-new" : "document-new",
    category: "path",
    run: () => {
      try {
        const file = Gio.File.new_for_path(path)
        if (isDirectory) {
          file.make_directory(null)
        } else {
          file.create(Gio.FileCreateFlags.NONE, null).close(null)
        }
      } catch (e) {
        log(`paths: create failed on ${path}: ${(e as Error).message}`)
        return false // keep the card open — nothing was created
      }
      open.run()
      return true
    },
  }
}

/**
 * Rows for a path that does not exist yet: create it. Deliberately narrow —
 * the path must sit DIRECTLY inside an existing directory, so a typo cannot
 * create a tree, and a pattern (`*`/`?`) is a completion query rather than a
 * create request. Which row comes first follows what the typed name looks
 * like: a trailing slash or a dotless basename reads as a directory, a
 * basename with an extension reads as a file.
 */
function createRows(input: string, path: string): Result[] {
  if (isGlobQuery(input)) return []
  if (fileTypeAt(parentOf(path)) !== Gio.FileType.DIRECTORY) return []
  const basename = GLib.path_get_basename(path)
  if (!basename || basename === "." || basename === "..") return []
  const directory = createRow(path, "directory")
  const file = createRow(path, "file")
  const readsAsDirectory = input.trim().endsWith("/") || !/\.[^./]+$/.test(basename)
  return readsAsDirectory ? [directory, file] : [file, directory]
}

export function paths(input: string): SourceResponse {
  const q = input.trim()
  if (!isPathShaped(q)) return { sync: [] }
  const path = absolutePath(q)
  const type = fileTypeAt(path)
  if (type === null) return { sync: createRows(q, path) }
  const isDirectory = type === Gio.FileType.DIRECTORY
  const contentType = isDirectory ? "inode/directory" : contentTypeOf(path)
  const open = xdgOpenRow({
    target: path,
    tag: "paths",
    description: description(isDirectory, contentType),
    icon: isDirectory ? "folder" : "file",
    category: "path",
  })
  // A directory is one row; a file also offers the entries that take a file.
  if (isDirectory) return { sync: [open] }
  return { sync: [open, ...fileRows(path, contentType)] }
}
