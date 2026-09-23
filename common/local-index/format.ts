/**
 * common/local-index/format — the on-disk contract of a local index: the
 * manifest, the two data files it names, and every rule the reader REFUSES on.
 *
 * An index is a DIRECTORY holding three files:
 *
 *   manifest.json  the manifest: format name, FORMAT VERSION, entry count, one
 *                  record per data file (name, exact byte length, sha256), and
 *                  the DATASET descriptor (corpus, release, key rule, payload
 *                  encoding, licence, source artifact + its sha256)
 *   keys.idx       the sorted key file
 *   rows.dat       the payload file (the sidecar)
 *
 * Both data files share ONE layout:
 *
 *   0       magic         8 bytes, ASCII ("AGSLIDX\n" keys, "AGSLROW\n" rows)
 *   8       formatVersion uint32 LE
 *   12      entryCount    uint32 LE
 *   16      offset table  (entryCount + 1) x uint32 LE — byte offsets into the
 *                         blob that follows, so entry i spans
 *                         table[i]..table[i + 1]
 *   ...     blob          keys: UTF-8 key bytes, sorted by RAW BYTE ORDER
 *                         rows: one opaque payload per key, same ordinal
 *
 * The key's ORDINAL is the join between the two files: the key blob's i-th
 * entry is the i-th offset-table slot of the key file AND of the row file, so a
 * hit reads one row window out of `rows.dat` and never scans it.
 *
 * All integers are little-endian uint32, which caps a blob at 4 GiB. That is a
 * format limit, not a bug to work around: the shipped WordNet index (147,318
 * keys, 1.3 MiB of keys and 21 MiB of rows) is a fraction of it.
 *
 * WHY A FORMAT VERSION ALONGSIDE A HASH: a sha256 proves the bytes are the
 * published ones, not that they are in a layout the reader understands. A
 * refreshed artifact in a newer layout read by an older reader is a WRONG
 * ANSWER rather than a crash — the exact failure a version gate exists to make
 * impossible. `parseManifest` therefore refuses every version but the one
 * compiled here instead of guessing.
 *
 * WHY THE MANIFEST CARRIES A DATASET DESCRIPTOR: a data-file hash proves the
 * bytes are the ones the producer wrote, and the format version proves their
 * layout — neither says what the keys MEAN or what the row bytes decode to. An
 * index built from another corpus, or from the same corpus under a different key
 * rule, is structurally valid and would be served as if it were the installed
 * one. `keyRule` and `payloadEncoding` are therefore REQUIRED and checked
 * against the sets this reader knows (`KNOWN_KEY_RULES`,
 * `KNOWN_PAYLOAD_ENCODINGS`); the rest of the descriptor (corpus, release,
 * licence, source url/bytes/sha256) is recorded provenance, shape-checked but
 * never compared — a reader cannot enumerate the corpus releases that exist.
 *
 * KEY ORDER IS BYTE ORDER. Keys are compared as raw UTF-8 bytes (memcmp), never
 * locale- or case-folded, so the order the ENCODER sorts by and the order the
 * READER binary-searches by cannot disagree.
 *
 * No `gi://` import here: this module is shared by the gjs bundle and by the
 * plain-Node probe (`node --experimental-strip-types`), so it must load under
 * both. That is also why the sibling import carries its `.ts` extension and why
 * the UTF-8 helpers below are local — `@common/fs/bytes` imports GLib.
 */

/** Manifest `format` field; a manifest naming anything else is not ours. */
export const LOCAL_INDEX_FORMAT = "tinshell-local-index"

/** The ONE format version this reader understands. Version 2 made the `dataset`
 *  section a REQUIRED part of the manifest: a version-1 manifest describes an
 *  artifact whose corpus and key rule are unstated, which is the one thing a
 *  reader must never guess. */
export const FORMAT_VERSION = 2

/** Key rule `verbatim`: the query string is the key, byte for byte, with no
 *  normalisation — what a decoder of producer-named keys needs. */
export const KEY_RULE_VERBATIM = "verbatim"

