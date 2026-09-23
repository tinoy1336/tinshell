/**
 * bang-token.probe — reproducible probe for the bang token grammar
 * (apps/launcher/sources/bang-token.ts).
 *
 * Pure module, no gi, no GTK, no launcher window: it asserts the rules the
 * token grammar and the catalogue row builders rest on — what a token resolves
 * to, which argument the autofill completes, what a catalogue hint does to the
 * entry text, and what each bang's row actually contains for a typed argument.
 *
 * The regressions it pins:
 *   - `!co ~/some/file` must reach the `!code` command with `~/some/file`, and
 *     accepting the `!code` hint must leave the path in the entry;
 *   - every catalogue spelling resolves to itself, so the hint list and the
 *     dispatch cannot disagree;
 *   - every bang that owns a row builder produces the row its hint promises,
 *     with the argument percent-encoded (a `&` typed into a search must not
 *     become a second URL parameter);
 *   - a bang with a required argument offers NO row without one.
 *
 * Run:  node --experimental-strip-types apps/launcher/sources/bang-token.probe.ts
 */
import {
  BANG_CATALOGUE,
  type BangEnv,
  bangRow,
  catalogueEntry,
  pathBangArgument,
  resolveBang,
  spliceBangToken,
  splitBang,
} from "./bang-token.ts"

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

/** A stub host: the row builders read the platform only through this. */
const ENV: BangEnv = {
  tinshellDir: "/home/dev/tinshell",
  browserFirefox: "firefox",
  browserChromium: "chromium",
  searchUrl: "https://www.google.com/search?q=",
  checksum: (algo, text) => `${algo}:${text}`,
  randomUuid: () => "00000000-0000-4000-8000-000000000000",
  servicesForPort: (port) =>
    port === 22 ? ["ssh/tcp", "ssh/udp"] : port === 8080 ? ["http-alt/tcp"] : [],
}

const row = (spelling: string, arg: string) => {
  const entry = catalogueEntry(spelling)
  if (!entry) throw new Error(`no catalogue entry for ${spelling}`)
  return bangRow(entry, arg, ENV)
}
const url = (spelling: string, arg: string): string | null => {
  const r = row(spelling, arg)
  return r && r.kind === "url" ? r.url : null
}
const title = (spelling: string, arg: string): string | null => {
  const r = row(spelling, arg)
  if (!r) return null
  return r.kind === "value" ? r.value.title : r.title
}
const copy = (spelling: string, arg: string): string | null => {
  const r = row(spelling, arg)
  return r && r.kind === "value" ? (r.value.copy ?? null) : null
}
const argv = (spelling: string, arg: string): string | null => {
  const r = row(spelling, arg)
  return r && r.kind === "spawn" ? r.argv.join(" ") : null
}

// ── resolveBang: an exact spelling wins, else the one prefix it names ──
check("exact !c stays chromium", resolveBang("!c"), "!c")
check("exact !p stays media (not !py)", resolveBang("!p"), "!p")
check("exact !cc", resolveBang("!cc"), "!cc")
check("abbrev !co", resolveBang("!co"), "!code")
check("abbrev !cod", resolveBang("!cod"), "!code")
check("new bang !a is exact", resolveBang("!a"), "!a")
check("case-folded !CO", resolveBang("!CO"), "!code")
check("case-folded !A", resolveBang("!A"), "!a")
check("bare ! names nothing", resolveBang("!"), null)
check("unknown !zz", resolveBang("!zz"), null)
check("empty token", resolveBang(""), null)
// New tokens resolve to themselves, and the prefixes they share name nothing.
check("!g is exact", resolveBang("!g"), "!g")
check("!gh is exact", resolveBang("!gh"), "!gh")
check("abbrev !gr", resolveBang("!gr"), "!grab")
check("!b64 is exact (not a prefix of !b64d)", resolveBang("!b64"), "!b64")
check("!b64d is exact", resolveBang("!b64d"), "!b64d")
check("ambiguous !b names nothing", resolveBang("!b"), null)
check("ambiguous !j names nothing", resolveBang("!j"), null)
check("ambiguous !m names nothing", resolveBang("!m"), null)
// `!w` is an ALIAS now, not a prefix resolution (see the alias block below).
check("!w is the Wikipedia alias, not the ambiguous prefix", resolveBang("!w"), "!wiki")
check("!f stays the firefox search", resolveBang("!f"), "!f")
check("abbrev !fp reaches the private window", resolveBang("!fp"), "!fp")
check("abbrev !wik", resolveBang("!wik"), "!wiki")
check("abbrev !po", resolveBang("!po"), "!port")

