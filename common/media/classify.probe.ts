/**
 * classify.probe — the media-kind table and its two callers' contract
 * (common/media/classify.ts).
 *
 * Every consumer gates on this predicate: the pane decides whether to render
 * a still, the player decides whether to build a pipeline, the launcher's `!a`
 * bang decides whether to offer a row. A wrong kind is not an error anywhere —
 * it is a file that silently opens in the wrong surface, or a format that
 * never renders. These checks pin the table's shape (each declared kind
 * reachable), the extension rule (last dot, lowercased, dotfiles have none)
 * and the still consumer's answer for every kind.
 *
 * Run:  node --experimental-strip-types common/media/classify.probe.ts
 */
import { isStillImage, mediaKind } from "./classify.ts"

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}

// ── the extension rule ──
check("a still extension reads image", mediaKind("/tmp/shot.png"), "image")
check("the extension is case-insensitive", mediaKind("SHOT.PNG"), "image")
check("only the LAST dot counts", mediaKind("archive.tar.png"), "image")
check("a dotted directory name does not decide", mediaKind("/a.b/readme"), "other")
check("a dotfile has no extension", mediaKind(".bashrc"), "other")
check("a trailing dot reads other", mediaKind("shot."), "other")
check("a path with no dot reads other", mediaKind("/tmp/README"), "other")
check("an empty path reads other", mediaKind(""), "other")

// ── every declared kind is reachable from the table ──
check("a motion-capable image is its own kind", mediaKind("a.gif"), "animated-image")
check("webp is a motion-capable image", mediaKind("a.webp"), "animated-image")
check("audio is audio", mediaKind("a.mp3"), "audio")
check("video is video", mediaKind("a.mp4"), "video")
check("an unknown extension reads other", mediaKind("a.xyz"), "other")

// ── the still consumer's answer, per kind ──
check("a still image renders inline", isStillImage("a.png"), true)
check("a motion-capable image renders its first frame", isStillImage("a.gif"), true)
check("audio is not a still", isStillImage("a.mp3"), false)
check("video is not a still", isStillImage("a.mp4"), false)
check("an unknown kind is not a still", isStillImage("a.xyz"), false)
check("a dotfile is not a still", isStillImage(".bashrc"), false)

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`)
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`classify probe failed: ${failed.length} check(s)`)
