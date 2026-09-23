/**
 * audit-dead-code — repeatable dead-code / dead-reference / redundancy audit
 * for the TINSHELL multi-app home.
 *
 * Usage:
 *   node --experimental-strip-types scripts/audit-dead-code.ts [flags]
 *
 * Flags:
 *   --json            emit JSON Lines instead of tab-separated rows
 *   --all-exports     also emit every exported symbol with its reference count
 *   --only=a,b        keep only finding kinds whose name starts with a or b
 *   --summary         print only the per-kind count table
 *   --help            this text
 *
 * Output: one finding per line. Tab-separated columns:
 *   kind <TAB> file:line <TAB> symbol <TAB> confidence <TAB> evidence
 * Confidence is CERTAIN | LIKELY | JUDGEMENT — the tool's own estimate, not a
 * verdict; a caller must still confirm before deleting anything.
 *
 * What it checks
 *   export-unreferenced        exported symbol with no reference in another file
 *   export-symbol              (--all-exports) every export + reference count
 *   module-no-importer         source file no other file imports
 *   import-unresolved          project-internal specifier that resolves to nothing
 *   config-key-unread          defaults key with no reader in the owning app or common/
 *   command-undocumented       registered command path absent from its AGENTS.md
 *   command-doc-only           documented command path with no registration
 *   app-name-missing           app present in one hosting source, absent from another
 *   css-class-undefined        class string used in code, defined by no stylesheet
 *   css-rule-unused            stylesheet class no code string mentions
 *   doc-stale-ref              path-like reference in a comment/doc that does not exist
 *   duplicate-impl             two functions with an identical structural shape
 *   primitive-site             a site matching a known primitive pattern (redundancy input)
 *   literal-duplicated         one literal value spelled out in four or more files
 *   palette-role-drift         two apps' shipped palette defaults differ for one role
 *   convention-*               root-AGENTS.md rule violations
 *   facade-suspect             module whose body is only re-exports (facade pattern)
 *
 * Analysis engine: the TypeScript compiler API, loaded from the repo's own
 * devDependency (no new dependency). knip is not installed, and a resolving
 * type-checker gives exact module/symbol answers where regex passes guess.
 *
 * Known false positives / blind spots (honesty contract)
 *   - Exports consumed through a dynamic property access (`m[entry.mount]`) or a
 *     runtime string path read as unreferenced. Entry-point contracts
 *     (apps/<app>/app.ts, apps/<app>/mount.ts, probes, config.schema.ts,
 *     common/host/entry.ts) are therefore excluded from export-unreferenced.
 *   - A module reached only through a runtime string, a lazy indirection or
 *     common/host/registry.ts may read as module-no-importer. registry.ts uses
 *     literal dynamic imports, which this tool DOES follow, so that case is
 *     covered; other indirections are not.
 *   - config-key-unread searches the key's own name, so a key whose name
 *     collides with an unrelated identifier or a CSS property reads as used
 *     (false negative). It never invents a reader.
 *   - css-class-undefined misses classes composed at runtime from config; treat
 *     every hit as a question. css-rule-unused cannot see GTK state selectors
 *     applied by widget code and over-reports.
 *   - doc-stale-ref only sees path-like tokens that carry a directory prefix;
 *     a bare `foo.ts` mention is ignored.
 *   - duplicate-impl compares AST node-kind sequences, so two functions with the
 *     same control shape but different names collide by design — that is the
 *     point (rename-only copies), and it also groups genuinely generic helpers.
 *   - literal-duplicated compares literal TEXT in a fixed corpus: string literals
 *     in value position in .ts/.tsx, declaration values in .css, and leaf strings
 *     in apps/<app>/config.{defaults,}.json. It is blind to a value the corpus
 *     never holds — a shell script, a markdown file, a systemd unit, a probe
 *     fixture (excluded: probes carry test data by design), a numeric literal, a
 *     value assembled at runtime or read from config. It compares exact text
 *     after whitespace normalization, so `#fff` and `#ffffff`, or `0.1` and
 *     `0.10`, are different values to it. Two files can also agree on a value by
 *     coincidence (an app's own layout choice that another app happens to
 *     share), so every hit is a candidate for a token or a shared owner, never a
 *     verdict — and LITERAL_ALLOWLIST below is where a deliberate repeat is
 *     recorded rather than silenced class-wide. An allowlist entry names files
 *     and may use `*` for one path segment, so a palette value that lives in
 *     every app's config trio is written as `apps/<app>/config.defaults.json`.
 *   - palette-role-drift compares only the keys PALETTE_ROLES names, and only in
 *     apps/<app>/config.defaults.json: that file is the SHIPPED design value,
 *     while a live config.json is the user's own per-app choice and is
 *     deliberately not compared. A key absent from an app drops out of its role
 *     silently, and a key that merely shares a NAME with a role but carries
 *     another role is left out of the map on purpose (notes' selectionColour is
 *     a text-selection fill, launcher's an emoji grid cell) — mapping it would
 *     couple two unrelated decisions and fire on a difference that is not drift.
 *     Values compare after case folding and trailing-zero normalisation, so
 *     `#8AB5F7` and `#8ab5f7` are one value reported separately as two
 *     spellings, while a hex and the equivalent rgba() stay two values.
 *   - literal-duplicated keys a bare CSS length by its value alone, so such a hit
 *     can pair different properties (`12px` as `min-width` in one sheet and
 *     `font-size` in another): it names a candidate rung of the size ladder, not
 *     one role. Declaration values that read a token (`var(--tinshell-*)`) are skipped
 *     — a site that was tokenized stops being a literal site at all.
 *   - convention-* checks are textual and conservative; they report candidates.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const APPS_DIR = join(ROOT, "apps")
const COMMON_DIR = join(ROOT, "common")

type Confidence = "CERTAIN" | "LIKELY" | "JUDGEMENT"

interface Finding {
  kind: string
  file: string
  line: number
  symbol: string
  confidence: Confidence
  evidence: string
}

const findings: Finding[] = []
function add(
  kind: string,
  file: string,
  line: number,
  symbol: string,
  confidence: Confidence,
  evidence: string,
): void {
  findings.push({ kind, file, line, symbol, confidence, evidence })
}

const rel = (p: string): string => relative(ROOT, p)

// ── CLI ──
const args = process.argv.slice(2)
if (args.includes("--help")) {
  const header = readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]
  console.log(header.replace(/^\/\*\*?/, "").replace(/^ ?\* ?/gm, ""))
  process.exit(0)
}
const asJson = args.includes("--json")
const allExports = args.includes("--all-exports")
const summaryOnly = args.includes("--summary")
const onlyArg = args.find((a) => a.startsWith("--only="))
const only = onlyArg ? onlyArg.slice("--only=".length).split(",").filter(Boolean) : []
const keep = (kind: string): boolean =>
  only.length === 0 ||
  only.some((p) => kind === p || kind.startsWith(`${p}-`) || kind.startsWith(p))

// ── TypeScript program ──
const started = Date.now()
const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json")
if (!configPath) {
  console.error(`no tsconfig.json found from ${ROOT}`)
  process.exit(2)
}
const cfg = ts.readConfigFile(configPath, ts.sys.readFile)
if (cfg.error) {
  console.error(ts.flattenDiagnosticMessageText(cfg.error.messageText, "\n"))
  process.exit(2)
}
const parsed = ts.parseJsonConfigFileContent(
  cfg.config,
  ts.sys,
  dirname(configPath),
  {},
  configPath,
)
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
const checker = program.getTypeChecker()

const isProjectPath = (p: string): boolean =>
  (p.startsWith(`${APPS_DIR}/`) || p.startsWith(`${COMMON_DIR}/`)) && !p.includes("/node_modules/")
const projectFiles = program
  .getSourceFiles()
  .filter((sf) => !sf.isDeclarationFile && isProjectPath(sf.fileName))

function lineAt(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

/** Files whose exports are consumed through a runtime seam, not a static
 *  reference. Excluded from export-unreferenced (still checked for importers). */
