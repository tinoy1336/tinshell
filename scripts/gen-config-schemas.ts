/**
 * Schema generator — emits apps/<app>/config.schema.json from the TypeBox
 * source of truth apps/<app>/config.schema.ts.
 *
 * Loader contract (common/config/loader.ts validate() + tierOf()): only
 * `type`, `enum`, `items`, `minItems`, `maxItems`, `properties`,
 * `additionalProperties === false`, and `x-tier` are consumed. TypeBox emits
 * several standard keys that subset cannot read (`required`, `anyOf`,
 * `patternProperties`) and per-app sources may carry decorative constraints
 * (`minimum`/`maximum`/`format`/`description`) that the loader ignores — all
 * of those are pruned here so the emitted JSON contains exactly the
 * loader-readable surface (a schema-valued additionalProperties is loader-
 * equivalent to "open": unknown keys allowed, unvalidated).
 *
 * x-tier lives in a per-app sidecar `tiers: Record<dotted-path, Tier>` map
 * (keeps TypeBox types clean) and is merged onto the matching node here.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-config-schemas.ts [app...]
 *     writes config.schema.json for every app (or the listed ones)
 *   node --experimental-strip-types scripts/gen-config-schemas.ts --check
 *     semantic-equivalence check: freshly generated vs file on disk
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const APPS = join(ROOT, "apps")

/** Loader-read keys only — everything else is pruned at emit.
 *  minimum/maximum/minLength/maxLength are enforced by validate() (bounds),
 *  so they MUST survive emission. format/description/title/required etc are
 *  loader-decorative and pruned. */
const KEEP = new Set([
  "type",
  "enum",
  "items",
  "minItems",
  "maxItems",
  "properties",
  "additionalProperties",
  "x-tier",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
])

function prune(node: any): void {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const n of node) prune(n)
    return
  }
  for (const k of Object.keys(node)) {
    if (!KEEP.has(k)) {
      delete node[k]
      continue
    }
    if (k === "properties" && typeof node[k] === "object") {
      // properties is a NAME→node map, not a schema node: prune each child
      // value, keep the container.
      for (const name of Object.keys(node[k])) prune(node[k][name])
    } else if (k === "items") {
      prune(node[k])
    } else if (k === "additionalProperties" && typeof node[k] === "object") {
      prune(node[k])
    }
  }
  // TypeBox emits an empty properties:{} on every object; map nodes omit it —
  // drop so projections line up.
  if (node.properties && Object.keys(node.properties).length === 0) delete node.properties
  // Type.Enum emits {enum:[...]} without a type; restore it from the first
  // enum member (loader semantics identical either way).
  if (node.enum !== undefined && node.type === undefined) {
    const t = typeof node.enum[0]
    node.type = t === "boolean" ? "boolean" : t === "number" ? "number" : "string"
  }
}

/** Walk dotted path through properties chains (x-tier sidecar merge target).
 *  "" (empty) = the root node itself. */
function nodeAt(root: any, path: string): any | undefined {
  if (path === "") return root
  let cur = root
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object" || typeof cur.properties !== "object") return undefined
    cur = cur.properties[seg]
  }
  return cur
}

/** Loader-consumed projection of a schema JSON — the equivalence key. */
function project(node: any): any {
  const out: any = {}
  if (node.type !== undefined) out.type = node.type
  if (node.enum !== undefined) out.enum = node.enum
  if (node.minItems !== undefined) out.minItems = node.minItems
  if (node.maxItems !== undefined) out.maxItems = node.maxItems
  if (node["x-tier"] !== undefined) out["x-tier"] = node["x-tier"]
  if (node.properties !== undefined && Object.keys(node.properties).length > 0) {
    out.properties = {}
    for (const [k, v] of Object.entries(node.properties)) out.properties[k] = project(v)
  }
  if (node.items !== undefined) out.items = project(node.items)
  // additionalProperties: the loader only distinguishes `false` (reject
  // unknown) from everything else (allow). Absent / true / a value *schema*
  // all mean "open" — the loader never descends into a schema-valued
  // additionalProperties (it does not validate map values), so project to the
  // same canonical token.
  out.additionalProperties = node.additionalProperties === false ? false : "open"
  return out
}

