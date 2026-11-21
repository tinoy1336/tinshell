/**
 * Emoji table generator — `common/emoji/data.ts` is the SHIPPED artifact of the
 * Unicode emoji test data (https://unicode.org/Public/emoji/latest/emoji-test.txt),
 * not a hand-written table: the glyph, the CLDR short name and the group come
 * from the file, and nothing here invents an entry.
 *
 * What the table carries: every FULLY-QUALIFIED single-glyph emoji — one
 * codepoint, or a base plus its emoji presentation selector (U+FE0F), or a
 * regional-indicator flag pair. Sequences (ZWJ, tag flags, keycaps) are
 * excluded, and so is anything qualified by a skin-tone modifier
 * (U+1F3FB–U+1F3FF) or a hair component (U+1F9B0–U+1F9B3): those variants
 * differ from their base emoji only by a modifier, and a picker that lists
 * every tone buries the base entry. The `Component` group goes with them — it
 * holds the modifiers themselves.
 *
 * Keywords are DERIVED, never curated: the name's own words plus the tokens of
 * the CLDR subgroup label (subgroup `book-paper` gives 📚 the keywords `book`
 * and `paper`, which the name `books` alone does not).
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-emoji.ts --source <path|url>
 *     regenerate common/emoji/data.ts from that emoji-test.txt
 *   node --experimental-strip-types scripts/gen-emoji.ts --check --source <path|url>
 *     verify the committed table still matches that source (exit 1 when stale)
 *
 * A check compares ENTRIES, not bytes, so formatting never decides the verdict;
 * it still needs the same source file, because the committed table is a function
 * of it and of nothing else.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, "common", "emoji", "data.ts")
const BIOME = join(ROOT, "node_modules", "@biomejs", "biome", "bin", "biome")

/** Groups the table carries. `Component` is excluded by construction: it lists
 *  skin-tone and hair modifiers, which qualify other emoji instead of standing
 *  alone in a picker. */
const SKIP_GROUPS = new Set(["Component"])

/** Name words that carry no search value of their own — every entry's name has
 *  them, so keeping them would make every entry match every multiword query. */
const FILLERS = new Set(["a", "an", "and", "of", "the", "with", "in", "on", "plus", "for"])

interface EmojiEntry {
  glyph: string
  name: string
  keywords: string[]
}

interface Generated {
  version: string
  digest: string
  entries: EmojiEntry[]
}

/** One `codepoints ; status # glyph E<version> name` data line. */
const DATA_LINE = /^([0-9A-Fa-f ]+)\s*;\s*(\S+)\s*#\s*(\S+)\s+E\S+\s+(.+)$/

/** Modifier codepoints: skin tones and the hair components. An entry carrying
 *  one is a variant of the entry without it. */
const MODIFIERS: Array<[number, number]> = [
  [0x1f3fb, 0x1f3ff],
  [0x1f9b0, 0x1f9b3],
]

/** A glyph the table can hold: one or two codepoints, no joiner, no modifier. */
function keepable(codepoints: string): boolean {
  const parts = codepoints.trim().split(/\s+/)
  if (parts.length > 2) return false
  if (parts.includes("200D")) return false
  return !parts.some((p) => {
    const cp = Number.parseInt(p, 16)
    return MODIFIERS.some(([lo, hi]) => cp >= lo && cp <= hi)
  })
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !FILLERS.has(t))
}

function parse(source: string): Generated {
  const lines = source.split("\n")
  const versionLine = lines.find((l) => l.startsWith("# Version:"))
  if (!versionLine) throw new Error("no '# Version:' line — is this emoji-test.txt?")
  const version = versionLine.slice("# Version:".length).trim()

  const entries: EmojiEntry[] = []
  let group = ""
  let subgroup = ""
  let foundGroup = false

  for (const line of lines) {
    if (line.startsWith("# group:")) {
      group = line.slice("# group:".length).trim()
      foundGroup = true
      continue
    }
    if (line.startsWith("# subgroup:")) {
      subgroup = line.slice("# subgroup:".length).trim()
      continue
    }
    if (!foundGroup || line.startsWith("#") || !line.trim()) continue

    const m = DATA_LINE.exec(line)
    if (!m) throw new Error(`unparsable data line: ${line.slice(0, 80)}`)
    const [, codepoints, status, glyph, name] = m
    if (status !== "fully-qualified") continue
    if (SKIP_GROUPS.has(group)) continue
    if (!keepable(codepoints)) continue

    const keywords: string[] = []
    for (const token of [...tokens(name), ...tokens(subgroup)]) {
      if (!keywords.includes(token)) keywords.push(token)
    }
    entries.push({ glyph, name, keywords })
  }

  if (!entries.length) throw new Error("parsed no emoji from the source file")
  return {
    version,
    digest: createHash("sha256").update(source).digest("hex"),
    entries,
  }
}