function isEntryPoint(fileName: string): boolean {
  const p = fileName
  return (
    /\/apps\/[^/]+\/(app|mount)\.ts$/.test(p) ||
    /\.probe\.ts$/.test(p) ||
    /\/common\/host\/(entry|registry)\.ts$/.test(p) ||
    /\/config\.schema\.ts$/.test(p)
  )
}

// ── Import graph + unresolved specifiers ──
const importers = new Map<string, number>()
const unresolvedFindings: Finding[] = []
function recordImport(spec: string, from: string, line: number): void {
  const inProjectSpec =
    spec.startsWith(".") || spec.startsWith("@common/") || spec.startsWith("@apps/")
  if (!inProjectSpec) return
  if (spec.endsWith(".css")) return
  const r = ts.resolveModuleName(spec, from, parsed.options, ts.sys).resolvedModule
  if (r) {
    importers.set(r.resolvedFileName, (importers.get(r.resolvedFileName) ?? 0) + 1)
    return
  }
  unresolvedFindings.push({
    kind: "import-unresolved",
    file: rel(from),
    line,
    symbol: spec,
    confidence: "CERTAIN",
    evidence: "resolveModuleName returned no result",
  })
}

for (const sf of projectFiles) {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier
      if (spec && ts.isStringLiteral(spec)) {
        recordImport(spec.text, sf.fileName, lineAt(sf, spec))
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const arg = node.arguments[0]
      recordImport(arg.text, sf.fileName, lineAt(sf, arg))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

for (const f of unresolvedFindings) if (keep(f.kind)) findings.push(f)

// ── Zero-importer modules ──
for (const sf of projectFiles) {
  if (isEntryPoint(sf.fileName)) continue
  if (!importers.has(sf.fileName)) {
    add(
      "module-no-importer",
      rel(sf.fileName),
      1,
      "",
      "LIKELY",
      "no project file resolves an import to this module",
    )
  }
}

// ── Symbol reference counts ──
const refCount = new Map<ts.Symbol, number>()
const refFiles = new Map<ts.Symbol, Set<string>>()
function noteRef(sym: ts.Symbol, file: string): void {
  refCount.set(sym, (refCount.get(sym) ?? 0) + 1)
  let set = refFiles.get(sym)
  if (!set) {
    set = new Set()
    refFiles.set(sym, set)
  }
  set.add(file)
}
for (const sf of projectFiles) {
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      let sym = checker.getSymbolAtLocation(node)
      if (sym && sym.flags & ts.SymbolFlags.Alias) {
        try {
          sym = checker.getAliasedSymbol(sym)
        } catch {
          /* leave the alias symbol */
        }
      }
      if (sym) noteRef(sym, sf.fileName)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

for (const sf of projectFiles) {
  const modSym = checker.getSymbolAtLocation(sf) ?? (sf as unknown as { symbol?: ts.Symbol }).symbol
  if (!modSym) continue
  let exportsList: ts.Symbol[] = []
  try {
    exportsList = checker.getExportsOfModule(modSym)
  } catch {
    continue
  }
  for (const exp of exportsList) {
    const name = exp.getName()
    const decl = exp.valueDeclaration ?? exp.declarations?.[0]
    const declFile = decl?.getSourceFile().fileName ?? sf.fileName
    const line = decl && decl.getSourceFile() === sf ? lineAt(sf, decl) : 1
    const files = refFiles.get(exp) ?? new Set<string>()
    const external = [...files].filter((f) => f !== declFile).length
    const total = refCount.get(exp) ?? 0
    if (allExports) {
      add(
        "export-symbol",
        rel(sf.fileName),
        line,
        name,
        "CERTAIN",
        `external=${external} total=${total}`,
      )
    }
    if (external === 0 && !isEntryPoint(sf.fileName)) {
      add(
        "export-unreferenced",
        rel(sf.fileName),
        line,
        name,
        total <= 1 ? "CERTAIN" : "LIKELY",
        total <= 1
          ? `external=0 total=${total} — no reference at all outside its declaration`
          : `external=0 total=${total} — used only inside its own file`,
      )
    }
  }
}

// ── Config keys ──
function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return prefix ? [prefix] : []
  const out: string[] = []
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out.push(...leafPaths(v, prefix ? `${prefix}.${k}` : k))
  }
  return out
}

function readProjectText(scopePrefixes: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const sf of projectFiles) {
    if (!/\.(ts|tsx)$/.test(sf.fileName)) continue
    if (!scopePrefixes.some((p) => sf.fileName.startsWith(p))) continue
    out.set(sf.fileName, sf.text)
  }
  return out
}

