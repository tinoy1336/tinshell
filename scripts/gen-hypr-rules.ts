/**
 * Compositor-rule generator — renders every app-owned compositor rule into the
 * compositor config's rule directory (`~/.config/hypr/rules/`).
 *
 * WHAT IS GENERATED: one Lua fragment per owner. The definitions live beside the
 * surfaces that own them (`apps/<app>/hypr-rules.ts`, `common/session-rules.ts`)
 * and name their surface through that surface's own identity constant
 * (`apps/<app>/identity.ts`), so the compositor cannot be left matching a
 * namespace or an app_id that no longer exists. The emitted calls are the same
 * `hl.layer_rule` / `hl.window_rule` shapes the config spelled inline, so the
 * semantics are unchanged; see common/hyprland/rule.ts for the model.
 *
 * ORDERING: the config requires this directory with a wildcard, and Hyprland
 * requires every match in ascending FILENAME order (byte order — Hyprland sorts
 * the expanded paths). The numeric prefix is fixed-width, so numeric order IS
 * byte order; the ordering rule itself is restated in every generated header.
 *
 * ATOMICITY: a fragment is written to a temporary name in the SAME directory,
 * flushed with fsync, then renamed into place, so a reader never sees a
 * half-written file. A fragment whose bytes already match is left untouched —
 * the compositor reads config paths over the wildcard, so a rewrite would make
 * it re-read a file that had not changed.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-hypr-rules.ts [--target DIR] [--check]
 *     writes every fragment into DIR (default ~/.config/hypr/rules)
 *   --check compares the directory against a fresh render and exits non-zero on
 *   a stale, missing or no-longer-generated file
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { HyprRuleSet, LayerRuleSpec, WindowRuleSpec } from "../common/hyprland/rule"
import { DECORATION_REASSERTION_REASON } from "../common/hyprland/rule.ts"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const APPS = join(ROOT, "apps")

/** File name of a rule set inside an app directory. */
const RULE_FILE = "hypr-rules.ts"

/** Rule sets that are not an app's own: the shell surfaces owned by common/. */
const COMMON_RULE_FILES = [{ owner: "session", file: join(ROOT, "common", "session-rules.ts") }]

/**
 * Registration order, one number per owner — the number IS the file name's
 * prefix (`<order>-<owner>.lua`). Ascending, because a window rule's keys are
 * applied over every earlier match and the LAST match wins: a rule that has to
 * out-rank another has to sort after it. Layer rules select disjoint namespaces,
 * so only the window rules are order-sensitive, and their order is theirs to
 * state here.
 */
const ORDER: Record<string, number> = {
  dock: 10,
  launcher: 20,
  notifications: 30,
  keyboard: 40,
  clipboard: 50,
  promptd: 60,
  session: 70,
  notes: 80,
  files: 90,
  media: 100,
  portal: 110,
  annotate: 120,
}

/** Name of the comment-only file that keeps the config's wildcard `require`
 *  matching when a directory holds no generated rule yet: Hyprland's wildcard
 *  require fails on a pattern that matches nothing. It sorts before every
 *  fragment (its `-` is below any digit) and carries no rule. */
const PLACEHOLDER = "00-placeholder.lua"

const DEFAULT_TARGET = join(process.env.HOME ?? "", ".config", "hypr", "rules")

/** Window-rule keys in the order they are emitted — the shape a hand-written
 *  rule in the config used, so a generated fragment reads the same way. */
const WINDOW_KEY_ORDER = [
  "name",
  "match",
  "float",
  "rounding",
  "size",
  "decorate",
  "border_size",
  "move",
] as const

/** A Lua string literal: the emitted fragment is Lua source, so a backslash the
 *  pattern needs (`io\.Astal\.notes`) has to survive as a backslash in the
 *  file and as ONE escape by the time the compositor reads the pattern. */
function luaString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function luaValue(value: string | number | boolean): string {
  return typeof value === "string" ? luaString(value) : String(value)
}

function renderMatch(match: Record<string, string | boolean>): string {
  const keys = Object.keys(match)
  const parts = keys.map((key) => `${key} = ${luaValue(match[key])}`)
  return `{ ${parts.join(", ")} }`
}