/** Key rule `lemma-lowercase-marker-stripped`: a key is a corpus lemma,
 *  case-folded, with WordNet's adjective-satellite and pertainym markers `(a)`
 *  and `(p)` removed (they are notation, not part of a word). A consumer
 *  normalises its query through `keyForQuery` before a lookup takes it. */
export const KEY_RULE_LEMMA = "lemma-lowercase-marker-stripped"

/** Every key rule this reader understands. A manifest naming another one is
 *  refused: the reader cannot tell what an unknown rule's keys mean, and
 *  handing a consumer keys it will normalise wrongly is a wrong answer rather
 *  than a missing one. A new dataset with a new rule gains the rule here, in
 *  the same change that produces the artifact. */
export const KNOWN_KEY_RULES: readonly string[] = [KEY_RULE_VERBATIM, KEY_RULE_LEMMA]

/** Payload encoding `opaque`: the row bytes mean whatever the producer's
 *  consumer knows, and this format makes no claim about them. */
export const PAYLOAD_ENCODING_OPAQUE = "opaque"

/** Payload encoding `sense-lines`: one line per sense, `<gloss>\t<synonyms>`,
 *  with synonyms space-joined; senses separated by a newline. The reader keeps
 *  rows opaque; this identifier is how a consumer knows which decoder applies. */
export const PAYLOAD_ENCODING_SENSE_LINES = "sense-lines"

/** Every payload encoding this reader understands, with the same refusal rule
 *  as `KNOWN_KEY_RULES`. */
export const KNOWN_PAYLOAD_ENCODINGS: readonly string[] = [
  PAYLOAD_ENCODING_OPAQUE,
  PAYLOAD_ENCODING_SENSE_LINES,
]

export const MANIFEST_FILE = "manifest.json"
export const KEYS_FILE = "keys.idx"
export const ROWS_FILE = "rows.dat"

export const KEYS_MAGIC = "AGSLIDX\n"
export const ROWS_MAGIC = "AGSLROW\n"

/** magic + formatVersion + entryCount. */
export const HEADER_BYTES = 16
/** Offset-table start; slot `i` sits at `offsetSlot(i)`. */
export const OFFSET_TABLE_START = HEADER_BYTES
export const UINT32_BYTES = 4

/** Largest blob a uint32 offset table can address. */
export const MAX_BLOB_BYTES = 0xffffffff

/** A malformed manifest or header, including a format version this reader does
 *  not know: the artifact is a shape it cannot read at all. */
export class LocalIndexFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LocalIndexFormatError"
  }
}

/** A well-formed but unusable artifact: a missing/unreadable file, a file whose
 *  byte length or entry count disagrees with the manifest, a file whose own
 *  header disagrees with the manifest that named it. */
export class LocalIndexIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LocalIndexIntegrityError"
  }
}

/** One data file as the manifest records it. `bytes` and `sha256` describe the
 *  exact payload the encoder wrote. The READER checks `bytes` at open (cheap,
 *  catches truncation); `sha256` belongs to the artifact host's install-time
 *  verification, which streams the file once with a hasher the reader has no
 *  business owning. */
export interface IndexFileRef {
  file: string
  bytes: number
  sha256: string
}

/** Where a corpus came from: the artifact it was extracted from, its exact byte
 *  length and its sha256. Recorded so an install can verify the bytes a shipped
 *  index was built from; the READER compares no source hash, because it cannot
 *  know which corpus releases exist. */
export interface IndexSourceRef {
  url: string
  bytes: number
  sha256: string
}

/** The corpus a manifest describes. `keyRule` and `payloadEncoding` are the two
 *  fields a reader REFUSES (see `KNOWN_KEY_RULES` / `KNOWN_PAYLOAD_ENCODINGS`)
 *  — they are what an unknown corpus would differ in. The rest is provenance,
 *  recorded and shape-checked only. */
export interface IndexDataset {
  corpus: string
  release: string
  keyRule: string
  payloadEncoding: string
  licence: string
  source: IndexSourceRef
}