const appsDirs = readdirSync(APPS_DIR).filter((d) => statSync(join(APPS_DIR, d)).isDirectory())
for (const app of appsDirs) {
  const defsPath = join(APPS_DIR, app, "config.defaults.json")
  if (!existsSync(defsPath)) continue
  let defs: unknown
  try {
    defs = JSON.parse(readFileSync(defsPath, "utf8"))
  } catch {
    continue
  }
  const scope = [join(APPS_DIR, app), `${COMMON_DIR}/`]
  const texts = readProjectText(scope)
  for (const path of leafPaths(defs)) {
    const key = path.split(".").pop() ?? path
    if (!key) continue
    const dotted = new RegExp(`\\b${path.replace(/\./g, "\\.")}\\b`)
    const bare = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
    let used = false
    for (const [file, text] of texts) {
      if (/(^|\/)config\.(schema\.ts|json|defaults\.json)$/.test(file)) continue
      if (dotted.test(text) || bare.test(text)) {
        used = true
        break
      }
    }
    if (!used) {
      add(
        "config-key-unread",
        rel(defsPath),
        1,
        path,
        "LIKELY",
        `no reader for '${path}' (key '${key}') in ${rel(join(APPS_DIR, app))} or common/`,
      )
    }
  }
}

// ── Command paths vs AGENTS.md ──
interface CommandPath {
  app: string
  path: string[]
  file: string
  line: number
}
const registered: CommandPath[] = []
for (const sf of projectFiles) {
  const re = /(?:register|ensureNamespace)\(\s*\[([^\]]*)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sf.text)) !== null) {
    const strs = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1])
    if (strs.length === 0) continue
    registered.push({
      app: strs[0],
      path: strs,
      file: rel(sf.fileName),
      line: sf.getLineAndCharacterOfPosition(m.index).line + 1,
    })
  }
}
const registeredByApp = new Map<string, Set<string>>()
for (const c of registered) {
  let set = registeredByApp.get(c.app)
  if (!set) {
    set = new Set()
    registeredByApp.set(c.app, set)
  }
  set.add(c.path.slice(1).join(" "))
}
for (const app of appsDirs) {
  const agentsPath = join(APPS_DIR, app, "AGENTS.md")
  if (!existsSync(agentsPath)) continue
  const doc = readFileSync(agentsPath, "utf8")
  // A documented command is written in a code span (`app cmd`) or inside a
  // request string ("app cmd ...") — bare prose after the app name is not a
  // command, so only those two shapes count.
  const esc = app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const docTokens = new Set<string>()
  for (const src of [`\`${esc}\\s+([a-z][a-z0-9-]*)`, `"${esc}\\s+([a-z][a-z0-9-]*)`]) {
    const re = new RegExp(src, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(doc)) !== null) docTokens.add(m[1])
  }
  const reg = registeredByApp.get(app) ?? new Set<string>()
  const regTokens = new Set([...reg].map((p) => p.split(" ")[0]).filter(Boolean))
  for (const tok of regTokens) {
    if (!docTokens.has(tok)) {
      add(
        "command-undocumented",
        rel(agentsPath),
        1,
        `${app} ${tok}`,
        "JUDGEMENT",
        `registered '${app} ${tok}' not matched in the app spec`,
      )
    }
  }
  for (const tok of docTokens) {
    if (!regTokens.has(tok)) {
      add(
        "command-doc-only",
        rel(agentsPath),
        1,
        `${app} ${tok}`,
        "JUDGEMENT",
        `documented '${app} ${tok}' has no register() path`,
      )
    }
  }
}

// ── App name agreement ──
const dirApps = appsDirs.filter((a) => a !== "greeter")
const manifest = JSON.parse(readFileSync(join(ROOT, "common/shell/apps.json"), "utf8")) as Record<
  string,
  unknown
