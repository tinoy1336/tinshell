/**
 * local-index.probe — reproducible probe for the local index reader
 * (`common/local-index/reader.ts`, over the format in `format.ts`).
 *
 * REAL module, generated fixtures, no dataset: it encodes a 147,806-key index
 * through `encodeLocalIndex` into a scratch directory under the system temp dir
 * (never in the repo tree) and reads it back through `openLocalIndex`. The
 * fixture only has to be the SIZE the format was sized against, so the numbers
 * below mean something; it declares `verbatim` keys and `opaque` payloads, which
 * is what a generated fixture actually is.
 *
 * THE INSTALLED INDEX IS MEASURED BY THE SAME HARNESS: with
 * `LOCAL_INDEX_PROBE_REAL=<dir>` pointing at a real index directory (e.g. the
 * shipped `~/.local/share/tinshell/local-index/wordnet-3.0`), the latency phase
 * repeats the reuse, latency, resident and refusal measurements against THAT
 * artifact, at its own key count, sampling its own keys — plus the real
 * manifest's `formatVersion` / `keyRule` / `payloadEncoding` refusals.
 *
 * WHY THIS PROBE IS `.mjs` RATHER THAN `.ts`: the root typecheck program
 * (apps/** + common/**) deliberately carries NO Node types — `scripts/tsconfig.json`
 * records the reason (Node's ambient globals shadow the gjs runtime's own
 * declarations and break the ags/gnim shim sources) — so a TS probe importing
 * `node:fs` / `node:crypto` / `process` cannot live in that program without
 * TS2591 on every Node name. The READER and the FORMAT stay typed TS and stay in
 * that program, checked at 0 errors; only this measurement harness is JS.
 *
 * RESTORING TYPED PROBE COVERAGE (two parts, both outside this file):
 *   1. rename this file back to `local-index.probe.ts` and restore the type
 *      annotations/type-only imports (the reader's `ByteSource`, `LocalIndex`,
 *      `LocalIndexManifest` and `LocalIndexEntry`);
 *   2. add `"common/local-index/*.probe.ts"` to the `exclude` array of the root
 *      `tsconfig.json`, and give the probe a Node-typed project beside it —
 *      `common/local-index/tsconfig.probe.json`:
 *        { "extends": "../../tsconfig.json",
 *          "compilerOptions": { "types": ["node"], "jsx": "preserve", "jsxImportSource": "" },
 *          "include": ["local-index.probe.ts"] }
 *      run as `npx tsc --noEmit -p common/local-index/tsconfig.probe.json`;
 *      (moving it under `scripts/` — the program that already has Node types —
 *      is the equivalent move, importing the reader relatively).
 *
 * WHAT IT FAILS ON, LOUDLY:
 *   - a manifest whose format version this reader does not know, and every other
 *     refusal the format promises (wrong format name, missing file, truncated
 *     file, corrupted magic, a file header that disagrees with the manifest it
 *     was named by, a manifest that is not a manifest)
 *   - a transport that is REOPENED per lookup: the opener is counted, so the
 *     open-per-lookup defect cannot pass unnoticed, and the live-transport count
 *     is cross-checked against the process's own descriptor table
 *   - a reader that starts holding the index in memory: the resident growth over
 *     20,000 lookups is bounded
 *
 * WHAT IT MEASURES (printed as `key = value` lines with the input size beside
 * them): lookups/second, mean/median/p95 latency for hits and for misses, the
 * reads and opens each lookup costs, peak resident memory, live transports under
 * load, and the cost of one open+close — the per-lookup-reopen shape's unit price.
 *
 * THE TRANSPORT IS NOT gio. A gjs host reads through `Gio.FileInputStream`
 * (seek + read); this probe reads through `pread` on a file descriptor. The
 * reader's read PATTERN is identical under both (the same 8-byte offset windows
 * and the same key/payload reads, counted below), so the shape of the cost is
 * comparable while the per-syscall price is not. The gjs-side leak the reused
 * stream prevents — a stream per lookup retained by the process — is a
 * retention property this process does not reproduce, which is exactly why the
 * probe asserts the SHAPE (open count and live transports) rather than a leak.
 *
 * Run (repeatable; the fixture is reused when it already matches):
 *   node --expose-gc common/local-index/local-index.probe.mjs
 *   LOCAL_INDEX_PROBE_REAL=~/.local/share/tinshell/local-index/wordnet-3.0 \
 *     node --expose-gc common/local-index/local-index.probe.mjs
 *
 * Env:
 *   LOCAL_INDEX_PROBE_DIR       scratch root (default: $TMPDIR/tinshell-local-index-probe)
 *   LOCAL_INDEX_PROBE_ENTRIES   fixture entry count (default 147806)
 *   LOCAL_INDEX_PROBE_LOOKUPS   lookups per phase (default 10000)
 *   LOCAL_INDEX_PROBE_REBUILD=1 rebuild the fixture even when it matches
 *   LOCAL_INDEX_PROBE_REAL      measure this installed index directory too
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { encodeLocalIndex, manifestJson } from "./encode.ts"
import {
  blobStart,
  compareBytes,
  encodeUtf8,
  FORMAT_VERSION,
  KEY_RULE_VERBATIM,
  KEYS_FILE,
  LocalIndexFormatError,
  LocalIndexIntegrityError,
  offsetSlot,
  PAYLOAD_ENCODING_OPAQUE,
  ROWS_FILE,
  readUint32,
  writeUint32,
} from "./format.ts"
import { openLocalIndex } from "./reader.ts"

const DIR = process.env.LOCAL_INDEX_PROBE_DIR ?? join(tmpdir(), "tinshell-local-index-probe")
const ENTRIES = Number(process.env.LOCAL_INDEX_PROBE_ENTRIES ?? 147806)
const LOOKUPS = Number(process.env.LOCAL_INDEX_PROBE_LOOKUPS ?? 10000)
const REBUILD = process.env.LOCAL_INDEX_PROBE_REBUILD === "1"
const REAL = process.env.LOCAL_INDEX_PROBE_REAL ?? ""
const BIG_DIR = join(DIR, "big")
const EDGE_DIR = join(DIR, "edge")

/** The descriptor every fixture index is encoded with. A generated fixture has
 *  no corpus behind it, so its `source` describes the GENERATOR: the url names
 *  it and the bytes/hash are of the seed string the entries derive from. */
