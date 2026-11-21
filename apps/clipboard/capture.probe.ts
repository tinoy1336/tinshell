/**
 * capture.probe — which flavour the clipboard capture reads first.
 *
 * Why it exists: Firefox's "Copy Image" offers `image/png` beside `text/html`
 * that carries only an `<img src=…>` tag. A capture that reads text first
 * stores that markup, so the image is never recorded and a paste elsewhere
 * gets an `<img>` tag instead of a picture. The rule that decides the order is
 * pure (`probeOrder`), so it is asserted here without touching a clipboard;
 * the live probing around it (`wl-paste --list-types`, the image/text reads) is
 * process-bound and cannot be faked headlessly.
 *
 * Run (exit non-zero on any violated invariant):
 *   ags bundle --gtk 4 apps/clipboard/capture.probe.ts /tmp/c.sh && bash /tmp/c.sh
 */
import { probeOrder } from "./capture"

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}

// ── a plain text copy is read as text, even with an image beside it ──
check(
  "text/plain wins over an offered image",
  probeOrder(["text/plain;charset=utf-8", "text/plain", "image/png"]),
  ["text", "gif", "png"],
)
check("a bare text copy", probeOrder(["text/plain"]), ["text", "gif", "png"])

// ── the Firefox image copy: image/* with HTML but no plain text ──
check(
  "an image beside html markup is the image",
  probeOrder(["image/png", "text/html", "text/_moz_htmlcontext"]),
  ["png", "text"],
)
check(
  "a GIF is preferred over the PNG beside it",
  probeOrder(["image/gif", "image/png", "text/html", "text/_moz_htmlinfo"]),
  ["gif", "png", "text"],
)
check("an image alone", probeOrder(["image/png"]), ["png", "text"])
check("a GIF alone", probeOrder(["image/gif"]), ["gif", "png", "text"])

// ── the failure paths fall back to the old order ──
check("no flavours at all", probeOrder([]), ["text"])
check("html with no image is still text", probeOrder(["text/html"]), ["text"])

const failed = checks.filter(([, a, e]) => JSON.stringify(a) !== JSON.stringify(e))
for (const [name, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`)
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`capture probe failed: ${failed.length} check(s)`)
