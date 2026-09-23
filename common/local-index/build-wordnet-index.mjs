/**
 * build-wordnet-index — the deterministic builder for the shipped WordNet index
 * under `~/.local/share/tinshell/local-index/wordnet-3.0/`.
 *
 * SOURCE IS PINNED AND VERIFIED BEFORE ANYTHING IS READ FROM IT. The one
 * accepted input is Princeton's WordNet 3.0 distribution tarball, identified by
 * both its byte length and its sha256 (`SOURCE_*` below). A source that does not
 * match is REFUSED — the build stops, it does not retry, substitute or continue
 * — because every number in the manifest's provenance section is a claim about
 * exactly those bytes. The build performs no network access: the tarball is an
 * input path, and the artifact directory is written from it alone.
 *
 * THE ARTIFACT IS A PURE FUNCTION OF THE SOURCE BYTES. Same tarball in, same
 * `keys.idx`, `rows.dat` and `manifest.json` out, byte for byte: senses are
 * taken in a fixed part-of-speech order (noun, verb, adjective, adverb) and in
 * file order within each, the encoder sorts keys by raw byte order, and the
 * manifest carries no timestamp, no path and no run identity. Two builds of one
 * tarball are therefore comparable by hash, which is how the build is verified.
 *
 * WHAT THE CORPUS IS. One key per distinct case-folded lemma across the four
 * `dict/data.*` files, with WordNet's adjective-satellite and pertainym markers
 * `(a)` and `(p)` stripped (they are notation, not part of a word) — the
 * normalisation `format.ts`'s `normaliseLemmaKey` implements, so this file and
 * any consumer cannot spell the rule differently. Each key's row holds one line
 * per sense, `<gloss>\t<synonyms>`, in that fixed order.
 *
 * WHAT IT REFUSES: a source of the wrong length or hash; a tarball missing a
 * data file or the licence; a synset line it cannot parse; a gloss carrying a
 * tab or a construction that would make a row undecodable; a key count that
 * disagrees with the recorded one. A build that cannot state what it produced
 * fails instead of shipping a smaller or differently-keyed corpus.
 *
 * Run:
 *   node --experimental-strip-types common/local-index/build-wordnet-index.mjs \
 *     --source /path/to/WordNet-3.0.tar.gz --out ~/.local/share/tinshell/local-index/wordnet-3.0
 *
 * Env: none. Every input is a command-line argument, so a rebuild cannot depend
 * on ambient state.
 *
 * WHY `.mjs`: like `local-index.probe.mjs`, this is a Node harness — it imports
 * `node:crypto`, `node:fs` and `node:zlib`, which the root typecheck program
 * (apps/** + common/**) deliberately has no types for. The format, the encoder
 * and the reader stay typed TS and stay in that program.
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { encodeLocalIndex, manifestJson } from "./encode.ts"
import {
  KEY_RULE_LEMMA,
  KEYS_FILE,
  normaliseLemmaKey,
  PAYLOAD_ENCODING_SENSE_LINES,
  ROWS_FILE,
} from "./format.ts"

/** The one accepted source artifact. */
const SOURCE_URL = "https://wordnetcode.princeton.edu/3.0/WordNet-3.0.tar.gz"
const SOURCE_BYTES = 11537239
const SOURCE_SHA256 = "640db279c949a88f61f851dd54ebbb22d003f8b90b85267042ef85a3781d3a52"

const CORPUS = "wordnet"
const RELEASE = "3.0"
const LICENCE = "WordNet Release 3.0 (Princeton University)"
const LICENCE_FILE = "LICENSE.txt"

/** Part-of-speech order is FIXED and is the sense order inside a row: the same
 *  source bytes must produce the same row text on every build. */
const DATA_MEMBERS = [
  "WordNet-3.0/dict/data.noun",
  "WordNet-3.0/dict/data.verb",
  "WordNet-3.0/dict/data.adj",
  "WordNet-3.0/dict/data.adv",
]
const LICENCE_MEMBER = "WordNet-3.0/LICENSE"

/** The key count these sources produce under the rule above. A build that
 *  disagrees has parsed something other than the pinned corpus. */
const EXPECTED_KEYS = 147318

/** The gloss separator in a `data.*` synset line, and the adjective-satellite /
 *  pertainym marker a display form drops (the lookup form drops it too, through
 *  `normaliseLemmaKey`). */
const GLOSS_SEPARATOR = " | "
const MARKER = /\((a|p)\)$/

const MANIFEST_FILE = "manifest.json"

function fail(message) {
  throw new Error(`build-wordnet-index: ${message}`)
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

// ── ustar reading (the four data files and the licence come out of the tarball
// in memory: no `tar` process, so the verified bytes are the bytes parsed) ──

function tarString(header, offset, length) {
  let end = offset
  const limit = offset + length
  while (end < limit && header[end] !== 0) end++
  return Buffer.from(header.subarray(offset, end)).toString("utf8")
}

/** Members of a plain ustar archive by name. Only regular files are returned;
 *  WordNet's paths are short, so the `prefix` field and GNU long names do not
 *  occur in it — a name that is not a directory and not found is a refusal. */
function tarMembers(tar) {
  const members = new Map()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header[0] === 0) break
    const name = tarString(header, 0, 100)
    const size = Number.parseInt(tarString(header, 124, 12).trim(), 8) || 0
    const type = String.fromCharCode(header[156])
    const start = offset + 512
    if (type === "0" || type === "\0") members.set(name, tar.subarray(start, start + size))
    offset = start + Math.ceil(size / 512) * 512
  }
  return members
}