function renderLayerRule(rule: LayerRuleSpec): string {
  const parts = [`match = ${renderMatch(rule.match)}`]
  if (rule.blur !== undefined) parts.push(`blur = ${luaValue(rule.blur)}`)
  if (rule.ignore_alpha !== undefined) parts.push(`ignore_alpha = ${luaValue(rule.ignore_alpha)}`)
  if (rule.no_anim !== undefined) parts.push(`no_anim = ${luaValue(rule.no_anim)}`)
  return `hl.layer_rule({ ${parts.join(", ")} })`
}

function renderWindowRule(rule: WindowRuleSpec): string {
  const fields: Record<string, string> = {
    name: luaString(rule.name),
    match: renderMatch(rule.match),
    float: luaValue(rule.float ?? false),
    rounding: luaValue(rule.rounding ?? 0),
    size: rule.size ? `{ ${rule.size.app}W, ${rule.size.app}H }` : "{}",
    decorate: luaValue(rule.decorate ?? false),
    border_size: luaValue(rule.border_size ?? 0),
    move: rule.move ? `{ ${rule.move.x}, ${rule.move.y} }` : "{}",
  }
  const present = WINDOW_KEY_ORDER.filter((key) => {
    switch (key) {
      case "name":
      case "match":
        return true
      case "size":
        return rule.size !== undefined
      case "move":
        return rule.move !== undefined
      default:
        return rule[key] !== undefined
    }
  })
  const parts = present.map((key) => `${key} = ${fields[key]}`)
  return `hl.window_rule({ ${parts.join(", ")} })`
}

/** The Lua reader for a window rule's pinned map size. Emitted per file that
 *  pins one: a required fragment owns its own locals, so a shared reader would
 *  need a module path the config cannot be assumed to resolve. */
function mapSizeReader(): string[] {
  return [
    "-- The map size the rules below pin, read from the app's OWN config: a window",
    "-- rule applies at map time, and a fresh float whose first commit loses the",
    "-- startup race is given the compositor's half-monitor default configure — GTK4",
    "-- obeys that nonzero configure and an XDG window has no post-map resize — so",
    "-- the rule and the app have to read ONE value. The live config wins; the app's",
    "-- shipped defaults are the fallback.",
    `local function configMapSize(app, fallbackW, fallbackH)`,
    `    local paths = {`,
    `        os.getenv("HOME") .. "/.config/tinshell/" .. app .. ".json",`,
    `        ${luaString(`${ROOT}/apps/`)} .. app .. "/config.defaults.json",`,
    `    }`,
    `    for _, p in ipairs(paths) do`,
    `        local f = io.open(p, "r")`,
    `        if f then`,
    `            local s = f:read("*a")`,
    `            f:close()`,
    `            local w = tonumber(s:match('"width"%s*:%s*(%d+)')) or`,
    `                tonumber(s:match('"defaultWidth"%s*:%s*(%d+)'))`,
    `            local h = tonumber(s:match('"height"%s*:%s*(%d+)')) or`,
    `                tonumber(s:match('"defaultHeight"%s*:%s*(%d+)'))`,
    `            if w and h then return w, h end`,
    `        end`,
    `    end`,
    `    return fallbackW, fallbackH`,
    `end`,
  ]
}

/** The header every fragment carries: what generated it, which surface it
 *  describes, and the ordering rule a reader needs to reorder it safely. */ function header(
  set: HyprRuleSet,
  file: string,
): string[] {
  return [
    `-- GENERATED — do not edit.`,
    `--   source:        ${set.identityModule}`,
    `--   render:        scripts/gen-hypr-rules.ts (\`npm run gen:hypr-rules\`)`,
    `--   stale check:   \`npm run check:hypr-rules\``,
    `--`,
    `-- Compositor rules for the ${set.owner} surface.`,
    `--`,
    `-- ORDER: the config requires this directory with a wildcard and Hyprland`,
    `-- requires every match in ascending FILENAME order (byte order — the numeric`,
    `-- prefix is fixed-width, so numeric order is byte order). A window rule's keys`,
    `-- are applied over every earlier match and the LAST match wins, so this`,
    `-- directory must be required AFTER the inline rules in the config: the generic`,
    `-- float-decorations rule sets rounding 12 on every float and the app rules`,
    `-- below override it. The namespaces and app ids below come from the surface's`,
    `-- own identity module, never from a repeated literal.`,
    `--`,
    `-- ${basename(file)}`,
  ]
}

