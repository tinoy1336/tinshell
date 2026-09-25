/**
 * preview.probe — the picker's row preview asks media for a window of its own.
 *
 * Why it exists: the preview's contract is one media window per preview. The
 * RETARGETING verb (`media open`) focuses the most-recent media window and loads
 * the file into it, so a preview sent that way replaces whatever that window is
 * already showing — a defect that needs two previews to become visible, which is
 * exactly what a headless assertion of the argv catches and a single click does
 * not.
 *
 * The action is driven with a STUB host: nothing reaches the real command
 * registry, so no media window is built and no surface is spawned. Only the
 * argv the action sends is asserted.
 *
 * Run (exit non-zero on any violated invariant):
 *   ags bundle --gtk 4 apps/clipboard/preview.probe.ts /tmp/p.sh && bash /tmp/p.sh
 */
import { previewEntry, previewTokens } from "./preview"

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

// ── the stub host (fixture paths; nothing on the machine is read) ──
const IMG_A = "/tmp/clipboard-preview-fixture/img/entry-a.png"
const IMG_B = "/tmp/clipboard-preview-fixture/img/entry-b.png"
const sent: string[][] = []
const replies: ((reply: string) => void)[] = []
const logs: string[] = []
let hides = 0
const host = {
  dispatch: (tokens: string[], onReply: (reply: string) => void) => {
    sent.push([...tokens])
    replies.push(onReply)
  },
  log: (message: string) => {
    logs.push(message)
  },
  hide: () => {
    hides += 1
  },
}

// ── the preview dispatches media's SPAWN route ──
previewEntry(IMG_A, host)
check("the preview sends one request", sent.length, 1)
check("the request addresses the media app", sent[0]?.[0], "media")
check("the request uses media's spawn verb", sent[0]?.[1], "new")
check("the request is NOT the retargeting verb", sent[0]?.[1] === "open", false)
check("the request names the entry's absolute PNG", sent[0]?.[2], IMG_A)
check("the request carries nothing else", sent[0]?.length, 3)
check(
  "the request is the argv previewTokens builds",
  sent[0]?.join(" "),
  previewTokens(IMG_A).join(" "),
)
check("the preview dismissed the picker", hides, 1)
check("a spawn answer logs nothing", logs.length, 0)

// ── a second preview is a second window's request, not the same one ──
previewEntry(IMG_B, host)
check("the second preview sends its own request", sent.length, 2)
check("the second request is the spawn verb too", sent[1]?.[1], "new")
check("the second request carries its own file", sent[1]?.[2], IMG_B)
check("the second request does not repeat the first file", sent[1]?.[2] === IMG_A, false)
check("two previews are two distinct requests", sent[0]?.join(" ") === sent[1]?.join(" "), false)
check("each preview dismisses the picker", hides, 2)

// ── a refused spawn is reported, and reported with the file it named ──
replies[1]("error: no such file or directory: /tmp/gone.png")
check("a refused preview logs a line", logs.length, 1)
check("the log names the entry's own file", logs[0]?.includes(IMG_B), true)
check("the log is not silent about the failure", logs[0]?.startsWith("picker preview failed"), true)
replies[0]("ok")
check("an accepted preview adds no log line", logs.length, 1)

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`preview probe failed: ${failed.length} check(s)`)