function member(members, name) {
  const bytes = members.get(name)
  if (bytes === undefined) fail(`the source tarball holds no ${name}`)
  return bytes
}

// ── corpus parsing ──

/**
 * Parse one `dict/data.*` file: every synset line is
 * `offset lex_filenum ss_type w_cnt (word lex_id)* p_cnt (ptr)* | gloss`,
 * with `w_cnt` hexadecimal. Returns the synsets in file order. A member keeps
 * BOTH forms: `key` is the normalised lookup form and `display` is the lemma as
 * the corpus writes it, which is what a row shows (a payload is display data,
 * so it keeps capitalisation; only the KEYS are case-folded).
 */
function parseDataFile(text, file) {
  const synsets = []
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("  ")) continue
    const parts = line.split(" ")
    const memberCount = Number.parseInt(parts[3], 16)
    if (!Number.isInteger(memberCount) || memberCount < 1) {
      fail(`${file}: cannot read the member count of a synset line`)
    }
    const separator = line.indexOf(GLOSS_SEPARATOR)
    if (separator < 0) fail(`${file}: synset line carries no gloss`)
    const members = []
    for (let i = 0; i < memberCount; i++) {
      const word = parts[4 + 2 * i]
      if (word === undefined || word.length === 0) fail(`${file}: synset member ${i} is empty`)
      members.push({ key: normaliseLemmaKey(word), display: word.replace(MARKER, "") })
    }
    synsets.push({ members, gloss: line.slice(separator + GLOSS_SEPARATOR.length) })
  }
  return synsets
}

/** Build the entries: one per distinct lemma, rows one `gloss\tsynonyms` line
 *  per sense, senses in the order the fixed part-of-speech pass meets them.
 *  Synonyms are the other lemmas of the same synset, deduplicated and in file
 *  order; a single-member synset's row line has an empty synonym list. */
function corpusEntries(members) {
  const senses = new Map()
  for (const name of DATA_MEMBERS) {
    const file = name.slice(name.lastIndexOf("/") + 1)
    const synsets = parseDataFile(member(members, name).toString("utf8"), file)
    for (const synset of synsets) {
      if (synset.gloss.includes("\t")) fail(`${file}: a gloss carries a tab`)
      for (const member of synset.members) {
        const synonyms = []
        const seen = new Set()
        for (const other of synset.members) {
          if (other.key === member.key || seen.has(other.display)) continue
          seen.add(other.display)
          synonyms.push(other.display)
        }
        let lines = senses.get(member.key)
        if (lines === undefined) {
          lines = []
          senses.set(member.key, lines)
        }
        lines.push(`${synset.gloss}\t${synonyms.join(" ")}`)
      }
    }
  }
  if (senses.size !== EXPECTED_KEYS) {
    fail(`the source produced ${senses.size} keys, this corpus is ${EXPECTED_KEYS}`)
  }
  return [...senses.entries()].map(([key, lines]) => ({ key, payload: lines.join("\n") }))
}

// ── command line ──

function argument(flag) {
  const at = process.argv.indexOf(flag)
  if (at < 0 || at + 1 >= process.argv.length) fail(`${flag} <path> is required`)
  return process.argv[at + 1]
}

const sourcePath = argument("--source")
const outDir = argument("--out")

// ── verify, then read ──

const source = readFileSync(sourcePath)
if (source.length !== SOURCE_BYTES) {
  fail(`source is ${source.length} bytes, the pinned WordNet 3.0 tarball is ${SOURCE_BYTES}`)
}
const sourceSha256 = sha256Hex(source)
if (sourceSha256 !== SOURCE_SHA256) {
  fail(`source sha256 is ${sourceSha256}, the pinned tarball is ${SOURCE_SHA256}`)
}

const members = tarMembers(gunzipSync(source))
const licence = member(members, LICENCE_MEMBER)
const entries = corpusEntries(members)

const { manifest, keys, rows } = encodeLocalIndex(
  entries,
  {
    corpus: CORPUS,
    release: RELEASE,
    keyRule: KEY_RULE_LEMMA,
    payloadEncoding: PAYLOAD_ENCODING_SENSE_LINES,
    licence: LICENCE,
    source: { url: SOURCE_URL, bytes: SOURCE_BYTES, sha256: SOURCE_SHA256 },
  },
  sha256Hex,
)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, KEYS_FILE), keys)
writeFileSync(join(outDir, ROWS_FILE), rows)
writeFileSync(join(outDir, MANIFEST_FILE), manifestJson(manifest))
writeFileSync(join(outDir, LICENCE_FILE), licence)

const rowLines = entries.reduce((sum, entry) => sum + entry.payload.split("\n").length, 0)
console.log(
  `corpus            ${CORPUS} ${RELEASE} (${KEY_RULE_LEMMA}, ${PAYLOAD_ENCODING_SENSE_LINES})`,
)
console.log(`source            ${SOURCE_BYTES} B, sha256 ${SOURCE_SHA256}`)
console.log(
  `keys              ${manifest.entryCount} (${keys.length} B, sha256 ${manifest.keys.sha256})`,
)
console.log(
  `rows              ${rows.length} B (sha256 ${manifest.rows.sha256}), ${rowLines} senses`,
)
console.log(`bytes per key     ${((keys.length + rows.length) / manifest.entryCount).toFixed(1)}`)
console.log(`artifact          ${outDir}`)