function renderFragment(set: HyprRuleSet, order: number): { name: string; content: string } {
  const name = `${String(order).padStart(3, "0")}-${set.owner}.lua`
  const sizes = new Map<string, { width: number; height: number }>()
  for (const rule of set.window ?? []) {
    if (rule.size) sizes.set(rule.size.app, rule.size.fallback)
  }

  const lines = [...header(set, name), ""]
  if (set.note) lines.push(...commentBlock(set.note), "")
  if (sizes.size > 0) {
    lines.push(...mapSizeReader(), "")
    for (const [app, fallback] of sizes) {
      lines.push(
        `local ${app}W, ${app}H = configMapSize(${luaString(app)}, ${fallback.width}, ${fallback.height})`,
      )
    }
    lines.push("")
  }
  for (const rule of set.layer ?? []) lines.push(renderLayerRule(rule), "")
  let reasonEmitted = false
  for (const rule of set.window ?? []) {
    // A rule that re-asserts the decorations carries the reason the keys exist,
    // once per fragment, right where they are set.
    if (!reasonEmitted && (rule.decorate !== undefined || rule.border_size !== undefined)) {
      lines.push(...commentBlock(DECORATION_REASSERTION_REASON), "")
      reasonEmitted = true
    }
    lines.push(renderWindowRule(rule), "")
  }

  return { name, content: `${lines.join("\n")}` }
}

/** A comment block for a reason a fragment carries: `--` per line, wrapped at the
 *  fragment's own budget so the emitted Lua stays readable. */
function commentBlock(text: string, width = 88): string[] {
  const lines: string[] = []
  let line = "--"
  for (const word of text.split(/\s+/)) {
    if (line !== "--" && line.length + 1 + word.length > width) {
      lines.push(line)
      line = "--"
    }
    line += ` ${word}`
  }
  lines.push(line)
  return lines
}

function placeholderFragment(): { name: string; content: string } {
  return {
    name: PLACEHOLDER,
    content: [
      `-- GENERATED — do not edit.`,
      `--   render:        scripts/gen-hypr-rules.ts (\`npm run gen:hypr-rules\`)`,
      `--   stale check:   \`npm run check:hypr-rules\``,
      `--`,
      `-- The compositor rule directory: one generated Lua fragment per tinshell`,
      `-- surface, required by the config through a wildcard`,
      `-- (\`require("./rules/*.lua")\` — the config loader expands the pattern and`,
      `-- requires every match in sorted order). Nothing here is written by hand: a`,
      `-- rule is defined beside the surface that owns it (\`apps/<app>/hypr-rules.ts\`,`,
      `-- \`common/session-rules.ts\`) and rendered here, because a rule that names a`,
      `-- namespace or an app_id has to name the same constant the surface does.`,
      `--`,
      `-- THIS FILE CARRIES NO RULE. A wildcard require fails when the pattern matches`,
      `-- nothing, so an empty rule directory would be a config error; this file is`,
      `-- what keeps the wildcard matching before the first render. It sorts before`,
      `-- every fragment, and it is regenerated with the rest.`,
      "",
    ].join("\n"),
  }
}

type LoadedSet = { set: HyprRuleSet; order: number; source: string }

async function loadSet(owner: string, file: string): Promise<HyprRuleSet> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: HyprRuleSet }
  if (!mod.default) throw new Error(`${file}: no default export (the rule set)`)
  const set = mod.default
  if (set.owner !== owner)
    throw new Error(`${file}: declares owner "${set.owner}", expected "${owner}"`)
  for (const rule of set.window ?? []) {
    if (!rule.name)
      throw new Error(`${file}: a window rule has no name (name = Hyprland's merge key)`)
  }
  return set
}

