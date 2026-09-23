/**
 * text-tools.probe — reproducible probe for the pure text/data shapes
 * (apps/launcher/sources/text-tools.ts).
 *
 * The module is pure (no gi, no GTK), so this runs under plain Node. The
 * encoders are cross-checked against Node's own crypto/Buffer output rather
 * than against hand-written expectations, so a wrong implementation cannot
 * pass by agreeing with itself.
 *
 * Run:  node --experimental-strip-types apps/launcher/sources/text-tools.probe.ts
 */
import {
  base64Decode,
  base64Encode,
  decodeJwt,
  describeCron,
  formatInstant,
  formatRelative,
  jsonSize,
  languageName,
  parseColour,
  parseEpochInput,
  parseIpv4,
  parsePort,
  parseServices,
  percentDecode,
  percentEncode,
  prettyJson,
  SITE,
  servicesForPort,
  shapeRows,
  splitTranslateTarget,
  urlArg,
} from "./text-tools.ts"

/**
 * Node's own encoder, read off the global so this module needs no `node:`
 * types (the repo type-checks without @types/node). It is the probe's
 * INDEPENDENT reference: the hand-written encoder must agree with it, not with
 * a table of expectations written by the same hand.
 */
const nodeBuffer = (
  globalThis as unknown as {
    Buffer?: { from(text: string, encoding: string): { toString(encoding: string): string } }
  }
).Buffer
if (!nodeBuffer) throw new Error("text-tools.probe needs Node's Buffer as its encoder reference")

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

// ── base64: cross-checked against Node's own encoder ──
const b64Samples = [
  "",
  "hello",
  "héllo wörld",
  "😀 emoji",
  "a",
  "ab",
  "abc",
  "the quick brown fox jumps over the lazy dog",
  "\u0000\u0001\u0002binary-ish",
  "x".repeat(1000),
]
for (const sample of b64Samples) {
  const expected = nodeBuffer.from(sample, "utf8").toString("base64")
  check(
    `base64 encoder matches Node: ${JSON.stringify(sample.slice(0, 12))}`,
    base64Encode(sample),
    expected,
  )
  check(`base64 round-trip: ${JSON.stringify(sample.slice(0, 12))}`, base64Decode(expected), sample)
}
check("base64 of 'hello' is padded", base64Encode("hello"), "aGVsbG8=")
// url-safe, unpadded — the form a copied JWT segment arrives in.
for (const sample of b64Samples) {
  const urlSafe = nodeBuffer.from(sample, "utf8").toString("base64url")
  check(
    `base64 decode matches Node (url-safe): ${JSON.stringify(sample.slice(0, 12))}`,
    base64Decode(urlSafe),
    sample,
  )
}
check("base64 decode accepts an unpadded token", base64Decode("aGVsbG8"), "hello")
check("base64 decode ignores whitespace", base64Decode("aGVs bG8="), "hello")
check("base64 decode rejects a bad character", base64Decode("aGVs*bG8="), null)
check("base64 decode rejects a lone character", base64Decode("a"), null)
check("base64 decode rejects a bare pad", base64Decode("="), null)

// ── percent encoding ──
check("percent encode reserved", percentEncode("a b&c=d"), "a%20b%26c%3Dd")
check("percent encode utf-8", percentEncode("é"), "%C3%A9")
check("percent decode utf-8", percentDecode("%E2%82%AC"), "€")
check("percent decode '+' is a space", percentDecode("a+b"), "a b")
check("percent decode rejects malformed escape", percentDecode("%ZZ"), null)

// ── urlArg + the site URL table ──
check("urlArg encodes a space", urlArg("a b"), "a%20b")
check("urlArg encodes &", urlArg("a&b"), "a%26b")
check("urlArg encodes #", urlArg("a#b"), "a%23b")
check("urlArg trims", urlArg("  x  "), "x")
check(
  "site search uses the configured prefix",
  SITE.search("https://s/?q=", "a b"),
  "https://s/?q=a%20b",
)
check("site search refuses an empty argument", SITE.search("https://s/?q=", "  "), null)
check(
  "site github resolves owner/repo",
  SITE.github("hyprwm/Hyprland"),
  "https://github.com/hyprwm/Hyprland",
)
check(
  "site github searches otherwise",
  SITE.github("a b"),
  "https://github.com/search?q=a%20b&type=repositories",
)
check("site wikipedia", SITE.wikipedia("a b"), "https://en.wikipedia.org/w/index.php?search=a%20b")
check("site archwiki", SITE.archWiki("a b"), "https://wiki.archlinux.org/index.php?search=a%20b")
check("site youtube", SITE.youtube("a b"), "https://www.youtube.com/results?search_query=a%20b")
check("site arch package", SITE.archPackage("a b"), "https://archlinux.org/packages/?q=a%20b")
check("site aur", SITE.aur("a b"), "https://aur.archlinux.org/packages?K=a%20b")
check("site dictionary", SITE.dictionary("a b"), "https://en.wiktionary.org/wiki/a%20b")
check(
  "site translate",
  SITE.translate("a b", "es"),
  "https://translate.google.com/?sl=auto&tl=es&text=a%20b&op=translate",
)
check("site translate refuses empty text", SITE.translate("  ", "es"), null)
check("site builders refuse an empty argument", SITE.wikipedia(""), null)