const SEED = "local-index.probe fixture v1"
const FIXTURE_DATASET = {
  corpus: "probe-fixture",
  release: "1",
  keyRule: KEY_RULE_VERBATIM,
  payloadEncoding: PAYLOAD_ENCODING_OPAQUE,
  licence: "generated fixture, no corpus",
  source: {
    url: "generated://local-index.probe",
    bytes: Buffer.byteLength(SEED, "utf8"),
    sha256: createHash("sha256").update(SEED).digest("hex"),
  },
}

// ── fixture generation (deterministic: same bytes on every run) ──

const SYLLABLES = [
  "ba",
  "be",
  "bi",
  "bo",
  "bu",
  "ca",
  "ce",
  "ci",
  "co",
  "cu",
  "da",
  "de",
  "di",
  "do",
  "du",
  "fa",
  "fe",
  "fi",
  "fo",
  "fu",
  "ga",
  "ge",
  "gi",
  "go",
  "gu",
  "la",
  "le",
  "li",
  "lo",
  "lu",
  "ma",
  "me",
  "mi",
  "mo",
  "mu",
  "na",
  "ne",
  "ni",
  "no",
  "nu",
  "pa",
  "pe",
  "pi",
  "po",
  "pu",
  "ra",
  "re",
  "ri",
  "ro",
  "ru",
  "sa",
  "se",
  "si",
  "so",
  "su",
  "ta",
  "te",
  "ti",
  "to",
  "tu",
]

/** Linear congruential generator: the fixture must be identical on every run, so
 *  no `Math.random` anywhere in this file. */
function makeRng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function makeWord(rng) {
  const syllables = 2 + Math.floor(rng() * 3)
  let word = ""
  for (let i = 0; i < syllables; i++) {
    word += SYLLABLES[Math.floor(rng() * SYLLABLES.length)]
    if (i === 1 && rng() < 0.4) word += rng() < 0.5 ? "-" : "'"
  }
  return word
}

/** Word-shaped keys with a ~140 byte payload each, i.e. the 147,806 x 157.3 B
 *  profile of a WordNet-class definition set. */
function makeEntries(count, seed) {
  const rng = makeRng(seed)
  const seen = new Set()
  const entries = []
  while (entries.length < count) {
    const word = makeWord(rng)
    if (seen.has(word)) continue
    seen.add(word)
    entries.push({
      key: word,
      payload: JSON.stringify({
        word,
        pos: "n",
        gloss:
          `the state of being ${makeWord(rng)}, as ${makeWord(rng)} does to ` +
          `${makeWord(rng)}; a ${makeWord(rng)} kept for ${makeWord(rng)}`,
        synonyms: [makeWord(rng), makeWord(rng)],
      }),
    })
  }
  return entries
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function writeIndex(dir, entries) {
  const { manifest, keys, rows } = encodeLocalIndex(entries, FIXTURE_DATASET, sha256Hex)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "keys.idx"), keys)
  writeFileSync(join(dir, "rows.dat"), rows)
  writeFileSync(join(dir, "manifest.json"), manifestJson(manifest))
  return manifest
}

/** Build the big fixture in a CHILD process, so this process's resident
 *  measurements are not taken after a 23 MiB encode. */
function fixtureMatches(dir, entries) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
    return (
      manifest?.formatVersion === FORMAT_VERSION &&
      manifest.entryCount === entries &&
      existsSync(join(dir, "keys.idx")) &&
      existsSync(join(dir, "rows.dat"))
    )
  } catch {
    return false
  }
}

if (process.argv.includes("--build-fixture")) {
  mkdirSync(BIG_DIR, { recursive: true })
  writeIndex(BIG_DIR, makeEntries(ENTRIES, 1))
  process.exit(0)
}

