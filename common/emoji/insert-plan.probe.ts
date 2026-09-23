/**
 * insert-plan.probe — reproducible probe for the emoji insertion ladder
 * (common/emoji/insert-plan.ts).
 *
 * Pure module + stub injector: no gi, no GTK, no compositor, no real
 * clipboard, no synthetic input. It drives `executeInsertion` with a stub
 * `InsertDeps` that RECORDS the argv it would run and the text it would put on
 * the clipboard, and asserts:
 *   - the copy floor is UNCONDITIONAL: every outcome (mode=copy, every degrade
 *     path, a failed injection) leaves the glyph on the clipboard,
 *   - a failed clipboard write degrades to copy WITHOUT injecting (never paste
 *     stale content),
 *   - the literal argv per target class (window ctrl+v / terminal
 *     ctrl+shift+v / failover typer).
 *
 * Run:  node --experimental-strip-types common/emoji/insert-plan.probe.ts
 */
import { executeInsertion, type InsertDeps, type InsertRequest } from "./insert-plan.ts"

const GLYPH = "😀"

const base: InsertRequest = {
  glyph: GLYPH,
  mode: "paste",
  preferTyper: "wtype",
  terminalClasses: ["kitty", "foot"],
  restoreClipboard: true,
  targetBefore: { address: "0xABC", class: "firefox" },
  targetAfter: { address: "0xABC", class: "firefox" },
  wtypeAvailable: true,
  ydotoolAvailable: true,
}

interface Row {
  name: string
  action: string
  chord: string | null
  typer: string | null
  argv: string | null
  attempts: string[]
  restore: boolean
  reason: string | null
  /** Text the stub actually received on the clipboard (null = never written). */
  copied: string | null
  /** Outcome flag: the write did not throw. */
  clipboardWritten: boolean
}

interface DepsOpts {
  fail?: (argv: string[]) => boolean
  throwOnCopy?: boolean
}

function recordDeps(opts: DepsOpts = {}): {
  deps: InsertDeps
  argvLog: string[][]
  getCopied: () => string | null
} {
  const argvLog: string[][] = []
  let copied: string | null = null
  const deps: InsertDeps = {
    run: async (argv) => {
      argvLog.push(argv)
      return { exit: opts.fail?.(argv) ? 1 : 0 }
    },
    hasBinary: () => true,
    copyToClipboard: (t) => {
      if (opts.throwOnCopy) throw new Error("clipboard unavailable")
      copied = t
    },
    log: () => {},
  }
  return { deps, argvLog, getCopied: () => copied }
}

const rows: Row[] = []
async function run(
  name: string,
  req: InsertRequest,
  opts: DepsOpts & { prior?: string | null } = {},
): Promise<void> {
  const { deps, argvLog, getCopied } = recordDeps(opts)
  const out = await executeInsertion(deps, req, opts.prior ?? "OLD-CLIP")
  const row: Row = {
    name,
    action: out.action.kind,
    chord: out.action.kind === "paste" ? out.action.chord : null,
    typer: out.action.kind === "copy" ? null : out.action.typer,
    argv: out.injectedArgv ? out.injectedArgv.join(" ") : null,
    attempts: argvLog.map((a) => a.join(" ")),
    restore: out.restoreClipboard,
    reason: out.action.kind === "copy" ? out.action.reason : null,
    copied: getCopied(),
    clipboardWritten: out.clipboardWritten,
  }
  rows.push(row)
  console.log(JSON.stringify(row))
}

const checks: [string, boolean][] = []
const check = (name: string, ok: boolean): void => {
  checks.push([name, ok])
}

async function main(): Promise<void> {
  console.log("=== common/emoji/insert-plan.probe (stub injector) ===")
  await run("normal window target", { ...base })
  await run("terminal target (kitty)", {
    ...base,
    targetAfter: { address: "0xABC", class: "kitty" },
  })
  await run("no target before opening", { ...base, targetBefore: null })
  await run("no target after closing", { ...base, targetAfter: null })
  await run("focus moved", { ...base, targetAfter: { address: "0xDEF", class: "firefox" } })
  await run(
    "injection failure -> failover succeeds",
    { ...base },
    { fail: (argv) => argv[0] === "wtype" },
  )
  await run("both typers fail", { ...base }, { fail: () => true })
  await run("mode=type (direct typing)", { ...base, mode: "type" })
  await run("mode=copy", { ...base, mode: "copy" })
  await run("no typer installed", { ...base, wtypeAvailable: false, ydotoolAvailable: false })
  await run("clipboard write fails", { ...base }, { throwOnCopy: true })

  const byName = (n: string): Row => rows.find((r) => r.name === n)!

  // Every row except the failed-write row MUST have put the glyph on the
  // clipboard — that is the copy floor the earlier code skipped.
  for (const r of rows) {
    if (r.name === "clipboard write fails") continue
    check(`${r.name}: copied === glyph`, r.copied === GLYPH)
    check(`${r.name}: clipboardWritten`, r.clipboardWritten === true)
  }

  const normal = byName("normal window target")
  check(
    "normal: paste ctrl+v argv",
    normal.action === "paste" &&
      normal.chord === "ctrl+v" &&
      normal.argv === "wtype -M ctrl -k v" &&
      normal.restore,
  )
  const term = byName("terminal target (kitty)")
  check(
    "terminal: paste ctrl+shift+v argv",
    term.action === "paste" &&
      term.chord === "ctrl+shift+v" &&
      term.argv === "wtype -M ctrl -M shift -k v" &&
      term.restore,
  )
  check("no target before: copy", byName("no target before opening").action === "copy")
  check("no target after: copy", byName("no target after closing").action === "copy")
  check("focus moved: copy", byName("focus moved").action === "copy")
  const failover = byName("injection failure -> failover succeeds")
  check(
    "failover: ydotool argv after wtype failure",
    failover.action === "paste" &&
      failover.typer === "ydotool" &&
      failover.attempts.length === 2 &&
      failover.argv === "ydotool key 29:1 47:1 47:0 29:0",
  )
  check("both fail: copy", byName("both typers fail").action === "copy")
  const typed = byName("mode=type (direct typing)")
  check("type mode: argv", typed.action === "type" && typed.argv === "wtype 😀" && !typed.restore)
  check("mode=copy: copy", byName("mode=copy").action === "copy")
  check("no typer: copy", byName("no typer installed").action === "copy")

  // A failed clipboard write must NOT inject (never paste stale content).
  const writeFail = byName("clipboard write fails")
  check("write fail: copy", writeFail.action === "copy")
  check("write fail: reason", writeFail.reason === "clipboard write failed")
  check("write fail: no injection", writeFail.argv === null && writeFail.attempts.length === 0)
  check("write fail: copied null", writeFail.copied === null)
  check("write fail: clipboardWritten false", writeFail.clipboardWritten === false)

  const failed = checks.filter(([, ok]) => !ok)
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`)
  console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) throw new Error(`insert-plan probe failed: ${failed.length} check(s)`)
}

void main().catch((e: unknown) => {
  // Rethrowing surfaces the failure as an unhandled rejection (non-zero exit)
  // without depending on Node globals — the repo has no @types/node.
  console.error(String(e))
  throw e
})
