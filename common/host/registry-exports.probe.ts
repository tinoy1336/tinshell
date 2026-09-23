/**
 * registry-exports.probe — reproducible probe for the REGISTRY export-name
 * guard (common/host/registry-exports.ts). Pure module, no gi, no host.
 *
 * Proves the guard fails LOUD on the class of bug where a declared export
 * name does not exist on an app module (`mount: "emojiMount"` while the
 * module exports `mountEmoji`), passes a correct declaration, and — the
 * HOST's path — turns the same failure into a LOGGED SKIP (null + one log
 * line naming the app and the missing export) so one misdeclared app never
 * takes an instance down at boot.
 *
 * Run:  node --experimental-strip-types common/host/registry-exports.probe.ts
 */
import {
  assertModuleExports,
  RegistryExportError,
  resolveModuleExports,
} from "./registry-exports.ts"

const checks: [string, boolean][] = []
const check = (name: string, ok: boolean): void => {
  checks.push([name, ok])
}

const decl = { mount: "mountEmoji", css: "emojiCss", unmount: "unmount" }

function throws(
  decl2: { mount: string; css?: string; unmount?: string },
  mod: any,
): RegistryExportError | null {
  try {
    assertModuleExports("emoji", decl2, mod)
    return null
  } catch (e) {
    return e instanceof RegistryExportError ? e : null
  }
}

// A correct module passes.
check(
  "correct module passes",
  throws(decl, {
    mountEmoji: () => {},
    emojiCss: "css",
    unmount: () => {},
  }) === null,
)

// The exact production typo: declared mount missing from the module.
const missingMount = throws(decl, { emojiCss: "css", unmount: () => {} })
check("missing mount throws", missingMount !== null)
check("missing mount named", missingMount?.missing.includes("mountEmoji") === true)
check("error is named", missingMount?.name === "RegistryExportError")

// A css export declared but not a string.
const badCss = throws(decl, { mountEmoji: () => {}, emojiCss: () => {}, unmount: () => {} })
check("non-string css throws", badCss?.missing.includes("emojiCss") === true)

// An unmount declared but not a function.
const badUnmount = throws(decl, { mountEmoji: () => {}, emojiCss: "css", unmount: "nope" })
check("non-function unmount throws", badUnmount?.missing.includes("unmount") === true)

// A missing module namespace is a mount failure, not a crash.
const nullMod = throws(decl, null)
check("null module throws", nullMod?.missing.includes("mountEmoji") === true)

// Optional exports that are NOT declared must not be required.
check(
  "css optional when undeclared",
  throws({ mount: "mountEmoji" }, { mountEmoji: () => {} }) === null,
)

// ── the HOST's skip path (resolveModuleExports) ──
// Same checks, no throw: the caller gets null plus ONE log line naming the
// app and the missing export(s).
function skip(
  decl2: { mount: string; css?: string; unmount?: string },
  mod: any,
): { mod: any; logs: string[] } {
  const logs: string[] = []
  const result = resolveModuleExports("emoji", decl2, mod, (m) => logs.push(m))
  return { mod: result, logs }
}

const good = skip(decl, { mountEmoji: () => {}, emojiCss: "css", unmount: () => {} })
check("skip: valid module resolves", typeof good.mod?.mountEmoji === "function")
check("skip: valid module logs nothing", good.logs.length === 0)

const skippedMount = skip(decl, { emojiCss: "css", unmount: () => {} })
check("skip: missing mount yields null", skippedMount.mod === null)
check("skip: missing mount logs once", skippedMount.logs.length === 1)
check("skip: log names the app", skippedMount.logs[0]?.includes("'emoji'") === true)
check("skip: log names the missing export", skippedMount.logs[0]?.includes("mountEmoji") === true)

const skippedCss = skip(decl, { mountEmoji: () => {}, emojiCss: () => {}, unmount: () => {} })
check("skip: non-string css yields null", skippedCss.mod === null)
check("skip: non-string css named in the log", skippedCss.logs[0]?.includes("emojiCss") === true)

const skippedUnmount = skip(decl, { mountEmoji: () => {}, emojiCss: "css", unmount: "nope" })
check("skip: non-function unmount yields null", skippedUnmount.mod === null)
check(
  "skip: non-function unmount named in the log",
  skippedUnmount.logs[0]?.includes("unmount") === true,
)

const skippedNull = skip(decl, null)
check("skip: null module yields null", skippedNull.mod === null)
check(
  "skip: every missing export listed",
  ["mountEmoji", "emojiCss", "unmount"].every((n) => skippedNull.logs[0]?.includes(n) === true),
)

const failed = checks.filter(([, ok]) => !ok)
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`)
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`registry-exports probe failed: ${failed.length} check(s)`)