if (REBUILD || !fixtureMatches(BIG_DIR, ENTRIES)) {
  mkdirSync(DIR, { recursive: true })
  const build = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--build-fixture"], {
    stdio: "inherit",
  })
  if (build.status !== 0) throw new Error(`fixture build failed (exit ${build.status})`)
}

// ── checks + measurement bookkeeping ──

const checks = []
const check = (name, ok, detail = "") => {
  checks.push([name, ok, detail])
}

/** True when `fn` refuses with the format error — the encoder's own contract. */
function throwsFormat(fn) {
  try {
    fn()
    return false
  } catch (e) {
    return e instanceof LocalIndexFormatError
  }
}

const notes = []
const report = (label, value) => {
  notes.push(`${label} = ${value}`)
}

/** Transports this probe opens, counted HERE rather than self-reported by the
 *  reader: a reader that reopens per lookup cannot hide from its own opener. */
function newTally() {
  return { opens: 0, reads: 0, live: 0, paths: new Map() }
}

/** A file descriptor held open, read through `pread` — the probe's `ByteSource`.
 *  This is the "one persistent stream per file" shape on the node side. */
class FdByteSource {
  #fd
  #path
  #tally

  constructor(path, tally) {
    this.#fd = openSync(path, "r")
    this.#path = path
    this.#tally = tally
    this.#tally.opens++
    this.#tally.live++
    this.#tally.paths.set(path, (this.#tally.paths.get(path) ?? 0) + 1)
  }

