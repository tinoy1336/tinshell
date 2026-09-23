/**
 * common/local-index/reader — the READ path of the format (`format.ts`): open
 * an index directory once, look a key up by binary search, keep nothing
 * resident.
 *
 * THE SHAPE THAT MATTERS IS ONE PERSISTENT TRANSPORT PER FILE. A reader that
 * opens the file per lookup is the defect this module exists to prevent: a
 * fresh stream per lookup is retained by a long-lived host process (a gjs host
 * keeping a Gio stream it never frees grew ~120 MiB over 10,000 lookups and was
 * not reclaimed by an explicit collection), while one stream per file cost
 * +0.15 MiB and answered FASTER. So `openLocalIndex` opens the manifest, reads
 * it whole and closes it, then opens `keys.idx` and `rows.dat` exactly once and
 * holds both until `close()`. Nothing else in this module opens a file.
 *
 * EVERY LOOKUP IS TWO READS PER BINARY-SEARCH STEP and two more on a hit: one
 * 8-byte window out of the key file's offset table (which yields both the
 * entry's start and the next entry's start) plus the key bytes it addresses,
 * then the same window and payload in the sidecar. For a 147,806-key index that
 * is ~18 steps, i.e. ~36 small reads, all against the OS page cache after the
 * first touch — the file itself is never loaded, so resident cost stays flat.
 *
 * THE HOST SUPPLIES THE BYTES. `ByteSource` is the ONE seam this module has and
 * it is forced rather than speculative: gjs exposes no file API without a
 * `gi://` import, and this module must load under plain Node for its probe. A
 * gjs host opens `Gio.FileInputStream` (seek + read) once per file; the probe
 * opens a file descriptor (`pread`). Both satisfy the same two methods, and the
 * reuse rule above is expressed in the API — the opener is called a fixed number
 * of times at open, never during a lookup.
 *
 * INTEGRITY IS STRUCTURAL, NOT CRYPTOGRAPHIC. Open checks each file's byte
 * length against the manifest and each file's own header (magic, format version,
 * entry count) against the manifest that named it, so a truncated file, a file
 * swapped for another kind, and a manifest paired with data of a different
 * layout are all refused with the file and the disagreement named. The manifest's
 * sha256 is deliberately NOT checked here: hashing 23 MiB at open would spend the
 * latency this reader exists to save, that check belongs to the artifact host at
 * install time, and a hasher would drag a Node/GLib dependency into a module
 * that must stay transport-agnostic.
 *
 * Per-instance state (the two sources, the counters) lives in this factory's
 * closure, never at module scope: two indexes in one process must not share
 * either.
 */

import {
  blobStart,
  compareBytes,
  decodeUtf8,
  encodeUtf8,
  HEADER_BYTES,
  type IndexFileRef,
  KEYS_MAGIC,
  LocalIndexFormatError,
  LocalIndexIntegrityError,
  type LocalIndexManifest,
  MANIFEST_FILE,
  offsetSlot,
  parseManifest,
  ROWS_MAGIC,
  readHeader,
  readUint32,
  UINT32_BYTES,
} from "./format.ts"

/** A byte transport over one file. `readAt` returns exactly `length` bytes and
 *  the caller owns them; a short read is an error, never a partial answer. */
export interface ByteSource {
  size(): number
  readAt(offset: number, length: number): Uint8Array
  close(): void
}

/** Opens one transport for one path. Called a fixed number of times while an
 *  index is OPENING — a lookup never calls it. */
export type ByteSourceOpener = (path: string) => ByteSource

export interface LocalIndexStats {
  lookups: number
  hits: number
  misses: number
}

export interface LocalIndex {
  readonly manifest: LocalIndexManifest
  /** Payload bytes of `key`, or null when the key is absent. Throws when the
   *  index has been closed. */
  lookup(key: string): Uint8Array | null
  /** Lookup counters, as a copy. */
  stats(): LocalIndexStats
  /** Transports currently held: 2 while open, 0 after `close()`. */
  openStreams(): number
  /** Release both transports. Idempotent; a lookup after it throws. */
  close(): void
}

/** Join an index directory with a file name (POSIX; `@common/fs/files` and
 *  `GLib.build_filenamev` both reach for GLib, which this module cannot). */
function indexPath(dir: string, file: string): string {
  return dir.endsWith("/") ? `${dir}${file}` : `${dir}/${file}`
}