export interface LocalIndexManifest {
  format: string
  formatVersion: number
  entryCount: number
  keys: IndexFileRef
  rows: IndexFileRef
  dataset: IndexDataset
}

/** Offset-table slot of `index` — the window holding that entry's start and the
 *  next entry's start, so ONE read answers both bounds. */
export function offsetSlot(index: number): number {
  return OFFSET_TABLE_START + index * UINT32_BYTES
}

/** First byte of the blob of a file holding `entryCount` entries. */
export function blobStart(entryCount: number): number {
  return OFFSET_TABLE_START + (entryCount + 1) * UINT32_BYTES
}

/** Whole-file byte length of a data file: header + offset table + blob. */
export function dataFileBytes(entryCount: number, blobBytes: number): number {
  return blobStart(entryCount) + blobBytes
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Little-endian uint32 at `offset`. */
export function readUint32(bytes: Uint8Array, offset: number): number {
  return view(bytes).getUint32(offset, true)
}

/** Write a little-endian uint32 at `offset`. */
export function writeUint32(target: Uint8Array, offset: number, value: number): void {
  view(target).setUint32(offset, value, true)
}

/** ONE UTF-8 decoder for the whole module (module-scope: stateless, so sharing
 *  it cannot leak state between two instances). */
const UTF8_DECODER = new TextDecoder()

export function decodeUtf8(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes)
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Raw byte-order comparison — the ONE ordering rule of this format. Negative
 *  when `a` sorts before `b`, positive when after, 0 when equal; a proper prefix
 *  sorts first. The encoder sorts by it and the reader binary-searches by it, so
 *  the two cannot disagree about where a key lives. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = a.length < b.length ? a.length : b.length
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/** The ONE implementation of the `KEY_RULE_LEMMA` normalisation, so the builder
 *  that writes a key and a consumer that looks one up cannot spell the rule
 *  differently. */
export function normaliseLemmaKey(word: string): string {
  return word.replace(/\((a|p)\)$/, "").toLowerCase()
}

/** Normalise a query through the rule the corpus names. The `verbatim` rule is
 *  the identity: keys are the query strings themselves. */
export function keyForQuery(dataset: IndexDataset, query: string): string {
  return dataset.keyRule === KEY_RULE_LEMMA ? normaliseLemmaKey(query) : query
}

/** Header bytes of a data file holding `entryCount` entries. */
export function encodeHeader(magic: string, entryCount: number): Uint8Array {
  const header = new Uint8Array(HEADER_BYTES)
  for (let i = 0; i < magic.length; i++) header[i] = magic.charCodeAt(i)
  writeUint32(header, 8, FORMAT_VERSION)
  writeUint32(header, 12, entryCount)
  return header
}

/** Parse a data file's header. `file` names the file in every error, and the
 *  magic is checked before the version so a file of the wrong KIND is reported
 *  as such instead of as a version mismatch. */
export function readHeader(
  bytes: Uint8Array,
  magic: string,
  file: string,
): { version: number; count: number } {
  if (bytes.length < HEADER_BYTES) {
    throw new LocalIndexFormatError(`${file}: ${bytes.length} bytes, too short to hold a header`)
  }
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) {
      throw new LocalIndexFormatError(`${file}: not a local index data file (bad magic)`)
    }
  }
  const version = readUint32(bytes, 8)
  if (version !== FORMAT_VERSION) {
    throw new LocalIndexFormatError(
      `${file}: data file format version ${version}, this reader understands ${FORMAT_VERSION}`,
    )
  }
  return { version, count: readUint32(bytes, 12) }
}

/** A sha256 in the one spelling a manifest may carry it in. */
const SHA256 = /^[0-9a-f]{64}$/

/** Non-empty string under `field`, or a refusal naming the field. */
function readText(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new LocalIndexFormatError(`manifest: ${field} is not a string`)
  }
  return raw
}

/** One field from a fixed set of understood values; anything else is refused
 *  with both what was found and what this reader knows. */