>
const manifestApps = Object.keys(manifest).filter((k) => !k.startsWith("$"))
const registryText = readFileSync(join(COMMON_DIR, "host/registry.ts"), "utf8")
const registryApps = [...registryText.matchAll(/^\s{2}([a-z][a-z0-9]*):\s*\{\s*\n\s*mod:/gm)].map(
  (m) => m[1],
)
const routeMapPath = join(ROOT, "common/shell/route-map.conf")
const routeApps = existsSync(routeMapPath)
  ? readFileSync(routeMapPath, "utf8")
      .split("\n")
      .filter((l) => /^[a-z][a-z0-9]*=/.test(l))
      .map((l) => l.split("=")[0])
  : []
const systemdDir = join(ROOT, "systemd")
const unitFiles = existsSync(systemdDir)
  ? readdirSync(systemdDir).filter((f) => f.endsWith(".service"))
  : []
const systemdApps = new Set<string>()
for (const f of unitFiles) {
  const m = /^tinshell-([a-z][a-z0-9]*)\.service$/.exec(f)
  if (m && m[1] !== "shell" && m[1] !== "warm") systemdApps.add(m[1])
}
for (const v of Object.values(manifest)) {
  const unit = (v as { unit?: string })?.unit
  const m = unit ? /^tinshell-([a-z]+)\.service$/.exec(unit) : null
  if (m) systemdApps.add(m[1])
}

const sources: Array<[string, Set<string>]> = [
  ["apps/", new Set(dirApps)],
  ["common/shell/apps.json", new Set(manifestApps)],
  ["common/host/registry.ts", new Set(registryApps)],
  ["common/shell/route-map.conf", new Set(routeApps)],
]
const union = new Set<string>()
for (const [, set] of sources) for (const a of set) union.add(a)
for (const app of union) {
  const missing = sources.filter(([, set]) => !set.has(app)).map(([name]) => name)
  if (missing.length > 0) {
    add(
      "app-name-missing",
      "common/shell/apps.json",
      1,
      app,
      "CERTAIN",
      `absent from: ${missing.join(", ")}`,
    )
  }
}
for (const a of systemdApps) {
  if (!dirApps.includes(a)) {
    add(
      "app-name-missing",
      "systemd/",
      1,
      a,
      "CERTAIN",
      `systemd unit references app '${a}' with no apps/${a}/ directory`,
    )
  }
}

// ── CSS class usage vs definitions ──
const usedClasses = new Map<string, string[]>()
function noteClass(cls: string, where: string): void {
  for (const c of cls.split(/\s+/).filter(Boolean)) {
    const arr = usedClasses.get(c) ?? []
    arr.push(where)
    usedClasses.set(c, arr)
  }
}
for (const sf of projectFiles) {
  if (!/\.(ts|tsx)$/.test(sf.fileName)) continue
  const text = sf.text
  for (const m of text.matchAll(/\bclass="([^"]*)"/g)) noteClass(m[1], rel(sf.fileName))
  for (const m of text.matchAll(/\bclass=\{"([^"]*)"\}/g)) noteClass(m[1], rel(sf.fileName))
  for (const m of text.matchAll(/\bclass=\{`([^`]*)`\}/g)) {
    if (!m[1].includes("${")) noteClass(m[1], rel(sf.fileName))
  }
  for (const m of text.matchAll(/\bcssClasses=\{\[([^\]]*)\]\}/g)) {
    for (const s of m[1].matchAll(/["'`]([^"'`]+)["'`]/g)) noteClass(s[1], rel(sf.fileName))
  }
  for (const m of text.matchAll(/add_css_class\(\s*["']([^"']+)["']/g))
    noteClass(m[1], rel(sf.fileName))
}
const definedClasses = new Set<string>()
const definedInCss = new Set<string>()
function walkCss(dir: string): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walkCss(full)
    else if (extname(entry) === ".css") {
      const text = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
      for (const m of text.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
        definedClasses.add(m[1])
        definedInCss.add(m[1])
      }
    }
  }
}
walkCss(APPS_DIR)
walkCss(COMMON_DIR)
// Stylesheets embedded in TS/TSX (card-theme/card-chrome/app-css emit CSS
// strings): a class selector preceded by start/whitespace/`,`/`;`/`{`/`}`/`>`
// defines it. The lead-in guard avoids matching ordinary property accesses
// (`foo.bar`), at the cost of a few false DEFINITIONS from line-broken method
// chains (`.then(`) — which only ever under-reports undefined classes.
for (const sf of projectFiles) {
  if (!/\.(ts|tsx)$/.test(sf.fileName)) continue
  for (const m of sf.text.matchAll(/(?:^|[\s,;{}>&])\.([A-Za-z_][A-Za-z0-9_-]*)/gm))
    definedClasses.add(m[1])
}
for (const [cls, where] of usedClasses) {
  if (!definedClasses.has(cls)) {
    add(
      "css-class-undefined",
      where[0],
      1,
      cls,
      "JUDGEMENT",
      `class '${cls}' used in ${where.length} site(s), defined by no .css rule`,
    )
  }
}
// The unused-rule side reports only classes declared in real .css files —
// TS-embedded selectors are scanned for the defined side of undefined-class
// detection, but the broadened lead-in guard can mint junk names (`.then`),
// which must not surface as dead stylesheet rules.
for (const cls of definedInCss) {
  if (!usedClasses.has(cls)) {
    add(
      "css-rule-unused",
      "apps",
      1,
      cls,
      "JUDGEMENT",
      `stylesheet class '${cls}' is never used as a code string`,
    )
  }
}

// ── Stale path references in comments and docs ──
const PATH_REF =
  /(?:@common|@apps|common|apps|scripts|systemd)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|css|json|sh)/g
function refExists(ref: string): boolean {
  const base = ref.replace(/^@/, "")
  // XDG runtime state paths are written in the same apps/<app>/state.json
  // shape but live under the state dir, not the repo.
  if (/(^|\/)apps\/[^/]+\/state\.json$/.test(base)) return true
  const candidates = new Set<string>([base, `${base}/index.ts`, `${base}/index.tsx`])
  const ext = extname(base)
  if (ext) {
    const stem = base.slice(0, -ext.length)
    for (const e of [".ts", ".tsx", ".css", ".json", ".sh"]) candidates.add(stem + e)
  } else {
    for (const e of [".ts", ".tsx", ".css", ".json", ".sh"]) candidates.add(base + e)
  }
  return [...candidates].some((c) => existsSync(resolve(ROOT, c)))
}
function scanRefs(file: string, text: string, commentOnly: boolean): void {
  for (const m of text.matchAll(PATH_REF)) {
    const ref = m[0]
    if (/\$|<|>|\*/.test(ref)) continue
    if (refExists(ref)) continue
    const idx = m.index ?? 0
    if (commentOnly) {
      const lineStart = text.lastIndexOf("\n", idx) + 1
      const lineEnd = text.indexOf("\n", idx)
      const lineText = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      if (!/\/\/|\/\*|\*/.test(lineText)) continue
    }
    add(
      "doc-stale-ref",
      file,
      text.slice(0, idx).split("\n").length,
      ref,
      "LIKELY",
      "referenced path does not exist on disk",
    )
  }
}
for (const sf of projectFiles) scanRefs(rel(sf.fileName), sf.text, true)
function collectFiles(dir: string, out: string[], match: (entry: string) => boolean): void {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".git" ||
      entry === "dist" ||
      entry === ".pi-subagents"
    )
      continue
    const full = join(dir, entry)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) collectFiles(full, out, match)
    else if (match(entry)) out.push(full)
  }
}
const mdFiles: string[] = []
collectFiles(ROOT, mdFiles, (e) => e.endsWith(".md"))
for (const md of mdFiles) scanRefs(rel(md), readFileSync(md, "utf8"), false)