async function loadSchema(app: string): Promise<{ schema: any; tiers: Record<string, string> }> {
  const file = join(APPS, app, "config.schema.ts")
  if (!existsSync(file)) return { schema: null, tiers: {} }
  const mod = await import(pathToFileURL(file).href)
  return { schema: mod.schema, tiers: mod.tiers ?? {} }
}

/** Leaf paths (arrays = one leaf at their own path, no element indexes). */
function leafPaths(obj: any, prefix = ""): Set<string> {
  const out = new Set<string>()
  const walk = (o: any, p: string): void => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) {
      if (p) out.add(p)
      return
    }
    for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k)
  }
  walk(obj, prefix)
  return out
}

/** Is a config path covered by the schema? Walks the schema by segments:
 *  object-with-properties nodes must have the segment as a property; a
 *  schema-valued additionalProperties (map) covers any deeper key; arrays
 *  cover their own path. */
function schemaCovers(schema: any, path: string): boolean {
  let cur = schema
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") return false
    if (cur.type === "object" && cur.properties && cur.properties[seg] !== undefined) {
      cur = cur.properties[seg]
      continue
    }
    // Map group (schema-valued additionalProperties) → any child covered.
    if (
      cur.type === "object" &&
      cur.additionalProperties &&
      typeof cur.additionalProperties === "object"
    ) {
      return true
    }
    // Container whose own path matched but the deeper key isn't a property:
    // absent additionalProperties = open (loader: allow, unvalidated) so any
    // deeper key is covered; additionalProperties:false closes it.
    if (cur.type === "object") return cur.additionalProperties !== false
    return false
  }
  return true
}

/** Terminal schema paths — nodes that hold a VALUE (leaf type, array) or a
 *  map (open child keys); pure property containers are not included. */
function schemaTerminals(schema: any, prefix = ""): string[] {
  const out: string[] = []
  const walk = (node: any, p: string): void => {
    if (!node || typeof node !== "object") return
    const hasProps = node.properties && typeof node.properties === "object"
    if (node.type === "object" && hasProps) {
      // Map with BOTH properties and a value schema? treat props as the
      // children; additionalProperties schema also allows extras.
      for (const [k, v] of Object.entries(node.properties)) walk(v, p ? `${p}.${k}` : k)
      return
    }
    if (
      node.type === "object" &&
      node.additionalProperties &&
      typeof node.additionalProperties === "object"
    ) {
      out.push(p) // map group — child keys open
      return
    }
    if (node.type === "object" && !hasProps) {
      // Childless object = a settable path only when it is NOT the root. An
      // app with no config keys reaches here at the root, and pushing "" would
      // name an empty path in a drift verdict.
      if (p) out.push(p)
      return
    }
    out.push(p) // leaf/array node
  }
  walk(schema, prefix)
  return out
}

/** Structural coverage: defaults keys vs schema property paths (both
 *  directions). Drift here means a defaults key is silently unvalidated (typo
 *  in config.defaults.json) or a schema key can never be set via `config set`
 *  (coerceValue reads the current value to learn its type — absent from
 *  defaults it stays a raw string and type-checks fail). */
function defaultsMismatch(app: string): { missingInSchema: string[]; missingInDefaults: string[] } {
  const defsFile = join(APPS, app, "config.defaults.json")
  if (!existsSync(defsFile)) return { missingInSchema: [], missingInDefaults: [] }
  const defs = JSON.parse(readFileSync(defsFile, "utf8"))
  const schema = JSON.parse(readFileSync(join(APPS, app, "config.schema.json"), "utf8"))
  const defPaths = [...leafPaths(defs)]
  const schemaPaths = [...schemaTerminals(schema)]
  const missingInSchema = defPaths.filter((p) => !schemaCovers(schema, p)).sort()
  const missingInDefaults = schemaPaths.filter(
    (p) => !defPaths.includes(p) && !defPaths.some((d) => d.startsWith(`${p}.`)),
  )
  return { missingInSchema, missingInDefaults }
}