// ── JSON ──
check("prettyJson formats", prettyJson('{"a":1}'), '{\n  "a": 1\n}')
check("prettyJson rejects bad json", prettyJson("{"), null)
check("jsonSize counts object keys", jsonSize({ a: 1, b: 2 }), 2)
check("jsonSize counts array items", jsonSize([1, 2, 3]), 3)
check("jsonSize of a scalar is 0", jsonSize(42), 0)

// ── colour ──
{
  const red = parseColour("#f00")
  check("parseColour #f00 hex", red?.hex, "#FF0000")
  check("parseColour #f00 css", red?.css, "rgb(255, 0, 0)")
  check("parseColour #f00 hsl", red?.hsl, "hsl(0, 100%, 50%)")
  check("parseColour #f00 alpha", red?.a, 1)
  const alpha = parseColour("#ff000080")
  check("parseColour #rrggbbaa alpha", Number(alpha?.a.toFixed(3)), 0.502)
  check("parseColour #rrggbbaa hexAlpha", alpha?.hexAlpha, "#FF000080")
  check("parseColour accepts a bare hex", parseColour("0f0")?.hex, "#00FF00")
  check("parseColour rgb()", parseColour("rgb(0, 128, 255)")?.hex, "#0080FF")
  check("parseColour rgba()", parseColour("rgba(0, 0, 0, 0.5)")?.a, 0.5)
  check("parseColour rgba() css", parseColour("rgba(0,0,0,0.5)")?.css, "rgba(0, 0, 0, 0.5)")
  check("white contrasts 21:1 on black", Math.round(parseColour("#fff")?.contrastOnBlack ?? 0), 21)
  check("white contrasts 1:1 on white", Math.round(parseColour("#fff")?.contrastOnWhite ?? 0), 1)
  check("parseColour rejects a word", parseColour("tealish"), null)
  check("parseColour rejects a 5-digit hex", parseColour("#12345"), null)
  check("parseColour rejects an out-of-range channel", parseColour("rgb(300,0,0)"), null)
  check("parseColour rejects an empty string", parseColour("   "), null)
}

// ── cron ──
check("cron every 5 minutes", describeCron("*/5 * * * *"), "Every 5 minutes")
check("cron weekdays at 04:00", describeCron("0 4 * * 1-5"), "At 04:00 on Monday to Friday")
check("cron hourly", describeCron("0 * * * *"), "Every hour at minute 00")
check("cron every minute", describeCron("* * * * *"), "Every minute")
check(
  "cron monthly on the 1st",
  describeCron("0 0 1 1 *"),
  "At 00:00 on day 1 of the month, in January",
)
check("cron names in fields", describeCron("30 6 * * mon"), "At 06:30 on Monday")
check("cron macro @daily", describeCron("@daily"), "At 00:00")
check("cron macro @weekly", describeCron("@weekly"), "At 00:00 on Sunday")
check("cron macro @reboot", describeCron("@reboot"), "At every boot")
check(
  "cron day-or-weekday is stated",
  describeCron("0 0 1 * 1"),
  "At 00:00 on day 1 of the month, on Monday (day-of-month or weekday)",
)
check("cron hour step", describeCron("15 */6 * * *"), "Every 6 hours at minute 15")
check("cron rejects prose", describeCron("not a cron"), null)
check("cron rejects day 0", describeCron("0 0 0 * *"), null)
check("cron rejects minute 60", describeCron("60 * * * *"), null)
check("cron rejects four fields", describeCron("0 0 * *"), null)
check("cron rejects empty", describeCron("  "), null)

// ── JWT ──
{
  const token =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ." +
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  const parts = decodeJwt(token)
  check("jwt header alg", parts?.header.alg, "HS256")
  check("jwt payload sub", parts?.payload.sub, "1234567890")
  check("jwt payload name", parts?.payload.name, "John Doe")
  check("jwt strips a bearer prefix", decodeJwt(`Bearer ${token}`)?.header.typ, "JWT")
  check("jwt rejects a non-token", decodeJwt("hello"), null)
  check("jwt rejects a one-segment token", decodeJwt("eyJhbGciOiJIUzI1NiJ9"), null)
  check("jwt rejects a non-object payload", decodeJwt("eyJhIjoxfQ.aGVsbG8"), null)
}