/** Read a whole (small) file through a fresh transport and close it. Used for
 *  the manifest only — the two data files are held open instead. */
function readWholeFile(path: string, open: ByteSourceOpener): Uint8Array {
  const source = open(path)
  try {
    const size = source.size()
    return source.readAt(0, size)
  } finally {
    source.close()
  }
}

/** Open one data file, check it against its manifest record, and hand back the
 *  held transport with its entry count. The transport is closed again on every
 *  refusal, so a rejected index leaks nothing. */
function openDataFile(
  dir: string,
  ref: IndexFileRef,
  magic: string,
  label: string,
  open: ByteSourceOpener,
): { source: ByteSource; count: number } {
  const source = open(indexPath(dir, ref.file))
  try {
    const size = source.size()
    if (size !== ref.bytes) {
      throw new LocalIndexIntegrityError(
        `${ref.file}: ${size} bytes on disk, manifest records ${ref.bytes}`,
      )
    }
    const { count } = readHeader(source.readAt(0, HEADER_BYTES), magic, ref.file)
    return { source, count }
  } catch (e) {
    source.close()
    throw e instanceof LocalIndexFormatError || e instanceof LocalIndexIntegrityError
      ? e
      : new LocalIndexIntegrityError(`${label} file ${ref.file} unreadable: ${e}`)
  }
}

/** Open the index in `dir` (manifest + sorted key file + payload sidecar). Every
 *  refusal names the file and the disagreement; nothing is guessed. */
export function openLocalIndex(dir: string, open: ByteSourceOpener): LocalIndex {
  let manifest: LocalIndexManifest
  try {
    manifest = parseManifest(decodeUtf8(readWholeFile(indexPath(dir, MANIFEST_FILE), open)))
  } catch (e) {
    throw e instanceof LocalIndexFormatError
      ? e
      : new LocalIndexIntegrityError(`${indexPath(dir, MANIFEST_FILE)} unreadable: ${e}`)
  }

  const keys = openDataFile(dir, manifest.keys, KEYS_MAGIC, "keys", open)
  let rows: { source: ByteSource; count: number }
  try {
    rows = openDataFile(dir, manifest.rows, ROWS_MAGIC, "rows", open)
  } catch (e) {
    keys.source.close()
    throw e
  }

  if (keys.count !== manifest.entryCount || rows.count !== manifest.entryCount) {
    keys.source.close()
    rows.source.close()
    throw new LocalIndexIntegrityError(
      `manifest records ${manifest.entryCount} entries, ${manifest.keys.file} holds ` +
        `${keys.count} and ${manifest.rows.file} holds ${rows.count}`,
    )
  }

  const count = manifest.entryCount
  const keysBlob = blobStart(count)
  const rowsBlob = blobStart(count)
  let lookups = 0
  let hits = 0
  let misses = 0
  let closed = false

  /** [start, end) of entry `index` in `file`, from its offset-table window. */
  function bounds(source: ByteSource, file: string, index: number): [number, number] {
    const window = source.readAt(offsetSlot(index), UINT32_BYTES * 2)
    const start = readUint32(window, 0)
    const end = readUint32(window, UINT32_BYTES)
    if (end < start) {
      throw new LocalIndexIntegrityError(
        `${file}: entry ${index} has an inverted offset (${start}..${end})`,
      )
    }
    return [start, end]
  }

  function keyAt(index: number): Uint8Array {
    const [start, end] = bounds(keys.source, manifest.keys.file, index)
    return keys.source.readAt(keysBlob + start, end - start)
  }

  function payloadAt(index: number): Uint8Array {
    const [start, end] = bounds(rows.source, manifest.rows.file, index)
    return rows.source.readAt(rowsBlob + start, end - start)
  }

  return {
    manifest,
    lookup(key: string): Uint8Array | null {
      if (closed) {
        throw new Error(`local index at ${dir} is closed`)
      }
      lookups++
      const query = encodeUtf8(key)
      let lo = 0
      let hi = count
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        const cmp = compareBytes(query, keyAt(mid))
        if (cmp < 0) hi = mid
        else if (cmp > 0) lo = mid + 1
        else {
          hits++
          return payloadAt(mid)
        }
      }
      misses++
      return null
    },
    stats: () => ({ lookups, hits, misses }),
    openStreams: () => (closed ? 0 : 2),
    close(): void {
      if (closed) return
      closed = true
      keys.source.close()
      rows.source.close()
    },
  }
}
