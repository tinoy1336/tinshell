/**
 * lua-string.probe — reproducible probe for the Lua string-literal encoding
 * (common/hyprland/lua-string.ts).
 *
 * Pure module, no gi, no compositor. It asserts the emitted literal for every
 * byte class a launch command can carry: the shq shell idiom (`'\''`), a
 * backslash, a double quote, the control characters a short literal cannot hold
 * raw, and the characters that need no escaping at all. The defect it pins: the
 * shell idiom `'\''` is NOT the Lua escape for a quote — it decodes as a closed
 * literal followed by a stray backslash, so every command containing a quote
 * failed to parse in Hyprland's Lua evaluator.
 *
 * Run:  node --experimental-strip-types common/hyprland/lua-string.probe.ts
 */
import { shq } from "../subprocess/quote.ts"
import { luaStringLiteral } from "./lua-string.ts"

const checks: [string, string, string][] = []
const eq = (name: string, input: string, expected: string): void => {
  checks.push([name, luaStringLiteral(input), expected])
}

// ── plain strings are literal, no escaping needed ──
eq("a bare word", "/e.sh", '"/e.sh"')
eq("an empty string", "", '""')
eq("space, dollar, backtick and semicolon", "a $b `c`;d", '"a $b `c`;d"')
eq("a leading dash", "-rf", '"-rf"')
eq("UTF-8 passes through", "café/📁", '"café/📁"')

// ── the shq output: single quotes stay literal, its backslash does not ──
eq("one shq-quoted argument", shq("/e.sh"), `"'/e.sh'"`)
eq(
  "two shq-quoted arguments",
  `${shq("/e.sh")} ${shq("/tmp/my shot.png")}`,
  `"'/e.sh' '/tmp/my shot.png'"`,
)
eq("a shq-quoted quote", shq("/tmp/my'file.png"), "\"'/tmp/my'\\\\''file.png'\"")

// ── the delimiter and the escape character ──
eq("a double quote", 'a"b', '"a\\"b"')
eq("a backslash", "/tmp/a\\b.png", '"/tmp/a\\\\b.png"')

// ── control characters: a short literal cannot hold them raw ──
eq("a newline", "a\nb", '"a\\010b"')
eq("a carriage return", "a\rb", '"a\\013b"')
eq("a tab", "a\tb", '"a\\009b"')
eq("a NUL byte", "a\u0000b", '"a\\000b"')
eq("a vertical tab", "a\u000bb", '"a\\011b"')
eq("DEL", "a\u007fb", '"a\\127b"')

// ── no case may leave the delimiter or a control character raw ──
const shaped = [...checks]
for (const [name, literal] of shaped) {
  const body = literal.slice(1, -1)
  const wellFormed =
    literal.startsWith('"') &&
    literal.endsWith('"') &&
    [...body].every((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f)
  checks.push([`${name} — delimited with no raw control char`, `${wellFormed}`, "true"])
}

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`)
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`lua-string probe failed: ${failed.length} check(s)`)