/** Result shape shared by the generate and --check paths. A failed run carries
 *  the error; a successful one carries the warnings it collected (`--check`
 *  reports none, so the field is optional). */
type RunResult = { ok: true; warnings?: string[] } | { ok: false; error: string }

async function generate(app: string): Promise<RunResult> {
  const { schema, tiers } = await loadSchema(app)
  if (!schema) return { ok: false, error: `no config.schema.ts for ${app}` }

  // Clone so the source module's objects are never mutated.
  const tree = JSON.parse(JSON.stringify(schema))
  prune(tree)

  for (const [path, tier] of Object.entries(tiers)) {
    const node = nodeAt(tree, path)
    if (!node) return { ok: false, error: `tier path not found in schema: ${app} ${path}` }
    node["x-tier"] = tier
  }

  const json = `${JSON.stringify(tree, null, 2)}\n`
  const outFile = join(APPS, app, "config.schema.json")
  writeFileSync(outFile, json)

  const { missingInSchema, missingInDefaults } = defaultsMismatch(app)
  const warnings: string[] = []
  if (missingInSchema.length)
    warnings.push(`defaults keys missing from schema: ${missingInSchema.join(", ")}`)
  if (missingInDefaults.length)
    warnings.push(`schema keys missing from defaults: ${missingInDefaults.join(", ")}`)

  // Semantic-equivalence self-check against the pre-write projection is the
  // caller's job (--check compares the file on disk vs the regenerated tree).
  return { ok: true, warnings }
}

function appsToProcess(args: string[]): string[] {
  const appDirs = readdirSync(APPS).filter((d) => existsSync(join(APPS, d, "config.schema.ts")))
  if (args.length === 0) return appDirs
  return appDirs.filter((d) => args.includes(d))
}

async function checkApp(app: string): Promise<RunResult> {
  const { schema, tiers } = await loadSchema(app)
  if (!schema) return { ok: false, error: `no config.schema.ts for ${app}` }
  const tree = JSON.parse(JSON.stringify(schema))
  prune(tree)
  for (const [path, tier] of Object.entries(tiers)) {
    const node = nodeAt(tree, path)
    if (!node) return { ok: false, error: `tier path not found in schema: ${app} ${path}` }
    node["x-tier"] = tier
  }
  const onDisk = JSON.parse(readFileSync(join(APPS, app, "config.schema.json"), "utf8"))
  const a = JSON.stringify(project(tree))
  const b = JSON.stringify(project(onDisk))
  if (a !== b) {
    return {
      ok: false,
      error: `loader-surface differs for ${app} — regenerate (gen-config-schemas.ts ${app})`,
    }
  }
  const { missingInSchema, missingInDefaults } = defaultsMismatch(app)
  if (missingInSchema.length || missingInDefaults.length) {
    const parts: string[] = []
    if (missingInSchema.length) parts.push(`defaults→schema: ${missingInSchema.join(", ")}`)
    if (missingInDefaults.length) parts.push(`schema→defaults: ${missingInDefaults.join(", ")}`)
    return { ok: false, error: `${app}: defaults/schema drift — ${parts.join("; ")}` }
  }
  return { ok: true }
}

const args = process.argv.slice(2)
const check = args.includes("--check")
const apps = appsToProcess(args.filter((a) => a !== "--check"))

let failures = 0
for (const app of apps) {
  const res = check ? await checkApp(app) : await generate(app)
  if (res.ok) {
    console.log(`${check ? "check" : "gen"}: ${app} ok`)
    for (const w of res.warnings ?? []) console.log(`  warn ${app}: ${w}`)
  } else {
    failures++
    console.error(res.error)
  }
}
process.exit(failures ? 1 : 0)