// ── the alias table: declared on the catalogue entry, resolved at the
//    precedence of a canonical spelling ──
const ALIAS_TABLE: [string, string][] = [
  ["!w", "!wiki"],
  ["!d", "!def"],
  ["!df", "!def"],
  ["!be", "!b64"],
  ["!bd", "!b64d"],
]
for (const [alias, canonical] of ALIAS_TABLE) {
  check(`alias ${alias} names ${canonical}`, resolveBang(alias), canonical)
  check(`alias ${alias} resolves to a real entry`, catalogueEntry(canonical) !== null, true)
}
const DECLARED = BANG_CATALOGUE.flatMap((b) =>
  (b.aliases ?? []).map((a) => `${a}:${b.prefix.trim()}`),
)
check(
  "the catalogue declares exactly the asserted alias table",
  DECLARED.sort().join(" "),
  ALIAS_TABLE.map(([a, c]) => `${a}:${c}`)
    .sort()
    .join(" "),
)
// 1. an exact canonical spelling wins over an alias and over the prefix rule.
check("!wc stays the word count beside the !w alias", resolveBang("!wc"), "!wc")
check("!b64 stays exact beside its !be alias", resolveBang("!b64"), "!b64")
check("!b64d stays exact beside its !bd alias", resolveBang("!bd"), "!b64d")
check("!json stays exact beside its short prefix", resolveBang("!json"), "!json")
check("!dec stays exact beside the !d and !df aliases", resolveBang("!dec"), "!dec")
check("!de still names nothing (def + dec both start there)", resolveBang("!de"), null)
// 2/3. an aliased token is resolved by the ALIAS, not by the prefix rule: the
//      aliases below all prefix SEVERAL bangs (or none), so the prefix rule
//      alone would answer null.
for (const [alias] of ALIAS_TABLE) {
  const prefixed = BANG_CATALOGUE.map((b) => b.prefix.trim()).filter((c) => c.startsWith(alias))
  check(`alias ${alias} is not reachable as a unique prefix`, prefixed.length !== 1, true)
}
// 4. no alias may be a canonical spelling, and no two entries may share one.
const canonicalSpellings = new Set(BANG_CATALOGUE.map((b) => b.prefix.trim()))
for (const [alias] of ALIAS_TABLE) {
  check(`alias ${alias} is not a canonical spelling`, canonicalSpellings.has(alias), false)
  check(
    `alias ${alias} is lowercase and prefixed`,
    alias === alias.toLowerCase() && alias.startsWith("!"),
    true,
  )
}
check(
  "no alias is declared twice",
  DECLARED.length,
  new Set(DECLARED.map((d) => d.split(":")[0])).size,
)
// The bangs a person resents typing keep their shortest previously-available
// form, so the alias table stays a gap-filler rather than a second vocabulary.
check("!pa still reaches the package search", resolveBang("!pa"), "!pac")
check("!au still reaches the AUR", resolveBang("!au"), "!aur")
check("!t still reaches translate", resolveBang("!t"), "!tr")
check("!y still reaches youtube", resolveBang("!y"), "!yt")
// `!js` reaches JSON through the PREFIX rule (its one canonical match), which
// is why JSON declares no alias: the alias table only fills real gaps.
check("!js already reaches json by prefix, so json needs no alias", resolveBang("!js"), "!json")
check("!cl names nothing — the clipboard bang is gone", resolveBang("!cl"), null)
check("!clip names nothing", resolveBang("!clip"), null)
check("no catalogue entry is !clip", canonicalSpellings.has("!clip"), false)
check(
  "no alias resolves to a removed bang",
  DECLARED.some((d) => d.endsWith(":!clip")),
  false,
)

