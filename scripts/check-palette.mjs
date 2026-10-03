#!/usr/bin/env node
/**
 * check-palette — re-render every generated palette carrier and compare it with
 * the file committed in this tree.
 *
 * WHY THIS GATE EXISTS. The colours in this tree come from the house palette,
 * whose file is configuration and lives in the home repository, and whose
 * renderer is a published program. The carriers (`common/shell/theme.css`,
 * `common/css/tokens.ts`) are generated from it and committed here, so nothing
 * about the palette is visible in a diff of this tree until something re-renders
 * — and a carrier that quietly holds last month's accent is a theme that no
 * longer matches the palette it claims to follow. This gate re-renders against
 * the palette revision this repository pins and fails when a committed carrier,
 * or the record beside its template, is not what that palette produces.
 *
 *   node scripts/check-palette.mjs            compare (CI, and before a commit)
 *   node scripts/check-palette.mjs --write    re-render the carriers and write them
 *
 * The renderer is the published program `scripts/palette/pin.json` names, run
 * through npx at the pinned version, so a local run and the CI run are the same
 * run; `COLOURWAY_BIN` names a local executable instead, for work on the
 * renderer itself or for a machine with no network. The palette file is resolved
 * by the renderer: from `COLOURWAY_PALETTE` when that variable is set — CI
 * fetches the pinned file into it — and otherwise from the standard
 * configuration location. The pin also carries the palette digest, passed to
 * every render as `--expect-palette`, so a palette that is not the one this tree
 * was rendered against stops the run.
 *
 * Exit codes, the renderer's own contract: 0 every carrier is current, 1 drift
 * (a carrier or a record differs, or the palette is not the pinned digest), 2
 * the render could not happen (no renderer, an unreadable pin, a template that
 * throws). A gate that reads 2 as "current" is broken, so the two are never
 * merged into one non-zero code.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PIN_PATH = join(ROOT, "scripts", "palette", "pin.json")

/** Every generated carrier of this repository, with the template and the record
 *  that produce it. One row per rendered file: adding a carrier here is what
 *  puts it under the gate. */
const CARRIERS = [
  {
    name: "theme",
    template: "scripts/palette/theme.template.ts",
    out: "common/shell/theme.css",
    record: "scripts/palette/theme.record.json",
  },
  {
    name: "tokens",
    template: "scripts/palette/tokens.template.ts",
    out: "common/css/tokens.ts",
    record: "scripts/palette/tokens.record.json",
  },
]

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("*/")[0]
      .replace(/^\/\*\*?/, "")
      .replace(/^ ?\* ?/gm, ""),
  )
  process.exit(0)
}
const unknown = args.filter((argument) => argument !== "--write")
if (unknown.length > 0) {
  console.error(`unknown argument: ${unknown[0]}`)
  console.error("usage: node scripts/check-palette.mjs [--write]")
  process.exit(2)
}
const write = args.includes("--write")

function readPin() {
  let pin
  try {
    pin = JSON.parse(readFileSync(PIN_PATH, "utf8"))
  } catch (error) {
    console.error(`pin ${PIN_PATH} could not be read: ${error.message}`)
    process.exit(2)
  }
  const renderer = pin?.renderer
  const palette = pin?.palette
  const shaped =
    typeof renderer?.package === "string" &&
    renderer.package.length > 0 &&
    typeof renderer?.version === "string" &&
    renderer.version.length > 0 &&
    typeof palette?.revision === "string" &&
    palette.revision.length > 0 &&
    typeof palette?.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(palette.sha256)
  if (!shaped) {
    console.error(`pin ${PIN_PATH} names no renderer version, no palette revision and no digest`)
    process.exit(2)
  }
  return pin
}

const pin = readPin()

/** The renderer a run uses: a local executable when one is named, the pinned package otherwise. */
function renderer() {
  const local = process.env.COLOURWAY_BIN
  if (local !== undefined && local !== "") return { command: local, prefix: [] }
  return { command: "npx", prefix: ["--yes", `${pin.renderer.package}@${pin.renderer.version}`] }
}

const program = renderer()
let drifted = 0
let failed = 0
for (const carrier of CARRIERS) {
  const argv = [
    ...program.prefix,
    "--template",
    join(ROOT, carrier.template),
    "--out",
    join(ROOT, carrier.out),
    "--record",
    join(ROOT, carrier.record),
    "--revision",
    pin.palette.revision,
    "--expect-palette",
    pin.palette.sha256,
  ]
  if (!write) argv.push("--check")
  const run = spawnSync(program.command, argv, { stdio: "inherit", timeout: 120000 })
  if (run.status === 0) continue
  if (run.status === 1) {
    drifted += 1
    continue
  }
  console.error(`render-failed ${carrier.name}: the render could not happen (exit ${run.status ?? "signal"})`)
  failed += 1
}

if (failed > 0) process.exit(2)
if (drifted > 0) {
  console.log(
    `${drifted} of ${CARRIERS.length} palette carrier(s) are stale: re-render with --write, read the diff, and commit it with its record`,
  )
  process.exit(1)
}
if (write) {
  console.log(`wrote ${CARRIERS.length} palette carrier(s) from revision ${pin.palette.revision}`)
} else {
  console.log(`${CARRIERS.length} palette carrier(s) current at revision ${pin.palette.revision}`)
}
process.exit(0)