function readKnown(raw: unknown, field: string, known: readonly string[]): string {
  const value = readText(raw, field)
  if (!known.includes(value)) {
    throw new LocalIndexFormatError(
      `manifest: ${field} is ${JSON.stringify(value)}, this reader understands ` +
        known.map((k) => JSON.stringify(k)).join(", "),
    )
  }
  return value
}

function readSource(raw: unknown): IndexSourceRef {
  if (typeof raw !== "object" || raw === null) {
    throw new LocalIndexFormatError("manifest: dataset.source is not an object")
  }
  const source = raw as Record<string, unknown>
  const bytes = source.bytes
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) {
    throw new LocalIndexFormatError("manifest: dataset.source.bytes is not a byte length")
  }
  const sha256 = readText(source.sha256, "dataset.source.sha256")
  if (!SHA256.test(sha256)) {
    throw new LocalIndexFormatError("manifest: dataset.source.sha256 is not a sha256")
  }
  return { url: readText(source.url, "dataset.source.url"), bytes, sha256 }
}

/** The corpus descriptor, refusing an unknown key rule or payload encoding. */
function readDataset(raw: unknown): IndexDataset {
  if (typeof raw !== "object" || raw === null) {
    throw new LocalIndexFormatError("manifest: dataset is not an object")
  }
  const dataset = raw as Record<string, unknown>
  return {
    corpus: readText(dataset.corpus, "dataset.corpus"),
    release: readText(dataset.release, "dataset.release"),
    keyRule: readKnown(dataset.keyRule, "dataset.keyRule", KNOWN_KEY_RULES),
    payloadEncoding: readKnown(
      dataset.payloadEncoding,
      "dataset.payloadEncoding",
      KNOWN_PAYLOAD_ENCODINGS,
    ),
    licence: readText(dataset.licence, "dataset.licence"),
    source: readSource(dataset.source),
  }
}

function readFileRef(raw: unknown, field: string): IndexFileRef {
  if (typeof raw !== "object" || raw === null) {
    throw new LocalIndexFormatError(`manifest: ${field} is not an object`)
  }
  const ref = raw as Record<string, unknown>
  const file = ref.file
  const bytes = ref.bytes
  const sha256 = ref.sha256
  if (typeof file !== "string" || file.length === 0) {
    throw new LocalIndexFormatError(`manifest: ${field}.file is not a file name`)
  }
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
    throw new LocalIndexFormatError(`manifest: ${field}.bytes is not a byte length`)
  }
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    throw new LocalIndexFormatError(`manifest: ${field}.sha256 is not a sha256`)
  }
  return { file, bytes, sha256 }
}

function readCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new LocalIndexFormatError("manifest: entryCount is not an entry count")
  }
  return raw
}

/** Parse and REFUSE a manifest. Every failure names what was found and what
 *  this reader expected, so a stale artifact is diagnosable from the message
 *  alone. A version this reader does not know is never read speculatively. */
export function parseManifest(text: string): LocalIndexManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new LocalIndexFormatError(`manifest: not JSON (${e})`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new LocalIndexFormatError("manifest: not a JSON object")
  }
  const obj = raw as Record<string, unknown>
  if (obj.format !== LOCAL_INDEX_FORMAT) {
    throw new LocalIndexFormatError(
      `manifest: format ${JSON.stringify(obj.format)}, expected "${LOCAL_INDEX_FORMAT}"`,
    )
  }
  if (obj.formatVersion !== FORMAT_VERSION) {
    throw new LocalIndexFormatError(
      `manifest: format version ${JSON.stringify(obj.formatVersion)}, ` +
        `this reader understands ${FORMAT_VERSION}`,
    )
  }
  return {
    format: LOCAL_INDEX_FORMAT,
    formatVersion: FORMAT_VERSION,
    entryCount: readCount(obj.entryCount),
    keys: readFileRef(obj.keys, "keys"),
    rows: readFileRef(obj.rows, "rows"),
    dataset: readDataset(obj.dataset),
  }
}
