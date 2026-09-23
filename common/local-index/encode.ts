/**
 * common/local-index/encode — the WRITER half of the format (`format.ts`): it
 * turns an entry list into the two data files' bytes and their manifest.
 *
 * The encoder exists so the format has one producer: the probe generates its
 * fixtures through it, and the corpus builder (`build-wordnet-index.mjs`) writes
 * the shipped artifact through it rather than re-deriving the layout. It returns
 * BYTES, never touches the file system — the caller decides where the index
 * directory lives and writes the three files there. The corpus a caller encodes
 * arrives as an `IndexDataset` DESCRIPTOR, which this module records verbatim
 * and never inspects: choosing a corpus is the builder's job, and what the
 * descriptor's fields MEAN belongs to the reader contract in `format.ts`.
 *
 * ORDER IS THE FORMAT'S, NOT THE CALLER'S: entries are sorted by raw UTF-8 byte
 * order (`compareBytes`) regardless of the order they arrive in, because the
 * reader binary-searches on exactly that order. Duplicate keys are rejected
 * rather than silently collapsed — two payloads under one key would make the
 * file's answer depend on sort stability, which no reader could promise.
 *
 * ENCODING IS DETERMINISTIC: one entry list plus one descriptor produce
 * byte-identical files and manifest, so a rebuild of the same source bytes is
 * comparable by hash. The manifest carries no timestamp, and the sort is total
 * (duplicate keys are refused), so nothing about a run can leak into the bytes.
 *
 * THE HASHER IS A PARAMETER. The manifest records a sha256 per file, and the
 * two hosts that can produce one disagree: plain Node has `node:crypto`, gjs
 * has GLib. Taking the hasher as an argument keeps this module (and the reader)
 * free of both, so the same code runs in the bundle and under
 * `node --experimental-strip-types`.
 *
 * The whole index is held in memory while encoding (24 MiB for the shipped
 * WordNet set). That is a BUILD-time cost, never a read-path one: the reader
 * keeps nothing resident but the OS page cache.
 */

import {
  compareBytes,
  dataFileBytes,
  encodeHeader,
  encodeUtf8,
  FORMAT_VERSION,
  type IndexDataset,
  type IndexFileRef,
  KEYS_FILE,
  KEYS_MAGIC,
  LOCAL_INDEX_FORMAT,
  LocalIndexFormatError,
  type LocalIndexManifest,
  MAX_BLOB_BYTES,
  offsetSlot,
  ROWS_FILE,
  ROWS_MAGIC,
  writeUint32,
} from "./format.ts"

/** One index entry. `payload` is opaque to the reader and to this encoder:
 *  a string is stored as its UTF-8 bytes, bytes are stored verbatim. */
export interface LocalIndexEntry {
  key: string
  payload: string | Uint8Array
}

/** Hash of a file's bytes, lowercase hex. `node:crypto` or GLib supplies it. */
export type HashFn = (bytes: Uint8Array) => string

export interface EncodedLocalIndex {
  manifest: LocalIndexManifest
  keys: Uint8Array
  rows: Uint8Array
}

function fileRef(file: string, bytes: Uint8Array, hash: HashFn): IndexFileRef {
  return { file, bytes: bytes.length, sha256: hash(bytes) }
}

/** Build a data file's bytes from entry offsets and the blob they address.
 *  `offsets` holds `entryCount + 1` blob-relative offsets. */
function dataFile(magic: string, offsets: number[], blob: Uint8Array): Uint8Array {
  const entryCount = offsets.length - 1
  const out = new Uint8Array(dataFileBytes(entryCount, blob.length))
  out.set(encodeHeader(magic, entryCount), 0)
  for (let i = 0; i <= entryCount; i++) writeUint32(out, offsetSlot(i), offsets[i])
  out.set(blob, out.length - blob.length)
  return out
}

/** Encode an index: sorted key file, payload sidecar, and the manifest naming
 *  both plus the corpus descriptor the caller supplies. Throws
 *  `LocalIndexFormatError` on an empty key, a duplicate key, or a blob past the
 *  uint32 offset limit. */
export function encodeLocalIndex(
  entries: LocalIndexEntry[],
  dataset: IndexDataset,
  hash: HashFn,
  files: { keys?: string; rows?: string } = {},
): EncodedLocalIndex {
  const keyFile = files.keys ?? KEYS_FILE
  const rowFile = files.rows ?? ROWS_FILE

  const sorted = entries
    .map((entry) => ({ key: encodeUtf8(entry.key), payload: entry.payload }))
    .sort((a, b) => compareBytes(a.key, b.key))

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]
    if (entry.key.length === 0) {
      throw new LocalIndexFormatError(`entry ${i}: empty key`)
    }
    if (i > 0 && compareBytes(sorted[i - 1].key, entry.key) === 0) {
      throw new LocalIndexFormatError(`duplicate key ${JSON.stringify(entry.key.toString())}`)
    }
  }

  const keyOffsets = new Array<number>(sorted.length + 1)
  const rowOffsets = new Array<number>(sorted.length + 1)
  let keyBytes = 0
  let rowBytes = 0
  for (let i = 0; i < sorted.length; i++) {
    keyOffsets[i] = keyBytes
    rowOffsets[i] = rowBytes
    keyBytes += sorted[i].key.length
    rowBytes +=
      typeof sorted[i].payload === "string"
        ? encodeUtf8(sorted[i].payload as string).length
        : (sorted[i].payload as Uint8Array).length
  }
  keyOffsets[sorted.length] = keyBytes
  rowOffsets[sorted.length] = rowBytes

  for (const [label, size] of [
    ["keys", keyBytes],
    ["rows", rowBytes],
  ] as const) {
    if (size > MAX_BLOB_BYTES) {
      throw new LocalIndexFormatError(`${label}: blob of ${size} bytes exceeds the uint32 limit`)
    }
  }

  const keyBlob = new Uint8Array(keyBytes)
  const rowBlob = new Uint8Array(rowBytes)
  for (let i = 0; i < sorted.length; i++) {
    keyBlob.set(sorted[i].key, keyOffsets[i])
    const payload = sorted[i].payload
    rowBlob.set(typeof payload === "string" ? encodeUtf8(payload) : payload, rowOffsets[i])
  }

  const keys = dataFile(KEYS_MAGIC, keyOffsets, keyBlob)
  const rows = dataFile(ROWS_MAGIC, rowOffsets, rowBlob)

  return {
    manifest: {
      format: LOCAL_INDEX_FORMAT,
      formatVersion: FORMAT_VERSION,
      entryCount: sorted.length,
      keys: fileRef(keyFile, keys, hash),
      rows: fileRef(rowFile, rows, hash),
      dataset,
    },
    keys,
    rows,
  }
}

/** The manifest as the bytes written to `manifest.json` (trailing newline, two
 *  space indent so a diff of two artifacts is readable). */
export function manifestJson(manifest: LocalIndexManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