// Every catalogue spelling resolves to itself — the hint list and the dispatch
// rule cannot disagree.
for (const b of BANG_CATALOGUE) {
  const spelling = b.prefix.trim()
  check(`catalogue ${spelling} resolves to itself`, resolveBang(spelling), spelling)
}
check(
  "!a is in the catalogue",
  BANG_CATALOGUE.some((b) => b.prefix === "!a " && b.pathArg === true),
  true,
)

// ── every bang either owns a row builder or is dispatched by bangs.ts ──
const BUILDER_KINDS = (b: { url?: unknown; compute?: unknown; spawn?: unknown }): string[] =>
  (["url", "compute", "spawn"] as const).filter((k) => b[k] !== undefined)
for (const b of BANG_CATALOGUE) {
  const kinds = BUILDER_KINDS(b)
  check(`at most one row builder on ${b.prefix.trim()}`, kinds.length <= 1, true)
}
const withoutBuilder = BANG_CATALOGUE.filter((b) => BUILDER_KINDS(b).length === 0)
  .map((b) => b.prefix.trim())
  .sort()
check(
  "builder-less bangs are exactly the ones bangs.ts dispatches",
  withoutBuilder.join(" "),
  ["!a", "!c", "!cc", "!code", "!f", "!n", "!p", "!py", "!q", "!wc"].join(" "),
)

// ── preview opt-in: the bangs that fetch a payload, and where it comes from ──
// A bang without an `enrich` keeps the row its own builder produces, so this
// list is the whole set of bangs a keystroke sends anywhere.
const enriched = BANG_CATALOGUE.filter((b) => b.enrich !== undefined).map(
  (b) => `${b.prefix.trim()}:${b.enrich}`,
)
check(
  "previewed bangs are exactly the ones with a source",
  enriched.join(" "),
  [
    "!g:ddg",
    "!wiki:wikipedia",
    "!aw:archwiki",
    "!yt:youtube",
    "!def:wiktionary",
    "!tr:translate",
    "!pac:archpackage",
    "!aur:aur",
  ].join(" "),
)
check(
  "every previewed bang carries a URL row to enrich",
  BANG_CATALOGUE.filter((b) => b.enrich !== undefined).every((b) => b.url !== undefined),
  true,
)

// ── splitBang ──
check("split !code arg", splitBang("!code ~/shot.png").query, "~/shot.png")
check("split !code token", splitBang("!code ~/shot.png").bang, "!code")
check("split bare token", splitBang("!p").query, "")
check("split collapses extra spaces", splitBang("!code  ~/x").query, "~/x")

// ── the reported defect, at the parse level ──
{
  const { bang, query } = splitBang("!co ~/some/file".trimStart())
  check("!co ~/some/file resolves to !code", resolveBang(bang), "!code")
  check("!co ~/some/file keeps its argument", query, "~/some/file")
}

// ── pathBangArgument: which bangs the autofill completes, and from what ──
check("autofill !a", pathBangArgument("!a ~/shot.png"), "~/shot.png")
check("autofill !code", pathBangArgument("!code ~/shot.png"), "~/shot.png")
check("autofill abbreviated !co", pathBangArgument("!co ~/shot.png"), "~/shot.png")
check("autofill !p", pathBangArgument("!p ~/shot.png"), "~/shot.png")
check("autofill !p (url)", pathBangArgument("!p https://x/y"), "https://x/y")
check("no autofill for a bare token", pathBangArgument("!p"), null)
check("no autofill for a bare !code", pathBangArgument("!code"), null)
check("empty argument is recognized", pathBangArgument("!p "), "")
check("no autofill under !f", pathBangArgument("!f hello"), null)
check("no autofill under !n", pathBangArgument("!n my note"), null)
check("no autofill under !wc", pathBangArgument("!wc a b"), null)
check("no autofill under !man", pathBangArgument("!man ls"), null)
check("no autofill for a plain path", pathBangArgument("~/shot.png"), null)
check("no autofill for empty text", pathBangArgument(""), null)