async function loadSets(): Promise<LoadedSet[]> {
  const appOwners = readdirSync(APPS).filter((name) => existsSync(join(APPS, name, RULE_FILE)))
  const owners = [
    ...appOwners.map((app) => ({ owner: app, file: join(APPS, app, RULE_FILE) })),
    ...COMMON_RULE_FILES,
  ]

  const missing = owners.filter((o) => ORDER[o.owner] === undefined).map((o) => o.owner)
  if (missing.length)
    throw new Error(`no registration order for: ${missing.join(", ")} — add it to ORDER`)
  const stray = Object.keys(ORDER).filter((owner) => !owners.some((o) => o.owner === owner))
  if (stray.length) throw new Error(`ORDER names an owner with no rule file: ${stray.join(", ")}`)

  const loaded: LoadedSet[] = []
  for (const { owner, file } of owners) {
    loaded.push({ set: await loadSet(owner, file), order: ORDER[owner], source: file })
  }
  return loaded.sort((a, b) => a.order - b.order)
}

/** Write `content` to `file` through a temporary name in the same directory:
 *  flushed, then renamed into place, so a reader only ever sees the old file or
 *  the complete new one. */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  const fd = openSync(tmp, "w")
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

/** Flush a directory entry (the renames above) so the swap survives a crash. */
function syncDir(dir: string): void {
  const fd = openSync(dir, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.includes("-h") || args.includes("--help")) {
    console.log("usage: gen-hypr-rules.ts [--target DIR] [--check]")
    return 0
  }
  const check = args.includes("--check")
  const targetIndex = args.indexOf("--target")
  const target = targetIndex === -1 ? DEFAULT_TARGET : (args[targetIndex + 1] ?? "")
  if (!target) {
    console.error("gen-hypr-rules: --target needs a directory")
    return 1
  }

  const sets = await loadSets()
  const rendered = [...sets.map((s) => renderFragment(s.set, s.order)), placeholderFragment()]
  // A second render of the same rule sets: the fragments are a pure function of
  // the sources, so two renders must be byte-identical (a Map iteration order or
  // a locale-dependent sort would show up here).
  const rerendered = [...sets.map((s) => renderFragment(s.set, s.order)), placeholderFragment()]
  const relative = (name: string) => `rules/${name}`

  if (!check) {
    mkdirSync(target, { recursive: true })

    let written = 0
    let unchanged = 0
    const kept = new Set(rendered.map((f) => f.name))

    for (const fragment of rendered) {
      const file = join(target, fragment.name)
      if (existsSync(file) && safeRead(file) === fragment.content) {
        unchanged++
        console.log(`gen: ${relative(fragment.name)} unchanged`)
        continue
      }
      writeAtomic(file, fragment.content)
      written++
      console.log(`gen: ${relative(fragment.name)}`)
    }

    // A fragment this build no longer produces would keep matching surfaces after
    // a rename or a deletion. The directory is generated, so the generator owns it.
    for (const existing of existsSync(target) ? readdirSync(target) : []) {
      if (!existing.endsWith(".lua") || kept.has(existing)) continue
      rmSync(join(target, existing))
      console.log(`gen: ${relative(existing)} removed`)
    }

    if (written > 0) syncDir(target)
    console.log(
      `gen: hypr rules ok — ${written} written, ${unchanged} unchanged of ${rendered.length} in ${target}`,
    )
    return 0
  }

  // --check. Two things are asked, and they answer for different machines:
  //   1. the RENDER is self-consistent — deterministic, well-formed, and
  //      reproduced byte for byte by the same atomic write the real target uses.
  //      This needs no generated directory, so a clean checkout (CI, a fresh
  //      clone) can run it.
  //   2. the machine's OWN directory is current, when it exists at all. Nothing
  //      generated here is a warning, not a failure: a checkout that has never
  //      run the generator has nothing to be stale.
  const renderProblems = [
    ...(JSON.stringify(rerendered) === JSON.stringify(rendered)
      ? []
      : ["the render is not deterministic — two renders of the same rule sets differ"]),
    ...selfConsistencyProblems(rendered),
    ...checkRenderReproduced(rendered),
  ]
  for (const problem of renderProblems) console.error(`rules render: ${problem}`)

  const localProblems: string[] = []
  if (!existsSync(target)) {
    console.warn(
      `rules local: no rules directory at ${target} — nothing generated on this machine, so the stale comparison is skipped`,
    )
  } else {
    localProblems.push(...localComparisonProblems(target, rendered, relative))
    for (const problem of localProblems) console.error(`rules local: ${problem}`)
  }

  const failures = renderProblems.length + localProblems.length
  if (failures > 0) {
    console.error(`hypr rules: ${failures} problem(s)`)
    return 1
  }
  console.log(
    `check: hypr rules ok — render self-consistent (${rendered.length} fragments)${
      existsSync(target) ? `, local directory current (${target})` : ""
    }`,
  )
  return 0
}