function render({ version, digest, entries }: Generated): string {
  const body = entries
    .map((e) => {
      const glyph = JSON.stringify(e.glyph)
      const name = JSON.stringify(e.name)
      const keywords = `[${e.keywords.map((k) => JSON.stringify(k)).join(", ")}]`
      return `  { glyph: ${glyph}, name: ${name}, keywords: ${keywords} },`
    })
    .join("\n")

  return `/**
 * Emoji table — the SINGLE owner of emoji data in this home (Emoji ${version},
 * CLDR short names). GENERATED by scripts/gen-emoji.ts from
 * https://unicode.org/Public/emoji/latest/emoji-test.txt
 * (sha256 ${digest.slice(0, 16)}…): every fully-qualified single-glyph emoji,
 * i.e. one codepoint or a base plus U+FE0F, plus the regional-indicator flags.
 * ZWJ sequences, tag flags, keycaps, skin-tone and hair modifiers, and the
 * file's \`Component\` group are excluded. Keywords are derived from the name and
 * the CLDR subgroup label, never curated — edit the generator, then
 * \`npm run gen:emoji\`, and never this file.
 *
 * Consumers: the launcher's emoji mode (searchEntries in ./search.ts) — the
 * module is surface-agnostic (common/emoji/), so any surface ranks the same
 * table. Do NOT fork a copy — one table, one owner.
 */
export interface EmojiEntry {
  glyph: string
  name: string
  keywords: string[]
}

export const EMOJI: EmojiEntry[] = [
${body}
]
`
}

/** The committed table as the module itself sees it. */
async function committed(): Promise<EmojiEntry[]> {
  const mod = (await import(pathToFileURL(OUT).href)) as { EMOJI: EmojiEntry[] }
  return mod.EMOJI
}

function format(): void {
  execFileSync(process.execPath, [BIOME, "format", "--write", OUT], { stdio: "inherit" })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const check = args.includes("--check")
  const at = args.indexOf("--source")
  if (at === -1 || !args[at + 1]) {
    throw new Error("usage: gen-emoji.ts --source <path|url> [--check]")
  }
  const source = args[at + 1]
  const text = /^https?:/.test(source)
    ? await (await fetch(source)).text()
    : readFileSync(source, "utf8")

  const generated = parse(text)

  if (check) {
    const current = await committed()
    const a = JSON.stringify(current)
    const b = JSON.stringify(generated.entries)
    if (a !== b) {
      const known = new Set(current.map((e) => e.glyph))
      const missing = generated.entries.filter((e) => !known.has(e.glyph)).length
      const extra = current.filter(
        (e) => !generated.entries.some((g) => g.glyph === e.glyph),
      ).length
      console.error(
        `data.ts is stale: ${current.length} committed vs ${generated.entries.length} from ` +
          `emoji ${generated.version} (${missing} missing, ${extra} no longer in the source). ` +
          "Run `npm run gen:emoji`.",
      )
      process.exit(1)
    }
    console.log(`data.ts: current — emoji ${generated.version}, ${current.length} entries`)
    return
  }

  writeFileSync(OUT, render(generated))
  format()

  const written = readFileSync(OUT, "utf8")
  if (/EmojiEntry\[\] = \[\n\n/.test(written)) throw new Error("empty table written")
  const reread = await committed()
  if (reread.length !== generated.entries.length) {
    throw new Error(`wrote ${generated.entries.length} entries, module reads ${reread.length}`)
  }
  console.log(
    `data.ts: emoji ${generated.version}, ${generated.entries.length} entries ` +
      `(sha256 ${generated.digest.slice(0, 16)}…)`,
  )
}

await main()
