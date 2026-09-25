#!/usr/bin/env node
/**
 * check-palette — re-render every generated palette carrier and compare it with
 * the file committed in this tree.
 *
 * WHY THIS GATE EXISTS. The colours in this tree come from the house palette,
 * which lives in its own repository and moves on its own schedule. The carriers
 * (`common/shell/theme.css`, `common/css/tokens.ts`) are generated from it and
 * committed here, so nothing about the palette is visible in a diff of this
 * tree until something re-renders — and a carrier that quietly holds last
 * month's accent is a theme that no longer matches the palette it claims to
 * follow. This gate re-renders against the palette revision this repository
 * pins and fails when a committed carrier, or the record beside its template,
 * is not what that palette produces.
 *
 *   node scripts/check-palette.mjs            compare (CI, and before a commit)
 *   node scripts/check-palette.mjs --write    re-render the carriers and write them
 *
 * The palette is resolved from the HOUSE_PALETTE environment variable, else from
 * a sibling checkout at `../house-palette` — the renderer is `bin/render` beside
 * that palette's `palette.json`, and nothing here clones anything. The revision
 * and the digest this repository adopts live in `scripts/palette/pin.json`: a
 * palette that does not carry that digest is a palette this tree has not been
 * rendered against, and the run stops before it compares any carrier.
 *
 * Exit codes, the renderer's own contract: 0 every carrier is current, 1 drift
 * (a carrier or a record differs, or the palette is not the pinned digest), 2
 * the render could not happen (no palette checkout, an unreadable pin, a
 * template that throws). A gate that reads 2 as "current" is broken, so the two
 * are never merged into one non-zero code.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
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
const unknown = args.filter((a) => a !== "--write")
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
  const shaped =
    typeof pin === "object" &&
    pin !== null &&
    typeof pin.revision === "string" &&
    pin.revision.length > 0 &&
    typeof pin.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(pin.sha256)
  if (!shaped) {
    console.error(`pin ${PIN_PATH} names no revision and no sha256 digest`)
    process.exit(2)
  }
  return pin
}

const pin = readPin()
const paletteDir = resolve(ROOT, process.env.HOUSE_PALETTE ?? "../house-palette")
const palettePath = join(paletteDir, "palette.json")
const renderer = join(paletteDir, "bin", "render")

for (const [path, what] of [
  [renderer, "the palette renderer"],
  [palettePath, "the palette source"],
]) {
  if (existsSync(path)) continue
  console.error(`no ${what} at ${path}`)
  console.error(
    "a palette checkout is required: point HOUSE_PALETTE at one, or place it beside this tree as house-palette",
  )
  process.exit(2)
}

// The pinned digest is checked BEFORE any carrier is compared: a palette that is
// not the one this tree was rendered against would fail every carrier with a
// message about a file rather than about the palette.
const found = createHash("sha256").update(readFileSync(palettePath)).digest("hex")
if (found !== pin.sha256) {
  console.log(`palette-mismatch ${palettePath}: pinned ${pin.sha256}, found ${found}`)
  console.log(
    `the palette moved: render deliberately with --write, then commit the carriers and their records`,
  )
  process.exit(1)
}

let drifted = 0
let failed = 0
for (const carrier of CARRIERS) {
  const argv = [
    renderer,
    "--template",
    join(ROOT, carrier.template),
    "--out",
    join(ROOT, carrier.out),
    "--record",
    join(ROOT, carrier.record),
    "--palette",
    palettePath,
    "--revision",
    pin.revision,
    "--expect-palette",
    pin.sha256,
  ]
  if (!write) argv.push("--check")
  const run = spawnSync(process.execPath, argv, { stdio: "inherit", timeout: 60000 })
  if (run.status === 0) continue
  if (run.status === 1) {
    drifted += 1
    continue
  }
  console.error(`render-failed ${carrier.name}: the render could not happen (exit ${run.status})`)
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
  console.log(`wrote ${CARRIERS.length} palette carrier(s) from revision ${pin.revision}`)
} else {
  console.log(`${CARRIERS.length} palette carrier(s) current at revision ${pin.revision}`)
}
process.exit(0)