// ── spliceBangToken: a hint rewrites the TOKEN, never the argument ──
check(
  "hint keeps the typed argument",
  spliceBangToken("!co ~/some/file", "!code "),
  "!code ~/some/file",
)
check("hint on a bare abbreviation", spliceBangToken("!co", "!code "), "!code ")
check("hint on an unknown bang keeps the rest", spliceBangToken("!zz x", "!py "), "!py x")
check("hint on the full spelling is a no-op", spliceBangToken("!code ~/x", "!code "), "!code ~/x")
check("hint collapses the extra space", spliceBangToken("!co  ~/x", "!code "), "!code ~/x")
check("hint on the bare catalogue token", spliceBangToken("!", "!a "), "!a ")
check("hint on the new bang", spliceBangToken("!a ~/x", "!a "), "!a ~/x")

// ── the URL encoder is the one place a typed argument becomes a URL part
//    (asserted in text-tools.probe.ts — it lives in text-tools.ts) ──

// ── web search bangs ──
check(
  "!g opens the configured search url",
  url("!g", "hello world"),
  "https://www.google.com/search?q=hello%20world",
)
check("!g row title", title("!g", "hello world"), "Search: hello world")
check("!g needs an argument", row("!g", "  "), null)
check(
  "!wiki searches wikipedia",
  url("!wiki", "cron"),
  "https://en.wikipedia.org/w/index.php?search=cron",
)
check(
  "!aw searches the arch wiki",
  url("!aw", "hyprland"),
  "https://wiki.archlinux.org/index.php?search=hyprland",
)
check(
  "!yt searches youtube",
  url("!yt", "hyprland rice"),
  "https://www.youtube.com/results?search_query=hyprland%20rice",
)
check(
  "!gh opens an owner/repo",
  url("!gh", "hyprwm/Hyprland"),
  "https://github.com/hyprwm/Hyprland",
)
check(
  "!gh searches otherwise",
  url("!gh", "hyprland"),
  "https://github.com/search?q=hyprland&type=repositories",
)
check(
  "!def opens wiktionary",
  url("!def", "serendipity"),
  "https://en.wiktionary.org/wiki/serendipity",
)
check("!def needs an argument", row("!def", ""), null)
check(
  "!pac searches the package db",
  url("!pac", "firefox"),
  "https://archlinux.org/packages/?q=firefox",
)
check(
  "!aur searches the AUR",
  url("!aur", "google-chrome"),
  "https://aur.archlinux.org/packages?K=google-chrome",
)
check(
  "!fp spawns a private firefox window",
  argv("!fp", "hi there"),
  ["firefox", "--private-window", "https://www.google.com/search?q=hi%20there"].join(" "),
)
check("!fp needs an argument", row("!fp", ""), null)
check(
  "!ci spawns an incognito chromium window",
  argv("!ci", "hi"),
  ["chromium", "--incognito", "https://www.google.com/search?q=hi"].join(" "),
)
check("!ci needs an argument", row("!ci", ""), null)
check("!fp row title", title("!fp", "hi"), "Private search: hi")

// ── translate: the target defaults to English, a `to <lang>` tail overrides ──
check(
  "!tr defaults to english",
  url("!tr", "bonjour"),
  "https://translate.google.com/?sl=auto&tl=en&text=bonjour&op=translate",
)
check(
  "!tr takes a target language",
  url("!tr", "where is the library to es"),
  "https://translate.google.com/?sl=auto&tl=es&text=where%20is%20the%20library&op=translate",
)
check("!tr names the target", title("!tr", "hola to es"), "Translate to Spanish")
check(
  "!tr keeps a `to` that names no language",
  url("!tr", "i want to go")?.includes("text=i%20want%20to%20go"),
  true,
)
check("!tr needs text", row("!tr", ""), null)
// A `to <lang>` tail that names no language is part of the text, not a target.
check(
  "!tr keeps a `to` that names no language",
  url("!tr", "hola to zz")?.includes("text=hola%20to%20zz"),
  true,
)