// ── Duplicate implementations (structural shape) ──
interface FnShape {
  file: string
  line: number
  name: string
  tokens: number
  hash: string
  text: string
}
function shapeHash(fn: ts.Node): { tokens: number; hash: string } {
  const parts: number[] = []
  const walk = (node: ts.Node): void => {
    parts.push(node.kind)
    if (ts.isIdentifier(node)) return
    if (ts.isPrivateIdentifier(node)) return
    if (
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(fn)
  return { tokens: parts.length, hash: parts.join(",") }
}
const shapes = new Map<string, FnShape[]>()
function noteFn(node: ts.SignatureDeclaration, sf: ts.SourceFile): void {
  const body = (node as ts.FunctionLikeDeclaration).body
  if (!body || !ts.isBlock(body)) return
  const { tokens, hash } = shapeHash(body)
  if (tokens < 40) return
  const declName = (node as ts.NamedDeclaration).name
  const name = declName && ts.isIdentifier(declName) ? declName.text : "<anonymous>"
  const arr = shapes.get(hash) ?? []
  arr.push({
    file: rel(sf.fileName),
    line: lineAt(sf, node),
    name,
    tokens,
    hash,
    text: node.getText(sf).split("\n")[0].slice(0, 100),
  })
  shapes.set(hash, arr)
}
for (const sf of projectFiles) {
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      noteFn(node, sf)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
for (const [, group] of shapes) {
  const files = new Set(group.map((g) => g.file))
  if (files.size < 2) continue
  for (const g of group) {
    add(
      "duplicate-impl",
      g.file,
      g.line,
      g.name,
      "JUDGEMENT",
      `shape ${g.hash.slice(0, 12)}… ${g.tokens} tokens shared by ${group.length} functions in ${files.size} files`,
    )
  }
}

// ── Value-level duplication (one literal several files spell out) ──
/** A value, not a name: it carries at least one character no identifier can, so
 *  `#8ab5f7`, `rgba(…)`, `6px 12px` and `JetBrainsMono Nerd Font` qualify while
 *  `appearance`, `dock`, `io.Astal.shell`, `key-pressed` and `drag-end` do not —
 *  those are names from an external vocabulary (a protocol, a signal, a config
 *  key) that no token can own. */
const IDENTIFIER_LIKE = /^[A-Za-z][A-Za-z0-9_.:-]*$/
/** GVariant signatures (`(ss)`) and `signal::detail` names are protocol
 *  vocabulary spelled out at every call site by necessity. */
const GVARIANT_SIGNATURE = /^\(?[a-z()]*\)?$/
const SIGNAL_WITH_DETAIL = /^[a-z][a-z0-9-]*(::[a-z][a-z0-9-]*)+$/
/** A `${…}` placeholder is a substitution key, not a value. */
const PLACEHOLDER_TOKEN = /^\$\{.*\}$/
/** GTK reset language: a shared ABSENCE of a value is not a shared value. */
const CSS_RESET_VALUES = new Set([
  "none",
  "auto",
  "transparent",
  "initial",
  "inherit",
  "unset",
  "revert",
  "0",
  "0px",
  "default",
])
/** Four files or more independently spelling one value is the point at which a
 *  token (or a named owner) is owed rather than a literal. */
const LITERAL_MIN_FILES = 4
/** Deliberate repeats: a value that genuinely belongs in several files. Each
 *  entry names the files allowed to carry it — a site anywhere else is reported
 *  as usual, so the entry documents an owner instead of silencing the value. */
const LITERAL_ALLOWLIST: Array<{ value: string; files: string[]; why: string }> = [
  {
    value: "JetBrainsMono Nerd Font",
    files: [
      "common/shell/theme.css",
      "common/css/tokens.ts",
      "apps/dock/config.defaults.json",
      "apps/dock/config.json",
    ],
    why: "one font identity with four carriers: the --tinshell-font-family token, the TS half of the same token (a Cairo painter cannot read CSS), and the dock's shipped + live config data (fonts.family is the user-facing setting)",
  },
  {
    value: "#e6e6e6",
    files: [
      "common/shell/theme.css",
      "common/css/tokens.ts",
      "apps/*/config.defaults.json",
      "apps/*/config.json",
    ],
    why: "one palette role (the suite ink) with three carriers: the --tinshell-ink token, the TS half of the same token, and each app's OWN config trio — the shipped default and the user's live file are real data (per-app config ownership), and palette-role-drift is what holds those defaults to one value per role",
  },
  {
    value: "#a6a6a6",
    files: [
      "common/shell/theme.css",
      "common/css/tokens.ts",
      "apps/*/config.defaults.json",
      "apps/*/config.json",
    ],
    why: "same shape as the ink role: the --tinshell-ink-muted token, its TS half, and the per-app palette data that palette-role-drift guards",
  },
  {
    value: "#8ab5f7",
    files: [
      "common/shell/theme.css",
      "common/css/tokens.ts",
      "apps/*/config.defaults.json",
      "apps/*/config.json",
    ],
    why: "the accent role: the --tinshell-accent token, its TS half, and the per-app palette data; annotate's tools.colours list starts on the accent and is data the user edits",
  },
  {
    value: "rgba(255, 255, 255, 0.10)",
    files: [
      "common/shell/theme.css",
      "apps/clipboard/style.ts",
      "apps/launcher/emoji-style.ts",
      "apps/notifications/style.ts",
      "apps/*/config.defaults.json",
      "apps/*/config.json",
    ],
    why: "the picker rows' wash: the --tinshell-wash token where a stylesheet paints it, each app's config trio where config does, and the code fallback of that config key (the app's own style.ts) — a palette value's carriers, not a stray literal",
  },
  {
    value: "rgba(255, 255, 255, 0.08)",
    files: [
      "apps/notifications/style.ts",
      "apps/portal/style.css",
      "apps/*/config.defaults.json",
      "apps/*/config.json",
    ],
    why: "a palette role with no token yet (the card rows' hover wash and the notification action's resting fill) in the per-app config trio, plus the two sites that own the value in code: notifications' actionBg fallback, and portal's paned separator (the same rung of the wash ladder on a control seam, its own role)",
  },
  {
    value: "rgba(138, 181, 247, 0.35)",
    files: ["apps/*/config.defaults.json", "apps/*/config.json"],
    why: "the card rows' selection tint — a palette role with no token yet, carried by the per-app config trio (palette-role-drift guards agreement)",
  },
  {
    value: "#0a0c11",
    files: ["apps/*/config.defaults.json", "apps/*/config.json"],
    why: "the panel base role in the per-app config trio; common/media/pane.tsx's own fallback for an unparsable colour is deliberately NOT allowed — the report naming it is the worklist line for a token there",
  },
  {
    value: "rgba(255, 255, 255, 0.18)",
    files: [
      "apps/notifications/style.ts",
      "apps/notifications/style.css",
      "apps/notifications/config.defaults.json",
      "apps/notifications/config.json",
    ],
    why: "one app's own value with its full carrier set: the notification close control's hover fill lives in that app's stylesheet (static), its style.ts fallback and its config trio — no second app reads it, so there is no role to share",
  },
]
/** A `*` matches one path segment, so a palette value can allowlist every app's
 *  config trio without naming every app. */
function allowlistAllows(files: string[], file: string): boolean {
  return files.some((pattern) => {
    if (!pattern.includes("*")) return pattern === file
    const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    return new RegExp(`^${escaped.join("[^/]*")}$`).test(file)
  })
}
function isValueShaped(value: string): boolean {
  return (
    value.length >= 3 &&
    /[A-Za-z0-9]/.test(value) &&
    !IDENTIFIER_LIKE.test(value) &&
    !GVARIANT_SIGNATURE.test(value) &&
    !SIGNAL_WITH_DETAIL.test(value) &&
    !PLACEHOLDER_TOKEN.test(value)
  )
}
const literalSites = new Map<string, Array<{ file: string; line: number }>>()
function noteLiteral(raw: string, file: string, line: number): void {
  const value = raw.replace(/\s+/g, " ").trim()
  if (!isValueShaped(value)) return
  const sites = literalSites.get(value) ?? []
  sites.push({ file, line })
  literalSites.set(value, sites)
}
for (const sf of projectFiles) {
  // Probe fixtures are test data by design — a probe and its subject repeating
  // a literal is the probe working, not a value needing an owner.
  if (/\.probe\.(ts|tsx)$/.test(sf.fileName)) continue
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent
      const isKey =
        parent !== undefined &&
        (ts.isPropertyAssignment(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isEnumMember(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isSetAccessorDeclaration(parent)) &&
        (parent as ts.NamedDeclaration).name === node
      const isSpecifier =
        parent !== undefined &&
        ((ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) ||
          (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) ||
          (ts.isModuleDeclaration(parent) && parent.name === node))
      const isKeyedAccess =
        parent !== undefined &&
        ts.isElementAccessExpression(parent) &&
        parent.argumentExpression === node
      const isTypeOnly = parent !== undefined && ts.isLiteralTypeNode(parent)
      if (!isKey && !isSpecifier && !isKeyedAccess && !isTypeOnly) {
        noteLiteral(node.text, rel(sf.fileName), lineAt(sf, node))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
const cssFiles: string[] = []
collectFiles(APPS_DIR, cssFiles, (e) => extname(e) === ".css")
collectFiles(COMMON_DIR, cssFiles, (e) => extname(e) === ".css")
for (const cssFile of cssFiles) {
  const text = readFileSync(cssFile, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
  for (const m of text.matchAll(/[a-z-]+\s*:\s*([^;{}]+);/g)) {
    const value = m[1].trim()
    if (CSS_RESET_VALUES.has(value) || value.startsWith("var(")) continue
    noteLiteral(value, rel(cssFile), text.slice(0, m.index).split("\n").length)
  }
}
const dataFiles: string[] = []
collectFiles(APPS_DIR, dataFiles, (e) => /^config(\.defaults)?\.json$/.test(e))
for (const dataFile of dataFiles) {
  const text = readFileSync(dataFile, "utf8")
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"(\s*:)?/g)) {
    if (m[2]) continue // a JSON key, not a value
    let value: string
    try {
      value = JSON.parse(`"${m[1]}"`)
    } catch {
      continue
    }
    noteLiteral(value, rel(dataFile), text.slice(0, m.index).split("\n").length)
  }
}
for (const [value, sites] of literalSites) {
  const files = [...new Set(sites.map((s) => s.file))]
  if (files.length < LITERAL_MIN_FILES) continue
  const allowed = LITERAL_ALLOWLIST.find((e) => e.value === value)?.files ?? []
  const outside = sites.find((s) => !allowlistAllows(allowed, s.file))
  if (!outside) continue
  const outsideFiles = files.filter((f) => !allowlistAllows(allowed, f))
  add(
    "literal-duplicated",
    outside.file,
    outside.line,
    value,
    "JUDGEMENT",
    `${files.length} files spell this value (${outsideFiles.length} outside the allowlist): ${
      outsideFiles.slice(0, 8).join(", ") +
      (outsideFiles.length > 8 ? `, +${outsideFiles.length - 8} more` : "")
    }`,
  )
}

// ── Palette role drift (one role, several apps' shipped default) ──
/** The suite palette is per-app DATA: each app owns its config trio, the user
 *  overrides the values, and nothing generates them. What must not drift is the
 *  ROLE — two apps shipping a different value for one role means one of them is
 *  out of step and the surfaces stop matching. Each entry names the role and
 *  every `<app>:<dotted key path>` that carries it in
 *  `apps/<app>/config.defaults.json` (the SHIPPED default; a live `config.json`
 *  is the user's own per-app choice and is deliberately not compared).
 *
 *  A key ABSENT from an app drops silently out of its role — renaming a key
 *  therefore removes it from the guard without a word, which is this class's
 *  main blind spot. A key that merely shares a NAME with a role but means
 *  something else is left out of the map entirely (notes' `selectionColour` is a
 *  text-selection fill, launcher's is an emoji grid cell tint, neither is a
 *  row): listing it would couple two unrelated decisions and fire on a
 *  difference that is not drift. */
interface PaletteRole {
  role: string
  why: string
  keys: string[]
}
const PALETTE_ROLES: PaletteRole[] = [
  {
    role: "accent",
    why: "the suite accent — caret, entry icon, active control, the emoji section's label ink, annotate's starting pen colour",
    keys: [
      "files:appearance.accentColour",
      "notes:appearance.caretColour",
      "media:appearance.accentColour",
      "annotate:appearance.accentColour",
      "portal:appearance.accentColour",
      "notifications:appearance.accent",
      "clipboard:appearance.accent",
      "launcher:appearance.accentColour",
    ],
  },
  {
    role: "ink",
    why: "primary text ink on every card and picker",
    keys: [
      "files:appearance.textColour",
      "notes:appearance.textColour",
      "media:appearance.textColour",
      "annotate:appearance.textColour",
      "portal:appearance.textColour",
      "notifications:appearance.ink",
      "clipboard:appearance.ink",
    ],
  },
  {
    role: "muted ink",
    why: "secondary text ink — timestamps, hints, disabled labels",
    keys: ["notifications:appearance.muted", "clipboard:appearance.muted"],
  },
  {
    role: "panel base",
    why: "the near-black a frosted panel composites with its alpha; notifications and clipboard carry the same role as cardRgb CHANNELS plus cardAlpha, a shape this comparison cannot read across, so they are out of this role and in panel opacity",
    keys: [
      "files:appearance.cardColour",
      "notes:appearance.cardColour",
      "media:appearance.cardColour",
      "annotate:appearance.cardColour",
      "portal:appearance.cardColour",
    ],
  },
  {
    role: "panel opacity",
    why: "the alpha the panel base composites at",
    keys: [
      "files:appearance.cardAlpha",
      "notes:appearance.cardAlpha",
      "media:appearance.cardAlpha",
      "annotate:appearance.cardAlpha",
      "portal:appearance.cardAlpha",
      "notifications:appearance.cardAlpha",
      "clipboard:appearance.cardAlpha",
    ],
  },
  {
    role: "row hover wash",
    why: "the wash the pointer paints on an interactive row",
    keys: [
      "files:appearance.hoverColour",
      "media:appearance.hoverColour",
      "annotate:appearance.hoverColour",
      "portal:appearance.hoverColour",
      "launcher:appearance.hoverColour",
      "notifications:appearance.hoverBg",
      "clipboard:appearance.hoverBg",
    ],
  },
  {
    role: "row selection tint",
    why: "the translucent accent tint marking a selected row inside a card",
    keys: [
      "files:appearance.selectionColour",
      "media:appearance.selectionColour",
      "annotate:appearance.selectionColour",
      "portal:appearance.selectionColour",
    ],
  },
  {
    role: "selected row fill",
    why: "the fill of a SELECTED row in the notification centre and the clipboard picker — an opaque-dark treatment, not the accent tint above",
    keys: ["notifications:appearance.focusBg", "clipboard:appearance.focusBg"],
  },
]
/** Accepted divergences: a role whose apps deliberately disagree. An entry
 *  covers the keys that carry one value; any other key or value in that role is
 *  reported as usual, so the entry records a decision instead of muting the role. */
const PALETTE_EXEMPTIONS: Array<{ role: string; value: string; keys: string[]; why: string }> = [
  {
    role: "row hover wash",
    value: "rgba(255, 255, 255, 0.10)",
    keys: [
      "launcher:appearance.hoverColour",
      "notifications:appearance.hoverBg",
      "clipboard:appearance.hoverBg",
    ],
    why: "the picker and notification rows sit on the darker glass and hover a shade heavier (10%) than a card row over the card scrim (8%); the two families are tuned independently, so making them equal would repaint one of them",
  },
]
/** Case and trailing zeros are spelling, not value: `#8AB5F7` is `#8ab5f7`, and
 *  `rgba(…, 0.10)` is `rgba(…, 0.1)`. A pair that differs only in spelling is
 *  reported too — one role written two ways is the drift that hides. */
function normalisePaletteValue(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b(\d+)\.(\d+?)(0+)\b/g, "$1.$2")
}
const paletteDefaults = new Map<string, { value: string; line: number; raw: string }>()
for (const dataFile of dataFiles) {
  if (!dataFile.endsWith("config.defaults.json")) continue
  const app = rel(dataFile).split("/")[1]
  const text = readFileSync(dataFile, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    continue
  }
  const walk = (node: unknown, path: string[]): void => {
    if (node === null || typeof node !== "object") {
      if (typeof node === "string" || typeof node === "number") {
        const leaf = path[path.length - 1]
        const at = text.search(new RegExp(`"${leaf}"\\s*:`))
        const line = at < 0 ? 1 : text.slice(0, at).split("\n").length
        paletteDefaults.set(`${app}:${path.join(".")}`, {
          value: String(node),
          line,
          raw: String(node),
        })
      }
      return
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, [...path, key])
    }
  }
  walk(parsed, [])
}
for (const { role, keys } of PALETTE_ROLES) {
  const entries = keys
    .map((key) => ({ key, ...(paletteDefaults.get(key) ?? { value: "", line: 1, raw: "" }) }))
    .filter((e) => e.value !== "")
  if (entries.length < 2) continue
  const groups = new Map<string, typeof entries>()
  for (const e of entries) {
    const norm = normalisePaletteValue(e.value)
    groups.set(norm, [...(groups.get(norm) ?? []), e])
  }
  const spellings = new Set(entries.map((e) => e.raw.trim().replace(/\s+/g, " ")))
  if (groups.size === 1) {
    if (spellings.size > 1) {
      const counts = new Map<string, number>()
      for (const e of entries) {
        const raw = e.raw.trim().replace(/\s+/g, " ")
        counts.set(raw, (counts.get(raw) ?? 0) + 1)
      }
      const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      const odd = entries.find((e) => e.raw.trim().replace(/\s+/g, " ") !== majority) ?? entries[0]
      add(
        "palette-role-drift",
        `apps/${odd.key.split(":")[0]}/config.defaults.json`,
        odd.line,
        role,
        "LIKELY",
        `one role, two spellings: ${entries.map((e) => `${e.key}=${e.raw}`).join(", ")}`,
      )
    }
    continue
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  const canonical = ranked[0][1].length > ranked[1][1].length ? ranked[0][0] : undefined
  const exempt = (norm: string, group: typeof entries): boolean => {
    const allowed = PALETTE_EXEMPTIONS.filter(
      (x) => x.role === role && normalisePaletteValue(x.value) === norm,
    )
    return group.every((e) => allowed.some((x) => x.keys.includes(e.key)))
  }
  const unexcused = ranked.filter(
    ([norm, group]) => group !== undefined && norm !== canonical && !exempt(norm, group),
  )
  if (unexcused.length === 0) continue
  const evidence = ranked
    .map(([norm, group]) => `${norm} in ${group.map((e) => e.key).join(", ")}`)
    .join("; ")
  const anchor = unexcused[0][1][0]
  add(
    "palette-role-drift",
    `apps/${anchor.key.split(":")[0]}/config.defaults.json`,
    anchor.line,
    role,
    "JUDGEMENT",
    `one role, ${groups.size} values: ${evidence}`,
  )
}

// ── Primitive sites (redundancy input) ──
const PRIMITIVES: Array<{ name: string; src: string }> = [
  { name: "tilde-expansion", src: "startsWith\\([\"']~[\"']\\)|\\$HOME|[\"']~/[\"']" },
  { name: "subprocess", src: "(Gio\\.)?Subprocess\\.new|spawnDetached|execSync|spawnSync" },
  { name: "shell-quoting", src: "shq\\(|shellQuote|quoteArg" },
  { name: "fuzzy-match", src: "fuzzyScore|subsequence|rankMatches" },
  { name: "logger-construction", src: "createConfigStore|fileSink\\(|logTo\\(" },
  { name: "atomic-write", src: "file_set_contents|replace_contents|writeFileAtomic|atomicWrite" },
  { name: "css-provider", src: "CssProvider\\.new|createCssProvider" },
  { name: "elapsed-format", src: "formatElapsed" },
  { name: "state-store", src: "createStateStore|appStateFilePath" },
  { name: "spinner-glyph", src: "createSpinnerGlyph|createSpinner\\(" },
]
for (const sf of projectFiles) {
  for (const { name, src } of PRIMITIVES) {
    const grep = new RegExp(src, "g")
    let m: RegExpExecArray | null
    while ((m = grep.exec(sf.text)) !== null) {
      add(
        "primitive-site",
        rel(sf.fileName),
        sf.getLineAndCharacterOfPosition(m.index).line + 1,
        name,
        "JUDGEMENT",
        m[0].slice(0, 60),
      )
    }
  }
}

// ── Convention checks ──
for (const sf of projectFiles) {
  const p = sf.fileName
  const text = sf.text
  // relative up-walk into common/ where the @common alias is required
  if (!/config\.schema\.ts$/.test(p) && !/\.probe\.ts$/.test(p)) {
    for (const m of text.matchAll(/from\s+["']((?:\.\.\/)+common\/[^"']+)["']/g)) {
      add(
        "convention-relative-common",
        rel(p),
        text.slice(0, m.index).split("\n").length,
        m[1],
        "CERTAIN",
        "relative up-walk into common/ — use the @common/* alias",
      )
    }
  }
  // common/ reaching into an app
  if (p.startsWith(`${COMMON_DIR}/`)) {
    for (const m of text.matchAll(/from\s+["']@apps\/([^"'/]+)/g)) {
      add(
        "convention-common-imports-app",
        rel(p),
        text.slice(0, m.index).split("\n").length,
        m[1],
        "JUDGEMENT",
        "common/ imports an app (only the four documented seams may)",
      )
    }
    if (
      !p.startsWith(`${COMMON_DIR}/config/`) &&
      /createConfigStore|createConfigFacade|appSchemaDir|appConfigPath/.test(text)
    ) {
      add(
        "convention-common-reads-config",
        rel(p),
        1,
        "",
        "JUDGEMENT",
        "common/ constructs a config store of its own (hosts pass config in)",
      )
    }
  }
  // facade: body is only re-exports
  const hasOther = sf.statements.some(
    (s) =>
      !ts.isImportDeclaration(s) &&
      !ts.isExportDeclaration(s) &&
      !ts.isExportAssignment(s) &&
      !(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)),
  )
  const hasReExport = sf.statements.some(
    (s) => ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined,
  )
  if (hasReExport && !hasOther && sf.statements.length > 1) {
    add("facade-suspect", rel(p), 1, "", "JUDGEMENT", "module body is only imports + re-exports")
  }
}
// single-file directories
function walkDirs(base: string, dir: string, depth: number): void {
  if (depth === 0) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const files = entries.filter((e) => {
    try {
      return statSync(join(dir, e)).isFile()
    } catch {
      return false
    }
  })
  const subs = entries.filter((e) => {
    try {
      return statSync(join(dir, e)).isDirectory() && e !== "node_modules" && e !== "dist"
    } catch {
      return false
    }
  })
  const isAppRoot = dir === join(base, dir.split("/").pop() as string) && base === APPS_DIR
  if (!isAppRoot && files.length === 1 && subs.length === 0 && dir !== ROOT && dir !== base) {
    const appletDir = dir.startsWith(join(COMMON_DIR, "applets/"))
    add(
      "convention-single-file-dir",
      rel(dir),
      1,
      files[0],
      appletDir ? "JUDGEMENT" : "LIKELY",
      appletDir
        ? "single-file applet dir (sanctioned as a per-owner home once it accrues siblings)"
        : `directory holds exactly one file: ${files[0]}`,
    )
  }
  for (const s of subs) walkDirs(base, join(dir, s), depth - 1)
}
walkDirs(APPS_DIR, APPS_DIR, 6)
walkDirs(COMMON_DIR, COMMON_DIR, 6)

// ── Emit ──
const kept = findings.filter((f) => keep(f.kind))
kept.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file) || a.line - b.line)

if (!summaryOnly) {
  for (const f of kept) {
    if (asJson) {
      console.log(JSON.stringify(f))
    } else {
      const clean = (s: string): string => s.replace(/[\t\n\r]/g, " ")
      console.log(
        `${f.kind}\t${f.file}:${f.line}\t${clean(f.symbol)}\t${f.confidence}\t${clean(f.evidence)}`,
      )
    }
  }
}

const counts = new Map<string, number>()
for (const f of kept) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1)
console.error(`# audit-dead-code — ${kept.length} findings in ${Date.now() - started}ms`)
for (const [kind, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.error(`# ${String(n).padStart(6)}  ${kind}`)
}