  size() {
    return fstatSync(this.#fd).size
  }

  readAt(offset, length) {
    if (this.#fd < 0) throw new Error(`read from a closed transport: ${this.#path}`)
    this.#tally.reads++
    const buffer = Buffer.allocUnsafe(length)
    let got = 0
    while (got < length) {
      const n = readSync(this.#fd, buffer, got, length - got, offset + got)
      if (n <= 0) {
        throw new Error(`short read on ${this.#path}: wanted ${length} at ${offset}, got ${got}`)
      }
      got += n
    }
    return buffer
  }

  close() {
    if (this.#fd < 0) return
    closeSync(this.#fd)
    this.#fd = -1
    this.#tally.live--
  }
}

function openSource(tally) {
  return (path) => new FdByteSource(path, tally)
}

/** Descriptors this process actually holds under `dir` — independent evidence
 *  for the live-transport count (Linux `/proc`; empty elsewhere). */
function openFdsUnder(dir) {
  try {
    return readdirSync("/proc/self/fd")
      .map((fd) => {
        try {
          return readlinkSync(`/proc/self/fd/${fd}`)
        } catch {
          return ""
        }
      })
      .filter((target) => target.startsWith(dir))
  } catch {
    return []
  }
}

// ── 1. refusals: the manifest's version gate and the rest of the contract ──

/** A small index covering the boundary shapes a key set can have. */
const EDGE_ENTRIES = [
  { key: "0", payload: "payload:0" },
  { key: "a", payload: "payload:a" },
  { key: "aa", payload: "payload:aa" },
  { key: "ab", payload: "payload:ab" },
  { key: "b", payload: "payload:b" },
  { key: "ba", payload: "payload:ba" },
  { key: "zebra", payload: "payload:zebra" },
  { key: "émile", payload: "payload:émile" },
  { key: "ÉMILE", payload: "payload:ÉMILE" },
  { key: "🦀", payload: "payload:🦀" },
]

function loadEdge() {
  return {
    manifest: readFileSync(join(EDGE_DIR, "manifest.json"), "utf8"),
    keys: readFileSync(join(EDGE_DIR, "keys.idx")),
    rows: readFileSync(join(EDGE_DIR, "rows.dat")),
  }
}

function editManifest(files, edit) {
  const manifest = JSON.parse(files.manifest)
  edit(manifest)
  files.manifest = JSON.stringify(manifest, null, 2)
}

function writeCase(name, files) {
  const dir = join(DIR, "scratch", name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), files.manifest)
  writeFileSync(join(dir, "keys.idx"), files.keys)
  writeFileSync(join(dir, "rows.dat"), files.rows)
  return dir
}

/** Build one mutated copy of the edge fixture, open it, and assert the outcome:
 *  the named failure class whose message contains every fragment, or a clean
 *  open with a working lookup. */
function refusalCase(name, edit, expect, fragments) {
  const files = loadEdge()
  edit(files)
  const dir = writeCase(name, files)
  const tally = newTally()
  let index = null
  let error = null
  try {
    index = openLocalIndex(dir, openSource(tally))
  } catch (e) {
    error = e
  }
  if (expect === "opens") {
    check(`${name}: opens`, error === null, `threw ${String(error)}`)
    check(`${name}: lookup works`, index?.lookup("a")?.toString() === "payload:a")
    index?.close()
    return
  }
  const wanted = expect === "format" ? LocalIndexFormatError : LocalIndexIntegrityError
  check(`${name}: refused`, error instanceof wanted, `threw ${String(error)}`)
  const message = error instanceof Error ? error.message : ""
  for (const fragment of fragments) {
    check(`${name}: message names ${JSON.stringify(fragment)}`, message.includes(fragment), message)
  }
  check(`${name}: refusals leak no transport`, tally.live === 0, `${tally.live} live`)
  index?.close()
}

mkdirSync(DIR, { recursive: true })
writeIndex(EDGE_DIR, EDGE_ENTRIES)
const edgeManifest = JSON.parse(readFileSync(join(EDGE_DIR, "manifest.json"), "utf8"))

refusalCase(
  "unknown format version",
  (f) => editManifest(f, (m) => (m.formatVersion = FORMAT_VERSION + 1)),
  "format",
  [`format version ${FORMAT_VERSION + 1}`, `understands ${FORMAT_VERSION}`],
)
refusalCase(
  "unknown format name",
  (f) => editManifest(f, (m) => (m.format = "some-other-index")),
  "format",
  ["some-other-index", "tinshell-local-index"],
)
refusalCase(
  "manifest is not JSON",
  (f) => {
    f.manifest = "{ nope"
  },
  "format",
  ["not JSON"],
)
refusalCase(
  "manifest is not an object",
  (f) => {
    f.manifest = "[]"
  },
  "format",
  ["not a JSON object"],
)
refusalCase("manifest loses its rows ref", (f) => editManifest(f, (m) => delete m.rows), "format", [
  "rows",
])
refusalCase(
  "manifest entryCount is not a number",
  (f) => editManifest(f, (m) => (m.entryCount = "5")),
  "format",
  ["entryCount"],
)
refusalCase(
  "manifest loses a sha256",
  (f) => editManifest(f, (m) => (m.keys.sha256 = "")),
  "format",
  ["sha256"],
)
refusalCase(
  "manifest at another version is not read speculatively",
  (f) => editManifest(f, (m) => (m.formatVersion = FORMAT_VERSION - 1)),
  "format",
  [`format version ${FORMAT_VERSION - 1}`],
)
refusalCase(
  "keys file is short by one byte",
  (f) => {
    f.keys = f.keys.subarray(0, f.keys.length - 1)
  },
  "integrity",
  ["bytes on disk", "manifest records"],
)
refusalCase(
  "keys file has a corrupted magic",
  (f) => {
    f.keys[0] = 0x58
  },
  "format",
  ["bad magic"],
)
refusalCase(
  "keys file header carries another version",
  (f) => {
    writeUint32(f.keys, 8, FORMAT_VERSION + 1)
  },
  "format",
  ["keys.idx", `data file format version ${FORMAT_VERSION + 1}`],
)
refusalCase(
  "keys file header holds another entry count",
  (f) => {
    writeUint32(f.keys, 12, edgeManifest.entryCount + 1)
  },
  "integrity",
  ["manifest records", "holds"],
)
refusalCase(
  "manifest entryCount disagrees with the files",
  (f) => editManifest(f, (m) => (m.entryCount = edgeManifest.entryCount + 1)),
  "integrity",
  ["manifest records"],
)
refusalCase(
  "additive manifest fields are tolerated",
  (f) => editManifest(f, (m) => (m.generator = "local-index.probe")),
  "opens",
  [],
)
refusalCase(
  "manifest loses its dataset descriptor",
  (f) => editManifest(f, (m) => delete m.dataset),
  "format",
  ["dataset is not an object"],
)
refusalCase(
  "manifest loses the corpus name",
  (f) => editManifest(f, (m) => delete m.dataset.corpus),
  "format",
  ["dataset.corpus"],
)
refusalCase(
  "manifest names a key rule this reader does not know",
  (f) => editManifest(f, (m) => (m.dataset.keyRule = "case-sensitive")),
  "format",
  ["dataset.keyRule", '"case-sensitive"', '"verbatim"'],
)
refusalCase(
  "manifest names a payload encoding this reader does not know",
  (f) => editManifest(f, (m) => (m.dataset.payloadEncoding = "xml")),
  "format",
  ["dataset.payloadEncoding", '"xml"', '"sense-lines"'],
)
refusalCase(
  "manifest records a source hash that is not a sha256",
  (f) => editManifest(f, (m) => (m.dataset.source.sha256 = "640db279")),
  "format",
  ["dataset.source.sha256 is not a sha256"],
)
refusalCase(
  "manifest records a source of zero bytes",
  (f) => editManifest(f, (m) => (m.dataset.source.bytes = 0)),
  "format",
  ["dataset.source.bytes"],
)
refusalCase(
  "manifest records a data file hash that is not a sha256",
  (f) => editManifest(f, (m) => (m.keys.sha256 = "not a hash")),
  "format",
  ["keys.sha256 is not a sha256"],
)

// ── 2. correctness on the edge fixture ──

{
  const tally = newTally()
  const index = openLocalIndex(EDGE_DIR, openSource(tally))
  const edgeKeys = EDGE_ENTRIES.map((e) => e.key)
  let hits = 0
  for (const key of edgeKeys) {
    const payload = index.lookup(key)
    if (payload?.toString() === `payload:${key}`) hits++
    else check(`edge: ${JSON.stringify(key)} resolves`, false, `got ${String(payload)}`)
  }
  check("edge: every key resolves to its own payload", hits === edgeKeys.length, `${hits} hits`)
  check("edge: a first key resolves", index.lookup("0")?.toString() === "payload:0")
  check("edge: a last key resolves", index.lookup("🦀")?.toString() === "payload:🦀")
  check("edge: a prefix of a longer key misses", index.lookup("aaa") === null)
  check("edge: an absent key misses", index.lookup("zzz") === null)
  check("edge: the empty key misses", index.lookup("") === null)
  check(
    "edge: case-sensitive, byte-ordered keys stay distinct",
    index.lookup("émile")?.toString() === "payload:émile" &&
      index.lookup("ÉMILE")?.toString() === "payload:ÉMILE",
  )
  check(
    "edge: order is byte order, not locale order",
    compareBytes(encodeUtf8("zebra"), encodeUtf8("ÉMILE")) < 0 &&
      compareBytes(encodeUtf8("ÉMILE"), encodeUtf8("émile")) < 0,
  )
  const stats = index.stats()
  check(
    "edge: counters agree with the lookups issued",
    stats.hits === edgeKeys.length + 4 && stats.misses === 3,
    JSON.stringify(stats),
  )
  check("edge: two transports held", index.openStreams() === 2, `${index.openStreams()}`)
  index.close()
  check("edge: close releases both transports", tally.live === 0 && index.openStreams() === 0)
  let closedError = ""
  try {
    index.lookup("a")
  } catch (e) {
    closedError = e instanceof Error ? e.message : String(e)
  }
  check("edge: a lookup after close is refused", closedError.includes("closed"), closedError)
}

// A zero-entry index is legal: header + one offset slot, every lookup a miss.
{
  const emptyDir = join(DIR, "empty")
  writeIndex(emptyDir, [])
  const tally = newTally()
  const index = openLocalIndex(emptyDir, openSource(tally))
  check("empty index opens", index.manifest.entryCount === 0)
  check("empty index misses everything", index.lookup("a") === null)
  index.close()
  check("empty index releases on close", tally.live === 0)
}

check(
  "encoder rejects a duplicate key",
  throwsFormat(() =>
    encodeLocalIndex(
      [
        { key: "a", payload: "1" },
        { key: "a", payload: "2" },
      ],
      FIXTURE_DATASET,
      sha256Hex,
    ),
  ),
)
check(
  "encoder rejects an empty key",
  throwsFormat(() => encodeLocalIndex([{ key: "", payload: "1" }], FIXTURE_DATASET, sha256Hex)),
)

// ── 3. reuse shape: one transport per file, under load ──

const bigKeys = makeEntries(ENTRIES, 1).map((e) => e.key)
const sampleRng = makeRng(7)
const hitKeys = []
const missKeys = []
for (let i = 0; i < LOOKUPS; i++) {
  hitKeys.push(bigKeys[Math.floor(sampleRng() * bigKeys.length)])
  missKeys.push(`absent-${i}`)
}
// The sampling pass is done: dropping the full key list keeps the resident
// figures below a measurement of the READER rather than of this probe's fixture.
bigKeys.length = 0

const manifestOnDisk = JSON.parse(readFileSync(join(BIG_DIR, "manifest.json"), "utf8"))
const fixtureBytes = manifestOnDisk.keys.bytes + manifestOnDisk.rows.bytes

{
  const tally = newTally()
  const index = openLocalIndex(BIG_DIR, openSource(tally))
  const openedAtOpen = tally.opens
  const readsAtOpen = tally.reads
  const fdsAtOpen = openFdsUnder(BIG_DIR)
  check(
    "big: opening the index costs 3 transports (manifest, keys, rows)",
    openedAtOpen === 3,
    `${openedAtOpen} opens`,
  )

  let hits = 0
  for (const key of hitKeys) if (index.lookup(key) !== null) hits++

  const stats = index.stats()
  const readsPerLookup = (tally.reads - readsAtOpen) / stats.lookups
  const fdsUnderLoad = openFdsUnder(BIG_DIR)

  check("big: every sampled key hit", hits === hitKeys.length, `${hits}/${hitKeys.length}`)
  check(
    "big: NO transport is opened per lookup",
    tally.opens === 3,
    `${tally.opens} opens over ${stats.lookups} lookups`,
  )
  check("big: two transports live under load", tally.live === 2, `${tally.live} live`)
  check("big: the reader agrees it holds two", index.openStreams() === 2, `${index.openStreams()}`)
  check(
    "big: descriptors on disk match the live transports",
    fdsUnderLoad.length === 2 &&
      fdsUnderLoad.some((p) => p.endsWith("keys.idx")) &&
      fdsUnderLoad.some((p) => p.endsWith("rows.dat")),
    fdsUnderLoad.join(", "),
  )
  check("big: the descriptor count does not grow with lookups", fdsAtOpen.length === 2)
  report("transports opened over the load", `${tally.opens} (manifest 1, keys 1, rows 1)`)
  report("reads issued", `${tally.reads} total, ${readsPerLookup.toFixed(1)} per lookup`)
  report("live transports under load", `${tally.live} (keys.idx, rows.dat)`)

  index.close()
  check(
    "big: close releases both transports",
    tally.live === 0 && openFdsUnder(BIG_DIR).length === 0,
  )
}

// ── 4. latency: hits and misses ──

function timeLookups(index, keys) {
  const durations = new Array(keys.length)
  const start = process.hrtime.bigint()
  for (let i = 0; i < keys.length; i++) {
    const t0 = process.hrtime.bigint()
    index.lookup(keys[i])
    durations[i] = Number(process.hrtime.bigint() - t0) / 1000
  }
  const totalUs = Number(process.hrtime.bigint() - start) / 1000
  const sorted = [...durations].sort((a, b) => a - b)
  const meanUs = durations.reduce((sum, d) => sum + d, 0) / durations.length
  return {
    count: keys.length,
    perSecond: keys.length / (totalUs / 1_000_000),
    meanMs: meanUs / 1000,
    medianMs: sorted[Math.floor(sorted.length / 2)] / 1000,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] / 1000,
    worstMs: sorted[sorted.length - 1] / 1000,
  }
}

let hitTiming = null
let missTiming = null
{
  const tally = newTally()
  const index = openLocalIndex(BIG_DIR, openSource(tally))
  const readsBefore = tally.reads
  hitTiming = timeLookups(index, hitKeys)
  const readsAfterHits = tally.reads
  missTiming = timeLookups(index, missKeys)
  const readsPerHit = (readsAfterHits - readsBefore) / hitKeys.length
  const readsPerMiss = (tally.reads - readsAfterHits) / missKeys.length
  const stats = index.stats()
  check("latency: every sampled hit hit", stats.hits === hitKeys.length, JSON.stringify(stats))
  check(
    "latency: every sampled miss missed",
    stats.misses === missKeys.length,
    JSON.stringify(stats),
  )
  check(
    "latency: a hit beats a millisecond on average",
    hitTiming.meanMs < 1,
    `${hitTiming.meanMs.toFixed(4)} ms`,
  )
  report(
    "hit lookups/second",
    `${hitTiming.perSecond.toFixed(0)} (${hitTiming.count} lookups, ${ENTRIES} keys)`,
  )
  report(
    "hit latency (ms)",
    `mean ${hitTiming.meanMs.toFixed(4)}, median ${hitTiming.medianMs.toFixed(4)}, ` +
      `p95 ${hitTiming.p95Ms.toFixed(4)}, worst ${hitTiming.worstMs.toFixed(4)}`,
  )
  report(
    "miss latency (ms)",
    `mean ${missTiming.meanMs.toFixed(4)}, median ${missTiming.medianMs.toFixed(4)}, ` +
      `p95 ${missTiming.p95Ms.toFixed(4)}, worst ${missTiming.worstMs.toFixed(4)}`,
  )
  report(
    "miss lookups/second",
    `${missTiming.perSecond.toFixed(0)} (${missTiming.count} lookups, ${ENTRIES} keys)`,
  )
  report("reads per hit lookup", readsPerHit.toFixed(1))
  report("reads per miss lookup", readsPerMiss.toFixed(1))

  // The per-lookup-reopen shape's UNIT PRICE, measured here so the cost of the
  // defect is a number rather than a claim: one open+close of the same file.
  const openCloseRounds = 1000
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < openCloseRounds; i++) {
    const source = new FdByteSource(join(BIG_DIR, "rows.dat"), newTally())
    source.close()
  }
  const openCloseUs = Number(process.hrtime.bigint() - t0) / 1000 / openCloseRounds
  report("open+close of one file (us)", openCloseUs.toFixed(2))
  report(
    "implied per-lookup-reopen cost (ms)",
    `${((openCloseUs * readsPerMiss) / 1000).toFixed(3)} ` +
      `(${readsPerMiss.toFixed(1)} reads/lookup x ${openCloseUs.toFixed(2)} us)`,
  )
  index.close()
}

// ── 5. resident memory under load ──

const collect = () => {
  if (typeof globalThis.gc === "function") globalThis.gc()
}

{
  const tally = newTally()
  collect()
  const before = process.memoryUsage()
  const index = openLocalIndex(BIG_DIR, openSource(tally))
  collect()
  const open = process.memoryUsage()
  for (const key of hitKeys) index.lookup(key)
  for (const key of missKeys) index.lookup(key)
  collect()
  const after = process.memoryUsage()
  const peakRss = process.resourceUsage().maxRSS * 1024
  const growth = after.rss - before.rss
  const budget = 8 * 1024 * 1024

  check(
    "memory: 20,000 lookups do not hold the index resident",
    growth < budget,
    `+${(growth / 1024 / 1024).toFixed(2)} MiB (budget ${budget / 1024 / 1024} MiB)`,
  )
  report(
    "resident (MiB)",
    `before open ${(before.rss / 1024 / 1024).toFixed(1)}, after open ` +
      `${(open.rss / 1024 / 1024).toFixed(1)}, after 20,000 lookups ` +
      `${(after.rss / 1024 / 1024).toFixed(1)}`,
  )
  report(
    "js heap used (MiB)",
    `before open ${(before.heapUsed / 1024 / 1024).toFixed(1)}, after 20,000 lookups ` +
      `${(after.heapUsed / 1024 / 1024).toFixed(1)}`,
  )
  report("resident growth over 20,000 lookups (MiB)", (growth / 1024 / 1024).toFixed(2))
  report("peak RSS (MiB)", `${(peakRss / 1024 / 1024).toFixed(1)} (whole process)`)
  index.close()
  if (typeof globalThis.gc !== "function") {
    notes.push("NOTE: uncollected baseline — run with --expose-gc for the collected figure")
  }
}

// ── 6. the installed index (LOCAL_INDEX_PROBE_REAL) ──

/** Every key of an index's key file, read through the format's own offset
 *  table — the probe samples the KEYS THE ARTIFACT HOLDS, not a list this file
 *  would have to guess. */
function readKeyList(dir, file, tally) {
  const source = new FdByteSource(join(dir, file), tally)
  try {
    const bytes = source.readAt(0, source.size())
    const count = readUint32(bytes, 12)
    const start = blobStart(count)
    const keys = new Array(count)
    for (let i = 0; i < count; i++) {
      const from = readUint32(bytes, offsetSlot(i))
      const to = readUint32(bytes, offsetSlot(i + 1))
      keys[i] = Buffer.from(bytes.subarray(start + from, start + to)).toString("utf8")
    }
    return keys
  } finally {
    source.close()
  }
}

/** One mutated copy of the installed manifest, opened alone: `parseManifest`
 *  refuses before any data file is touched, so the scratch directory needs no
 *  copy of the index. */
function realRefusalCase(name, manifestBytes, edit, fragments) {
  const mutated = JSON.parse(manifestBytes)
  edit(mutated)
  const dir = join(DIR, "real-refusal", name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(mutated, null, 2))
  const tally = newTally()
  let error = null
  try {
    openLocalIndex(dir, openSource(tally))
  } catch (e) {
    error = e
  }
  check(`real ${name}: refused`, error instanceof LocalIndexFormatError, `threw ${String(error)}`)
  const message = error instanceof Error ? error.message : ""
  for (const fragment of fragments) {
    check(
      `real ${name}: message names ${JSON.stringify(fragment)}`,
      message.includes(fragment),
      message,
    )
  }
  check(`real ${name}: refusals leak no transport`, tally.live === 0, `${tally.live} live`)
}

if (REAL) {
  const realDir = REAL.startsWith("~") ? join(homedir(), REAL.slice(1)) : REAL
  const manifestBytes = readFileSync(join(realDir, "manifest.json"), "utf8")
  const manifest = JSON.parse(manifestBytes)

  const keyTally = newTally()
  const allKeys = readKeyList(realDir, KEYS_FILE, keyTally)
  const dataBytes = manifest.keys.bytes + manifest.rows.bytes
  let ordered = allKeys.length > 1
  for (let i = 1; i < allKeys.length; i++) {
    if (compareBytes(encodeUtf8(allKeys[i - 1]), encodeUtf8(allKeys[i])) >= 0) ordered = false
  }
  check(
    "real: the key file reads back through its own offset table",
    allKeys.length > 0,
    `${allKeys.length} keys`,
  )
  check("real: the key file is strictly sorted by byte order", ordered)

  const realHitKeys = []
  const stride = Math.max(1, Math.floor(allKeys.length / LOOKUPS))
  for (let i = 0; i < allKeys.length && realHitKeys.length < LOOKUPS; i += stride) {
    realHitKeys.push(allKeys[i])
  }
  const realMissKeys = realHitKeys.map((_, i) => `absent-${i}`)
  allKeys.length = 0 // the resident figures below measure the READER, not this list

  console.log("")
  console.log(
    `MEASUREMENT 2 (installed index: ${manifest.entryCount} keys, ` +
      `${(dataBytes / 1024 / 1024).toFixed(2)} MiB of data files, ` +
      `${(dataBytes / manifest.entryCount).toFixed(1)} B/key, in ${realDir})`,
  )
  console.log(
    `  dataset = ${manifest.dataset.corpus} ${manifest.dataset.release}, ` +
      `key rule ${manifest.dataset.keyRule}, payload ${manifest.dataset.payloadEncoding}`,
  )
  console.log(
    `  dataset source = ${manifest.dataset.source.bytes} B, sha256 ` +
      `${manifest.dataset.source.sha256}, licence ${manifest.dataset.licence}`,
  )
  console.log(`  manifest = format version ${manifest.formatVersion}, ${manifestBytes.length} B`)

  const tally = newTally()
  collect()
  const before = process.memoryUsage()
  const index = openLocalIndex(realDir, openSource(tally))
  collect()
  const opened = process.memoryUsage()
  const openedAtOpen = tally.opens
  const readsAtOpen = tally.reads
  const fdsAtOpen = openFdsUnder(realDir)

  check(
    "real: opening the index costs 3 transports (manifest, keys, rows)",
    openedAtOpen === 3,
    `${openedAtOpen} opens`,
  )
  let hits = 0
  for (const key of realHitKeys) if (index.lookup(key) !== null) hits++
  const readsAfterHits = tally.reads
  let absentHits = 0
  for (const key of realMissKeys) if (index.lookup(key) !== null) absentHits++
  const realStats = index.stats()
  const readsPerRealHit = (readsAfterHits - readsAtOpen) / realStats.hits
  const readsPerRealMiss = (tally.reads - readsAfterHits) / realStats.misses
  const fdsUnderLoad = openFdsUnder(realDir)

  check(
    "real: every sampled key hits",
    hits === realHitKeys.length,
    `${hits}/${realHitKeys.length}`,
  )
  check("real: an absent key misses", absentHits === 0, `${absentHits} unexpected hits`)
  check("real: NO transport is opened per lookup", tally.opens === 3, `${tally.opens} opens`)
  check("real: two transports live under load", tally.live === 2, `${tally.live} live`)
  check("real: the reader agrees it holds two", index.openStreams() === 2, `${index.openStreams()}`)
  check(
    "real: descriptors on disk match the live transports",
    fdsUnderLoad.length === 2 &&
      fdsUnderLoad.some((p) => p.endsWith(KEYS_FILE)) &&
      fdsUnderLoad.some((p) => p.endsWith(ROWS_FILE)),
    fdsUnderLoad.join(", "),
  )
  check("real: the descriptor count does not grow with lookups", fdsAtOpen.length === 2)

  const realHitTiming = timeLookups(index, realHitKeys)
  const realMissTiming = timeLookups(index, realMissKeys)
  collect()
  const after = process.memoryUsage()
  const growth = after.rss - before.rss

  check(
    "real: hit latency beats a millisecond on average",
    realHitTiming.meanMs < 1,
    `${realHitTiming.meanMs.toFixed(4)} ms`,
  )
  check(
    "real: 2 x sampled lookups do not hold the index resident",
    growth < 8 * 1024 * 1024,
    `+${(growth / 1024 / 1024).toFixed(2)} MiB`,
  )
  report("real key count", `${manifest.entryCount} (sampled ${realHitKeys.length} hit keys)`)
  report("real data files", `${(dataBytes / 1024 / 1024).toFixed(2)} MiB`)
  report(
    "real hit latency (ms)",
    `mean ${realHitTiming.meanMs.toFixed(4)}, median ${realHitTiming.medianMs.toFixed(4)}, ` +
      `p95 ${realHitTiming.p95Ms.toFixed(4)}, worst ${realHitTiming.worstMs.toFixed(4)}`,
  )
  report(
    "real miss latency (ms)",
    `mean ${realMissTiming.meanMs.toFixed(4)}, median ${realMissTiming.medianMs.toFixed(4)}, ` +
      `p95 ${realMissTiming.p95Ms.toFixed(4)}, worst ${realMissTiming.worstMs.toFixed(4)}`,
  )
  report("real hit lookups/second", `${realHitTiming.perSecond.toFixed(0)}`)
  report("real reads per hit lookup", readsPerRealHit.toFixed(1))
  report("real reads per miss lookup", readsPerRealMiss.toFixed(1))
  report(
    "real transports opened over the load",
    `${tally.opens} (manifest 1, keys 1, rows 1), live ${tally.live}`,
  )
  report(
    "real resident (MiB)",
    `before open ${(before.rss / 1024 / 1024).toFixed(1)}, after open ` +
      `${(opened.rss / 1024 / 1024).toFixed(1)}, after ${realStats.lookups} lookups ` +
      `${(after.rss / 1024 / 1024).toFixed(1)}, growth ${(growth / 1024 / 1024).toFixed(2)}`,
  )
  index.close()
  check(
    "real: close releases both transports",
    tally.live === 0 && openFdsUnder(realDir).length === 0,
  )

  realRefusalCase(
    "unknown format version",
    manifestBytes,
    (m) => (m.formatVersion = FORMAT_VERSION + 1),
    [`format version ${FORMAT_VERSION + 1}`, `understands ${FORMAT_VERSION}`],
  )
  realRefusalCase("unknown key rule", manifestBytes, (m) => (m.dataset.keyRule = "stemmed"), [
    "dataset.keyRule",
    '"stemmed"',
    '"lemma-lowercase-marker-stripped"',
  ])
  realRefusalCase(
    "unknown payload encoding",
    manifestBytes,
    (m) => (m.dataset.payloadEncoding = "protobuf"),
    ["dataset.payloadEncoding", '"protobuf"', '"sense-lines"'],
  )
}

// ── results ──

const failed = checks.filter(([, ok]) => !ok)
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`)
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
console.log("")
console.log(
  `MEASUREMENT (fixture: ${ENTRIES} keys, ${(fixtureBytes / 1024 / 1024).toFixed(2)} MiB ` +
    `of data files, ${(fixtureBytes / ENTRIES).toFixed(1)} B/key, in ${BIG_DIR})`,
)
for (const line of notes) console.log(`  ${line}`)
if (failed.length > 0) {
  throw new Error(`local-index probe failed: ${failed.length} check(s)`)
}