// ── the desktop ──
check(
  "!man opens the page in the terminal",
  argv("!man", "ls"),
  ["kitty", "--single-instance", "man", "ls"].join(" "),
)
check("!man needs a page", row("!man", " "), null)
check(
  "!grab runs the house capture pipeline",
  argv("!grab", ""),
  "/home/dev/tinshell/common/shell/ensure-screengrab.sh",
)
check("!grab row title", title("!grab", ""), "Capture region")
check("!pick runs the colour picker", argv("!pick", ""), ["hyprpicker", "-a"].join(" "))
check(
  "!kill signals by exact name",
  argv("!kill", "firefox"),
  ["pkill", "-TERM", "-x", "firefox"].join(" "),
)
check("!kill never matches a command line", argv("!kill", "foo")?.includes("-f"), false)
check("!kill needs a name", row("!kill", ""), null)
check("!mixer opens the mixer", argv("!mixer", ""), "pavucontrol")

// ── text and data ──
check("!b64 encodes", copy("!b64", "hello"), "aGVsbG8=")
check("!b64d decodes", copy("!b64d", "aGVsbG8="), "hello")
check("!b64d refuses a non-token", title("!b64d", "***"), "Not base64")
check("!b64d refusal copies nothing", copy("!b64d", "***"), null)
check("!b64 needs text", row("!b64", " "), null)
check("!enc percent-encodes", copy("!enc", "a b&c"), "a%20b%26c")
check("!dec percent-decodes", copy("!dec", "a%20b"), "a b")
check("!dec refuses a bad escape", title("!dec", "%ZZ"), "Not percent-encoded")
check("!json formats", copy("!json", '{"a":1}'), '{\n  "a": 1\n}')
check("!json reports its shape", title("!json", '{"a":1}'), "Valid JSON — 1 key")
check("!json refuses non-json", title("!json", "{oops}"), "Not JSON")
check("!rgb reads a hex code", title("!rgb", "#ff0000"), "#FF0000 — rgb(255, 0, 0)")
check("!rgb copies the hex", copy("!rgb", "#f00"), "#FF0000")
check("!rgb copies the alpha form when there is one", copy("!rgb", "#ff000080"), "#FF000080")
check("!rgb refuses a word", title("!rgb", "teal"), "Not a colour code")
check("!cron describes", title("!cron", "*/5 * * * *"), "Every 5 minutes")
check("!cron copies the expression", copy("!cron", "*/5 * * * *"), "*/5 * * * *")
check("!cron refuses prose", title("!cron", "whenever"), "Not a cron expression")
check("!epoch reads seconds", title("!epoch", "1700000000"), "2023-11-14 22:13:20 UTC")
check("!epoch copies the iso form", copy("!epoch", "1700000000"), "2023-11-14T22:13:20.000Z")
check("!epoch with no argument answers now", title("!epoch", "")?.endsWith("UTC"), true)
check("!epoch refuses a word", title("!epoch", "yesterday"), "Not an epoch")
check("!sha hashes through the host", copy("!sha", "hello"), "sha256:hello")
check("!md5 hashes through the host", copy("!md5", "hello"), "md5:hello")
check("!sha needs text", row("!sha", " "), null)
check("!uuid uses the host generator", copy("!uuid", ""), "00000000-0000-4000-8000-000000000000")
check("!uuid needs no argument", title("!uuid", ""), "00000000-0000-4000-8000-000000000000")
check("!port names the service", title("!port", "22"), "Port 22 — ssh/tcp, ssh/udp")
check("!port copies the service names", copy("!port", "22"), "ssh/tcp ssh/udp")
check("!port names an unknown port", title("!port", "9999"), "Port 9999")
check("!port refuses a word", title("!port", "http"), "Not a port number")
check("!port with no argument shows nothing", row("!port", ""), null)
{
  const token =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ." +
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  check("!jwt decodes the payload", copy("!jwt", token)?.includes('"name": "John Doe"'), true)
  check("!jwt names the algorithm", title("!jwt", token), "JWT")
  check("!jwt refuses a non-token", title("!jwt", "hello"), "Not a JWT")
}

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`bang-token probe failed: ${failed.length} check(s)`)