/** Invariants of the rendered set that hold on any machine: the file names the
 *  config's byte-order require depends on, and the shape of a fragment. */
function selfConsistencyProblems(rendered: { name: string; content: string }[]): string[] {
  const problems: string[] = []
  const names = rendered.map((f) => f.name)
  if (new Set(names).size !== names.length) problems.push("two fragments share a file name")
  // The config requires the directory in byte order, so the placeholder has to be
  // the first match and the fragments have to ascend under it.
  if ([...names].sort()[0] !== PLACEHOLDER) problems.push(`${PLACEHOLDER} does not sort first`)
  let previous = ""
  for (const { name, content } of rendered) {
    if (name !== PLACEHOLDER) {
      if (!/^\d{3}-[a-z][a-z0-9-]*\.lua$/.test(name))
        problems.push(`${name}: not <3-digit>-<owner>.lua`)
      if (name <= previous) problems.push(`${name}: does not sort after ${previous}`)
      previous = name
    }
    if (!content.startsWith("-- GENERATED"))
      problems.push(`${name}: no generated marker on the first line`)
    if (!content.endsWith("\n")) problems.push(`${name}: does not end with a newline`)
    if (name === PLACEHOLDER) {
      if (/\bhl\./.test(content)) problems.push(`${name}: the placeholder registers a rule`)
    } else if (!/\bhl\./.test(content)) {
      problems.push(`${name}: registers no rule`)
    }
  }
  return problems
}

/** Write the whole render into a scratch directory through the atomic path and
 *  read it back: the check answers for the writer, in a directory that is
 *  discarded, so it never depends on — or touches — the machine's own. */
function checkRenderReproduced(rendered: { name: string; content: string }[]): string[] {
  const problems: string[] = []
  const scratch = mkdtempSync(join(tmpdir(), "tinshell-hypr-rules-"))
  try {
    for (const fragment of rendered) writeAtomic(join(scratch, fragment.name), fragment.content)
    syncDir(scratch)
    for (const fragment of rendered) {
      const readBack = safeRead(join(scratch, fragment.name))
      if (readBack !== fragment.content)
        problems.push(`${fragment.name}: the atomic write did not reproduce the render`)
    }
    const extra = readdirSync(scratch).filter((f) => !rendered.some((r) => r.name === f))
    for (const name of extra) problems.push(`${name}: the write left a file behind`)
    console.log(
      `rules render: ${rendered.length} fragments written to ${scratch} and read back identical`,
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return problems
}

/** The machine-local half: a fragment that is missing, stale, or present without
 *  a rule set behind it. */
function localComparisonProblems(
  target: string,
  rendered: { name: string; content: string }[],
  relative: (name: string) => string,
): string[] {
  const problems: string[] = []
  const kept = new Set(rendered.map((f) => f.name))
  for (const fragment of rendered) {
    const onDisk = safeRead(join(target, fragment.name))
    if (onDisk === fragment.content) continue
    problems.push(
      `${relative(fragment.name)}: ${onDisk === null ? "missing" : "stale"} — run \`npm run gen:hypr-rules\``,
    )
  }
  for (const existing of readdirSync(target)) {
    if (!existing.endsWith(".lua") || kept.has(existing)) continue
    problems.push(
      `${relative(existing)}: not generated by this build — remove it or add its rule set`,
    )
  }
  return problems
}

/** The bytes on disk, or null when the file is absent or unreadable. */
function safeRead(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

process.exit(await main())