// ── instants ──
check("epoch seconds", parseEpochInput("1700000000"), 1700000000000)
check("epoch milliseconds", parseEpochInput("1700000000000"), 1700000000000)
check(
  "epoch ISO string",
  parseEpochInput("2026-01-02T03:04:05Z"),
  Date.parse("2026-01-02T03:04:05Z"),
)
check("epoch rejects prose", parseEpochInput("yesterday"), null)
check("epoch rejects empty", parseEpochInput(""), null)
{
  const instant = formatInstant(1700000000000)
  check("instant utc", instant.utc, "2023-11-14 22:13:20 UTC")
  check("instant iso", instant.iso, "2023-11-14T22:13:20.000Z")
  check(
    "instant local is a stamp",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(instant.local),
    true,
  )
}
{
  const now = 1_700_000_000_000
  check("relative just now", formatRelative(now - 10_000, now), "just now")
  check("relative one hour ago", formatRelative(now - 3_600_000, now), "1 hour ago")
  check("relative two minutes from now", formatRelative(now + 120_000, now), "2 minutes from now")
  check("relative days", formatRelative(now - 3 * 86_400_000, now), "3 days ago")
}

// ── /etc/services ──
{
  const table = parseServices(
    ["# comment", "ssh\t\t22/tcp", "ssh 22/udp", "domain 53/tcp", "", "badline"].join("\n"),
  )
  check("services for 22/tcp+udp", servicesForPort(table, 22).join(","), "ssh/tcp,ssh/udp")
  check("services for 53", servicesForPort(table, 53).join(","), "domain/tcp")
  check("services for an unknown port", servicesForPort(table, 9999).length, 0)
  check("services caps the alias list", servicesForPort(table, 22, 1).length, 1)
}
check("port parses", parsePort("8080"), 8080)
check("port rejects 0", parsePort("0"), null)
check("port rejects 70000", parsePort("70000"), null)
check("port rejects a word", parsePort("http"), null)

// ── translate ──
check("translate default target", splitTranslateTarget("bonjour").target, "en")
check("translate default keeps the text", splitTranslateTarget("bonjour").text, "bonjour")
check("translate explicit target", splitTranslateTarget("hola to es").target, "es")
check("translate explicit target text", splitTranslateTarget("hola to es").text, "hola")
check("translate regional code", splitTranslateTarget("hallo to pt-br").target, "pt-br")
check(
  "translate 'to' that names no language stays text",
  splitTranslateTarget("i want to go").text,
  "i want to go",
)
check("translate unknown code stays text", splitTranslateTarget("hola to zz").target, "en")
check("language name known", languageName("es"), "Spanish")
check("language name regional uses the base", languageName("pt"), "Portuguese")
check("language name unknown falls back to the code", languageName("zz"), "zz")

// ── the bare shapes (what a `!`-less query can answer) ──
const shapes = (input: string) => shapeRows(input)
check("shape: nothing for a word", shapes("hello").length, 0)
check("shape: nothing for a bare number (calc owns it)", shapes("1700000000").length, 0)
check(
  "shape: nothing for a bare 5-field cron (the !cron bang owns it)",
  shapes("*/5 * * * *").length,
  0,
)
check("shape: colour title", shapes("#ff0000")[0]?.title, "#FF0000 — rgb(255, 0, 0)")
check("shape: colour copies the hex", shapes("#ff0000")[0]?.copy, "#FF0000")
check("shape: colour alpha copies the alpha hex", shapes("#ff000080")[0]?.copy, "#FF000080")
check("shape: rgb() form", shapes("rgb(0, 128, 255)")[0]?.copy, "#0080FF")
check("shape: a bare word of letters is not a colour", shapes("fff").length, 0)
check("shape: ipv4 private", shapes("10.0.0.1")[0]?.title, "10.0.0.1 — private (RFC1918)")
check("shape: ipv4 loopback", shapes("127.0.0.1")[0]?.title, "127.0.0.1 — loopback")
check("shape: ipv4 public", shapes("8.8.8.8")[0]?.title, "8.8.8.8 — public")
check("shape: ipv4 link-local", shapes("169.254.1.1")[0]?.title, "169.254.1.1 — link-local")
check(
  "shape: ipv4 integer is shown",
  shapes("10.0.0.1")[0]?.description.includes("integer 167772161"),
  true,
)
check("shape: cidr title", shapes("192.168.1.10/24")[0]?.title, "192.168.1.0/24 — 254 hosts")
check("shape: cidr copies the block", shapes("192.168.1.10/24")[0]?.copy, "192.168.1.0/24")
check(
  "shape: cidr broadcast",
  shapes("192.168.1.10/24")[0]?.description.includes("broadcast 192.168.1.255"),
  true,
)
check(
  "shape: cidr mask",
  shapes("192.168.1.10/24")[0]?.description.includes("mask 255.255.255.0"),
  true,
)
check(
  "shape: /31 has no usable host pair",
  shapes("10.0.0.0/31")[0]?.title,
  "10.0.0.0/31 — 0 hosts",
)
check("shape: rejects an out-of-range octet", shapes("300.0.0.1").length, 0)
check("shape: rejects a prefix over 32", shapes("1.2.3.4/33").length, 0)
check("shape: parseIpv4 value", parseIpv4("10.0.0.255")?.value, 167772415)
check("shape: parseIpv4 rejects a word", parseIpv4("localhost"), null)
check(
  "shape: jwt",
  shapes(
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  )[0]?.title,
  "JWT",
)
check("shape: dotted text is not a jwt", shapes("a.b.c").length, 0)

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`text-tools probe failed: ${failed.length} check(s)`)
