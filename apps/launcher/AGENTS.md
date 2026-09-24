# AGENTS.md — launcher

The launcher surface: a Spotlight-style app launcher/search popup (replaces
anyrun). A REAL standalone app (bus `io.Astal.launcher`); this directory IS
the app.

**READ the repository root `AGENTS.md` FIRST** (multi-app rules: bus
naming, router, launch path, shell aggregation, common modules, onboarding).

## Identity

| | |
| --- | --- |
| Instance / bus | in shell: inside `shell` (`io.Astal.shell`); dev island: `launcher` (`io.Astal.launcher`) |
| Unit | none (dev island; production = `tinshell-shell.service`) |
| Window namespace | `launcher` (layer-shell, keymode EXCLUSIVE while open) |
| Hyprland rule | blur `launcher` (`hl.layer_rule`, ignore_alpha 0.2 — same frost params as the dock/notifications) |
| Router | `route-map.conf`: `launcher=shell,launcher` |
| Keybind | mod+Space → `common/shell/ensure-launcher-toggle.sh` → `tinshell-route launcher toggle`; mod+. → `common/shell/ensure-launcher-emoji.sh` → `tinshell-route launcher emoji` |

## Sources (what lives here)

- `Launcher.tsx` — the popup window: card + entry + result list. In emoji
  mode the list renders as the glyph grid itself; in ordinary searches a
  matching emoji entry is an inline row that expands into that same grid
  (see "Emoji mode"). Widget tree documented in its header; dismissal wired
  via `common/window/popup-dismiss` (Escape / click-outside / focus-loss).
  The ONE loading indicator is the shared spinner glyph (`common/glyph/spinner`)
  on the `entry-row`'s right edge, inside the search field: it spins while an
  async source (calc, `!py`, `!q`, a bang preview) is in flight and is hidden
  otherwise. The
  card has no status line and shows no status text.
- `combiner.ts` — query combiner: sync sources (applications, time, bangs,
  paths, urls, emoji) compute per keystroke, async sources (calc, bang
  previews) resolve
  later; merges to one flat priority-ordered list (urls/paths → bangs → time →
  calc → apps → emoji). In emoji mode every OTHER source is suppressed for
  every query, so the list is emoji-only and the widget renders it as the grid.
  A PATH-SHAPED or URL-SHAPED query is its OWN source's alone —
  apps/bangs/time/calc/emoji are suppressed for it.
  `combiner.probe.ts` is its probe — the conversion rows and the bare typed
  shapes through the REAL query path (no window, no synthetic input):
  `ags bundle --gtk 4 apps/launcher/combiner.probe.ts /tmp/combiner-probe.sh
  && bash /tmp/combiner-probe.sh`, and `QUERIES="1 cup to ml|4k"
  bash /tmp/combiner-probe.sh` dumps the rows of any query instead of
  stopping at the checks (the dump waits out the debounce and any in-flight
  async source, so a calc-only query shows its row). `LIVE=1` adds the bang
  preview's own settled path — the fetched row replacing the bang's sync row —
  so that run needs the network.
- `sources/` — `apps.ts` (GioUnix.DesktopAppInfo app search + eager index, the
  file rows a typed FILE adds, and `fileTypeAt` — the ONE file-type stat helper,
  shared with the path source and the `!p`/`!a` bangs), `bangs.ts` (the bang
  DISPATCH: the catalogue and the pure value shapes live in
  `sources/bang-token.ts` and `sources/text-tools.ts`), `calc.ts` (the curated
  conversion rows + qalc), `time.ts`,
  `paths.ts` (a typed path → the `Open — <path>` row, the create rows for a path
  that is not there yet, + the file rows below),
  `urls.ts` (a typed URL or a `site:` shortcut → one `Open — <url>` row).
  - `units.ts` — the curated unit table and conversion grammar (temperature,
    length, mass, volume, data size, data rate, speed, time, energy, power,
    pressure, force, frequency, torque, typography, acceleration, numerals and
    the transfer-rate / kitchen / aspect-ratio composites): pure, no gi, and
    the module that answers a conversion on the keystroke without spawning
    anything (see "Unit conversions"). Its probe is
    `units.probe.ts` (`ags bundle --gtk 4 apps/launcher/sources/units.probe.ts
    /tmp/units-probe.sh && bash /tmp/units-probe.sh` — a plain-Node run cannot
    resolve the `@common/text` alias the module imports).
  - `exec-fields.ts` — the freedesktop Exec field-code expansion (`%f`/`%F`,
    `%u`/`%U`, `%c`, `%k`, `%i`, `%%`), pure, no gi: the launcher parses an
    entry's Exec to argv and this module expands the codes against the launch,
    so a placeholder never reaches an app as literal text and a launch that
    carries no file OMITS the file codes instead of passing an empty argument.
    `exec-fields.probe.ts` is its probe:
    `node --experimental-strip-types apps/launcher/sources/exec-fields.probe.ts`.
  - `bang-token.ts` — the bang catalogue plus the token grammar: the ONE owner
    of what a typed token names, which bangs take a path, and how a catalogue
    hint rewrites the entry (pure, no gi). `bang-token.probe.ts` is its probe:
    `node --experimental-strip-types apps/launcher/sources/bang-token.probe.ts`.
  - `bang-preview.ts` — the pure half of a bang PREVIEW: the endpoint URL each
    enriched bang asks and the parser that turns the payload into rows (no gi),
    so its probe shapes live response bodies without a socket. Which bang opts
    into which source is declared on its own catalogue entry in `bang-token.ts`.
  - `bang-preview-fetch.ts` — the transport half of a preview: the in-process
    `Soup-3.0` session, the per-query cancellable, the TTL cache and the
    payload→row mapping. `bang-preview.probe.ts` is the probe of both:
    `ags bundle --gtk 4 apps/launcher/sources/bang-preview.probe.ts
    /tmp/bang-preview-probe.sh && bash /tmp/bang-preview-probe.sh` (the
    fixtures; `LIVE=1 bash /tmp/bang-preview-probe.sh` adds the five live
    endpoints).
  - `row-caps.ts` — the card width budget and the PER-KIND row height: the
    per-character caps, `textBudget`/`capChars`, and how many description lines
    a row of each kind may use (one for every ordinary row, four for a preview
    row). `row-caps.probe.ts` measures it on real GTK labels (no window is
    mapped): `ags bundle --gtk 4 apps/launcher/row-caps.probe.ts
    /tmp/row-caps-probe.sh && bash /tmp/row-caps-probe.sh`.
  - `text-tools.ts` — the pure value shapes a bang or a BARE typed query answers
    from: base64, percent encoding, JSON, colour codes, cron, JWT, instants,
    the port table and `SITE` (one canonical query URL per site, shared by the
    bang of that name and the `site:` form of the URL source). No gi, no
    subprocess: `shapeRows()` (a colour code, a JWT, an IPv4 address or CIDR
    block) and the text/data bangs all read it. `text-tools.probe.ts` is its
    probe: `node --experimental-strip-types
    apps/launcher/sources/text-tools.probe.ts`.
  - The shared matcher is `common/text.ts`, imported directly.
- `emoji.ts` — the launcher's side of the shared emoji layer: builds the ONE
  emoji result row, reads the insertion settings from the launcher config, and
  wraps the pick/insert calls (see "Emoji mode").
- `emoji-style.ts` — the emoji-mode dynamic tokens (glyph size, cell
  hover/selection, lead colour) from `config.grid.*` / `config.appearance.*`.
- `commands.ts` — request handlers (prefixed `["launcher", …]`).
- `config.ts` — owns the app's config store + facade (`createConfigStore`
  via `common/config/facade.ts`).
- `types.ts` — shared `Result` types; every source returns `Result[]`
  (`emojiEntries` marks the emoji row for the grid).
- `log.ts` — the `[launcher]`-tagged logger (`createLogger`).
- `prime-run*.png` — prime-run button icons, resolved through `treeRoot()`
  (`common/path/tree-root.ts`): they live in the tree, not in `~/.config`.

### The shared emoji layer (`common/emoji/*`)

The emoji table, search, usage store and insertion path are surface-agnostic
modules (`common/emoji/`) — the launcher is their only surface today:

- `data.ts` — the emoji table (1,172 curated Emoji 17.0 entries, CLDR short
  names + keywords; flags and VS16 variants, no ZWJ/skintone). The SINGLE
  owner of emoji data.
- `search.ts` — `searchEntries` / `recentEntries` / `topEntries` / `entryFor`
  / `tableSize`; name×10 + keywords ranked by `@common/text` (the
  shared matcher), colons stripped (`:joy:` searches the same terms).
- `recency.ts` — the usage store (`~/.local/state/tinshell/apps/emoji/state.json`
  via `@common/state`; `recentGlyphs` / `topGlyphs` / `recordGlyph`).
  The store id stays `emoji` so the history outlives the surface's move into
  the launcher — this module keeps the ONLY access to that path.
- `insert-plan.ts` — the PURE insertion ladder (no gi imports; the fallback
  logic + literal argv builders).
- `insert-plan.probe.ts` — its reproducible probe (stub injector):
  `node --experimental-strip-types common/emoji/insert-plan.probe.ts`.
- `insert.ts` — the runtime glue: `beginPick()` captures the focused window,
  the injection is scheduled after the surface hides, the target is
  re-probed, the pre-pick clipboard is restored (guarded), then the ladder
  runs. It reads NO config — the caller passes `InsertSettings`.

## Config

The launcher's OWN config trio (`apps/launcher/config.{defaults,schema,json}`)
via its facade (`launcher/config.ts`):

| Section | Purpose |
| --- | --- |
| `window` | popup geometry (width/height), card theming |
| `listHeight` | rows the card shows before the list SCROLLS (default 5) |
| `sources` | which sources are enabled (incl. `units`, `emoji`) |
| `calc` | qalc integration (command, live flag) |
| `currency` | currency conversion (qalc) |
| `bangs` | search URLs, browsers |
| `grid` | emoji grid shape (`columns`, `glyphSize`, `visibleRows` — the visible-row cap; the search itself is uncapped and the grid scrolls) |
| `insert` | emoji insertion (`mode`/`typer`/`delayMs`/`restoreClipboard`/`restoreDelayMs`/`terminalClasses`) |
| `recents` | emoji usage store (`max` map cap, `limit` empty-query strip) |
| `appearance` | emoji-mode tokens (`accentColour`, `selectionColour`, `hoverColour`) |

## Command surface

All registered PREFIXED (`["launcher", …]`) — same paths in shell and island:

| Path | Purpose |
| --- | --- |
| `launcher toggle/show/hide` | open/close the popup |
| `launcher emoji` | the emoji keybind contract (see "Emoji mode") |
| `launcher emoji-insert <glyph>` | insert without the row/grid (live + debug entry) |
| `launcher emoji-debug` | emoji introspection JSON (table size, mode, typer, grid, recents) |
| `launcher apps reload` | re-index desktop apps (eager at startup) |
| `launcher debug` / `launcher debug activate` | debug surface / activate a specific entry |
| `launcher debug entry` | the entry's own text, cursor and the ghost range a Tab completion selected |
| `launcher debug scroll <wheel\|surface\|status> <delta> [list\|grid]` | drive or read one row surface's scroll: apply a decision, or report without moving. Neither surface has a tail to start — a released gesture's momentum is the scroller's own kinetic scrolling — so a `surface` delta answers `consumed:false`, the hand-over itself |
| `launcher debug preview` | the bang previews' record: what each fetched, and the reason it produced no rows |
| `launcher debug query <query>` | run one query through the live combiner with the card HIDDEN and answer the rows it settles on |
| `launcher config get/set/reload` | live config via facade |

The `debug` node carries NO handler of its own: a handler on a namespace node
intercepts its own children (dispatch takes the first node it finds with a
handler), so a `debug` catch-all would shadow `debug activate`, `debug preview`
and `debug query`. Bare `debug` therefore falls through to the registry's own
subcommand list.

## Query handling

`Combiner.queryDidChange` decides which sources a query runs:

- an ordinary query runs applications + bangs + time + unit conversions + the
  bare typed shapes (sync) and calc (async, gated on `looksLikeMath`);
- a leading `!` makes it a bang query (time/emoji/calc suppressed);
- emoji mode (mod+. or a leading `:`) suppresses every other source for every
  query;
- a PATH-SHAPED query — one starting with `/`, `~`, `./` or `../`
  (`isPathShaped`, `common/path/complete`) — runs the
  path source ONLY: apps, bangs, time, calc and emoji are suppressed, so a
  typed directory produces one row and no app-search noise. A typed FILE adds
  the file rows the SAME source returns (see "App rows and Exec field codes").
  A bare word is not a path even when a directory of that name exists (that
  would hijack ordinary app searches).
- a URL-SHAPED query — one starting with an explicit `[a-zA-Z][a-zA-Z0-9+.-]*:`
  scheme followed by something non-empty — runs the URL source ONLY, the same
  suppression. A bare domain (`example.com`) is not a URL: the app search and
  the `!f`/`!c` bangs own that shape.

`shapeRows(input)` in `sources/text-tools.ts` is the pure side of a BARE typed
query that names a value rather than a word: a colour code spelled as one
(`#ff0000`, `rgb(…)`), a JWT (three dot-separated segments whose first two
decode to JSON objects — the decode is the test) and an IPv4 address or CIDR
block (scope, integer/hex/binary, network/broadcast/mask/host count). It returns
`{title, description, copy}` rows and is asserted by `text-tools.probe.ts`;
`combiner.ts` maps them into the `calc` category (`pending.shapes`, one row,
Enter copies the value). The rows join the implicit-calc gate
(`pending.shapes.length === 0`), so a CIDR — which carries a `/` — answers as a
shape and never also reaches qalc. Deliberately excluded from it: bare numbers
(qalc and the unit table own them), bare cron expressions (`looksLikeMath`
sends them to qalc) and base64-looking words (no safe test) — those stay bangs
(`!epoch`, `!cron`, `!b64d`), where they belong.

The percent-of shape gets its answer from qalc, but not from the text as typed:
qalc reads `%` as a remainder operator, so `15% of 200` parses as
`rem(15, 1 B)` and exits non-zero. In that one shape the word `of` is a
multiplication, so `combiner.ts` rewrites it before the debounced kickoff — the
row reads `30`, with the rewritten expression (`15% * 200`) as its description.
Every other query reaches qalc exactly as typed.

## Unit conversions

`sources/units.ts` owns the conversion table and grammar; `sources/calc.ts`'s
`unitRows()` turns its rows into launcher rows (category `calc`, Enter copies
the title, the qualifier line is the description). The table is pure and
subprocess-free, so a conversion answers on the keystroke, and the source is
gated by `sources.units` (default true).

| Shape | Examples | Rows |
| --- | --- | --- |
| `<amount> <unit>` | `20C`, `5 mi`, `100 km/h`, `1 stick` | one per companion unit |
| `<amount> <unit> SEP <unit>` | `20C to f`, `100 km to mi`, `2 tbsp -> tsp`, `100 m = ft` | one |
| literal / numeral | `0xff`, `0b1011 to dec`, `255 in hex`, `2026 in roman`, `MMXXVI`, `65 to char` | one per companion base |
| `<amount> <data unit> in <amount> <time unit>` | `500 MB in 30 s`, `4 GB in 1 h` | one (the transfer rate) |
| `<volume unit> <ingredient>` (or reversed) | `1 cup flour to g`, `2 cups flour`, `500 g butter to cup` | one, or one per mass companion |
| `<width>x<height>` | `1920x1080`, `3840x2160` | one (the reduced ratio) |

An `<amount>` is a decimal, an exponent form (`2.5e3`), a grouped thousand
(`1,000`), a fraction or a mixed number (`1/2 cup`, `2 1/2 cups`). A comma that
is not a thousands group names no amount, so `1,5` is not 15.

`SEP` is one of `to`, `into`, `in`, `as`, `=`, `->`, `→`. Separators are scanned
word by word and accepted only where the left side parses as `<amount> <unit>`,
so `100 in to cm` reads the first `in` as inch and `to` as the separator.

**A bare amount answers SI first.** `<amount> <unit>` lists its companions with
the SI answer on the FIRST row and the imperial one underneath (`100 km/h` →
`= 27.7778 m/s`, then `= 62.1371 mph`; `20C` → `= 293.15 K`, then `= 68 °F`),
because metric is the system in use; a NAMED target (`100 km/h to mph`) yields
that one row and nothing else.

**Cooking measures are metric.** `cup`, `tbsp` and `tsp` mean the Canadian
metric measures — 250 mL, 15 mL, 5 mL — and the US customary ones are spelled
with an explicit `us ` prefix (`us cup` 236.588 mL, `us tbsp` 14.7868 mL, `us tsp`
4.92892 mL; the prefix is a multi-word unit token, so `2 us cups to ml` parses
like `2 fl oz to ml`). Every row NAMES the convention it answered in —
`1 cup = 250 mL  ·  metric (Canadian)`, `1 US cup = 236.588 mL  ·  US customary`
— and a row crossing the two names both, source side first
(`1 cup to us cup` → `·  metric (Canadian)  ·  US customary`). The heavier US
measures (`fl oz`, `pint`, `qt`, `gal`) keep their own names and take the same
`us ` prefix as an alias (`1 us gal to l`), because the kitchen has no metric
counterpart for them. The imperial (UK) measures are separate units under their
own prefix and note (`imp gal` 4.54609 L, `imp pint` 568.261 mL, `imp fl oz`
28.4131 mL), and a US butter `stick` is the US measure it is sold in: half a US
cup (118.294 mL), noted as such.

| Family | Units | Base |
| --- | --- | --- |
| temperature | `°C` `°F` `K` | affine, through degrees Celsius |
| length | mm cm m km in ft yd mi nmi µm nm au ly | metre |
| mass | mg g kg t ton (the short ton) long ton lb oz st µg ct gr slug | kilogram |
| volume | mL L tsp tbsp cup (metric cooking), US tsp US tbsp US cup fl oz pint qt gal stick (US customary), imp gal imp pint imp fl oz (imperial) | litre |
| data size | bit kbit Mbit Gbit B KB MB GB TB PB KiB MiB GiB TiB PiB | byte |
| data rate | bit/s kbit/s Mbit/s Gbit/s B/s kB/s MB/s GB/s TB/s | byte per second |
| speed | m/s km/h mph kn ft/s | metre per second |
| time | ns µs ms s min h d wk fortnight yr decade century | second |
| energy | J kJ MJ cal kcal Wh kWh BTU therm eV | joule |
| power | W kW MW hp PS BTU/h | watt |
| pressure | Pa hPa kPa MPa bar mbar atm psi torr mmHg inHg | pascal |
| force | N kN dyn lbf kgf | newton |
| frequency | Hz kHz MHz GHz THz rpm | hertz |
| torque | N·m ft·lb in·lb kgf·m | newton metre |
| typography | px pt pc | CSS pixel |
| acceleration | m/s² ft/s² g | metre per second squared |

Factors are the exact definitions where one exists (1 in = 25.4 mm, 1 lb =
0.45359237 kg, 1 US gal = 231 in³, IEC 1024-prefixes, °F = 1.8·°C + 32, K =
°C + 273.15; the metric cooking measures are 1 cup = 250 mL, 1 tbsp = 15 mL,
1 tsp = 5 mL; the calorie is the thermochemical 4.184 J and the BTU the IT
1055.05585262 J; 1 hp = 550 ft·lbf/s and 1 PS = 75 kgf·m/s; 1 psi = 1 lbf/in²;
1 AU = 149597870700 m and 1 ly = that value × the Julian year; 1 px = 1/96 in
and 1 pt = 1/72 in; 1 g₀ = 9.80665 m/s²). A row's description is the rate line
(`1 km = 0.621371 mi`), the third scale for a temperature (`20 °C = 68 °F`
carries `= 293.15 K`), or the convention note of the units the row touches.
Results print exact integers and six significant digits otherwise, so
`1 TiB = 1099511627776 B` stays exact while `20 °C = 68 °F` never reads as
`68.00000000000001`.

**A bare `ton` is the short ton** (2000 lb, `907.185 kg`, noted `US customary
(2000 lb)`); `tonne`/`t` stay the metric tonne and `long ton`/`imperial ton`
the 2240 lb one. **A bare `year` is the Julian year** (365.25 d, noted), the
unit every astronomical definition is stated in.

**Spellings.** `<amount><unit>` with or without a space (`20C`, `20 c`), every
degree form (`20 °C`, `20°C`, `20 degC`, `20 degrees C`), plurals (a trailing
`s` is dropped when the rest resolves), and abbreviations or dropped letters
resolved through the shared `common/text` matcher (`cel`, `kilometr`,
`miligram`) above a score floor. A spelling TWO units share names NEITHER (so
`b`/`B` and `Mbps`/`MBps` are decided by case alone), and a fuzzy score tie is
broken by the tighter name — `kilometr` is `kilometre` (km), not `kilometre/h`.
A spelling carrying a DIGIT or a superscript is a symbol, not a word: it
resolves exactly and never through the fuzzy pass, so `m/s2` and `m/s²` name
the acceleration while `m2` and `m²` name nothing at all (area is qalc's
business, and a squared spelling must never be read as the linear unit plus a
stray character).

**Four spellings are settled by CONTEXT**, because another unit owns them
outright: a bare `k` names no unit at all — `4k` and `10k` read as thousand and
produce NO row (a 4K display or a 10K run is an ordinary search, and a `4k =
4000` row would be noise under it) — and is KELVIN exactly where the query says
temperature: the word `kelvin`, a degree-marked `°K`/`degK`, or a temperature
scale on the other side of the separator (`100k to c`, `5 K to C`, `100c to k`).
The same rule settles `g`, `pt`, `nm` and `kn`: `g` is the gram unless the other
side is an acceleration unit (`1 g to m/s2` → `9.80665 m/s²`, `1 g` →
`1000 mg`), `pt` is the pint unless the other side is a typographic unit
(`12 pt to px` → `16 px`, `1 pt to ml` → `473.176 mL`), `nm` is the nanometre
unless the other side is a torque unit (`10 Nm to ftlb`), and `kn` is the knot
unless the other side is a force (`1 kn to n` → `1000 N`, `1 kn to km/h` →
`1.852 km/h`). A context spelling beside a target of the OTHER family names
nothing, so neither reading can hijack the other.

**Numerals.** `0x…`/`0o…`/`0b…` literals convert in either direction, `roman` is
accepted as a target (`2026 in roman` → `MMXXVI`) and uppercase `[IVXLCDM]` is
read as a numeral on its own. Roman is strict standard notation in 1..3999,
validated by re-encoding the parsed value, so `IIII`, `VX` and `IM` name
nothing; lowercase stays a word (`mix` is not 1009). `char`/`ascii`/`unicode` is
a target too (`65 to char` → `A`), and a code point with no printable character
(a control, or the surrogate range) names nothing. Each numeral row lists the
other representations in its description (`2026 in roman` →
`2026 · 0x7ea · 0b11111101010`).

**Composites.** Three practical shapes beyond a unit pair. A transfer rate:
`<amount> <data unit> in|per|over|/ <amount> <time unit>` → `500 MB in 30 s =
16.6667 MB/s`, stated on the side the data unit was typed on (a bit size gives
a bit rate) and in the largest prefix the number still reaches 1 in, with the
other side of the 8-bit byte as the description. A kitchen measure:
`<volume unit> <ingredient>` reads the ingredient's chart mass per US cup
(flour 125 g, granulated sugar 200 g, water 236.588 g, butter 226.8 g, packed
brown sugar 220 g, honey 340 g, oil 218 g, uncooked rice 185 g, rolled oats
90 g, milk 245 g) and answers in grams — `1 cup flour to g` → `132.086 g` for
the metric cup, `1 US cup flour to g` → `125 g` — with `to <mass unit>` naming
one target, the reverse (`500 g flour to us cup` → `4 US cup`) reading the same
chart, and a same-family target (`1 cup flour to ml`) staying an ordinary
conversion. An aspect ratio: `1920x1080` → `16:9` (both sides at least three
digits, so `2x4` is not one).

**The photon relation is the ONE family crossing the table makes:** a length
unit and a frequency unit name the same photon through λ·f = c, so
`700 nm to THz` → `428.275 THz` and `1 THz to nm` → `299792 nm`. It needs a
named target — a bare wavelength answers its own family's companions.

Anything the table does not parse yields no row and falls through to qalc, which
stays the answer for arithmetic, constants, currency, and unit pairs the table
omits. The reverse also holds: once the table produced rows, the combiner
suppresses implicit qalc, so a conversion is one row and never two.

## App rows and Exec field codes

An app row launches the entry, never a bare `app.launch([])`: the row builds a
command from the entry (`sources/apps.ts`) and hands it to the pinned launch
(`common/hyprland/dispatch`, PID-scoped initial workspace). The Exec is parsed
to argv with `GLib.shell_parse_argv`, its field codes are expanded by
`sources/exec-fields.ts`, and every resulting argument is shell-quoted
(`common/subprocess/quote`) into ONE command line — the pinned launch runs that
string through `sh -c` (`hl.dsp.exec_cmd`), so a path with a space or a name
carrying `$`, a backtick or a quote is delivered to the app as one argument
exactly as typed. A filename that begins with `-` is still an option to the
app itself: that is inherent to passing argv, not a shell artefact. The quoting
is also what the Lua dispatch layer must preserve: the command becomes a Lua
string literal (`common/hyprland/lua-string`) before it reaches the compositor,
and the shell quotes have to come back out of the Lua parser byte for byte.
When an entry declares no runnable Exec at all, the row falls back to GLib's own
launch, which expands the codes itself.

| Code | Expands to | Launch carries none |
| --- | --- | --- |
| `%f` / `%F` | the launch's file / every file | the code is OMITTED (never an empty argument) |
| `%u` / `%U` | the launch's URL / every URL (a file launch passes its URI) | omitted |
| `%c` | the entry's name | omitted |
| `%k` | the entry's `.desktop` path | omitted |
| `%i` | `--icon <the entry's themed icon>`, as two arguments | omitted |
| `%%` | a literal `%` | — |
| `%d %D %n %N %v %m` (deprecated) and any unknown code | nothing | the code is dropped |

A deprecated or unknown code is dropped rather than passed through as text, and
`%%` is never re-read as a placeholder (`%%f` is the literal `%f`).

**The file rows.** An APP ROW carries no file — the app search has no launch
context — so the file codes are omitted for it. The launcher's ONE launch
context with a file is a typed path: for an existing FILE, `fileRows()` in
`sources/apps.ts` also returns one `Open with <app>` row per visible entry whose
Exec declares a file placeholder (`GAppInfo.supports_files()` — `%f`/`%F`),
carrying the resolved path, so an app that needs a file (TINSHELL Annotate) is
reachable from the launcher with the file it needs. Those rows are ordered by
relevance to the file — the entries that declare its content type first, then
the entries that declare no type at all (they accept any file), then the rest —
and the list SCROLLS rather than capping (see "Scrolling the result list"), so
a typed file shows `Open — <path>` followed by every entry that declares a file
placeholder — ordered by relevance to the file. They are ordinary app rows (`category: "app"`): Enter launches,
the prime-run button and Shift+Enter float behave as on any app row, and they
rank BELOW the `Open — <path>` row, which keeps priority 0 and stays the first,
auto-selected row — Enter on a typed path behaves exactly as `xdg-open`. A
DIRECTORY stays one row: the file rows need a file.

## Paths and URLs

`sources/paths.ts` resolves a path-shaped query with `resolvePath`
(tilde expansion) + `GLib.canonicalize_filename` (absolute form), and offers
ONE row — `Open — <path>` — when the resolved path exists (file or directory);
a path nothing is at yet offers the create rows instead (see "Shortcut schemes
and create rows"). The row's DESCRIPTION names the application the desktop associates
with the type — `inode/directory` for a directory, the path's own
`standard::content-type` (one `query_info`) for a file — resolved through
`Gio.AppInfo.get_default_for_type(type, false)` (`mustSupportUris` FALSE: the
path is opened locally, and an entry with no URI support still owns its type
for a file). A type nothing handles says `no application handles <type>`
(`directories` for a directory); an unavailable lookup keeps the generic `open
with the default application` / `open with the file manager`. Enter spawns
`xdg-open <path>` (argv form) — ONE process, whose handler the DESKTOP decides,
so the launcher names no application and imports no other app's modules — and
closes the launcher. Tab path autofill covers a path query the same way it
covers `!p`/`!code`/`!a` (see the `pathAutofill` extract in `Launcher.tsx`).

A FILE also brings the rows of the entries that declare a file placeholder,
each carrying the path ("App rows and Exec field codes"); a DIRECTORY does not
— it stays this one row.

`sources/urls.ts` offers ONE row — `Open — <url>`, icon `insert-link` — for a
query carrying an explicit scheme, or for one of the launcher's own `site:`
shortcuts (see "Shortcut schemes and create rows"). Its description names the handler
`Gio.AppInfo.get_default_for_uri_scheme(scheme)` resolves (http/https/mailto →
the browser), or says `no application handles the <scheme> scheme` when the
lookup is null; a lookup failure keeps the generic `open with the default
application`. Enter spawns `xdg-open <url>` (argv form) and closes the
launcher. Neither source throws: a failed lookup costs the handler name, never
the row.

Both rows come from `sources/xdg-row.ts` — ONE `Open — <target>` builder (the
argv-form `xdg-open` spawn with its spawn-budget timeout, the non-zero-exit log
line, hide-after-opening) shared by the two sources. The icon, the category and
the description each source passes are the only per-bang parts; the spawn rule
itself exists once.

### Shortcut schemes and create rows

Nine `scheme:` queries are answered by the launcher itself instead of being
handed to the desktop, because the thing left of the colon is a habit rather
than a URI scheme: `gh:`, `wiki:`, `aw:`, `yt:`, `pac:`, `aur:`, `def:`, `g:`
and nothing else. Each rewrites the typed argument into the real URL through
the shared `SITE` table in `sources/text-tools.ts` — the SAME builder the bang
of that name uses (`!gh` and `gh:` cannot disagree about GitHub's query URL) —
and the row then opens the real `https` URL, so `xdg-open` never sees a scheme
nobody implements. The description still names the handler the desktop
resolves. `isUrlQuery` claims these schemes in addition to the real URI schemes
and the schemes with a live handler; `note: buy milk` is still a label, not a
URL.

A path-shaped query whose path does NOT exist offers two CREATE rows instead of
nothing: `Create directory — <path>` and `Create file — <path>`, ordered by
what the typed name looks like (a trailing `/` or a dotless basename reads as a
directory; a basename with an extension reads as a file). Creating is an
in-process Gio call and the open goes through the shared `xdgOpenRow` spawn, so
Enter costs one child process. The rule is deliberately narrow: the PARENT must
already be an existing directory, so a typo cannot create a tree, and a `*`/`?`
pattern is a completion query rather than a create request.

### Tab autofill

`createPathAutofill` (`common/path/autofill.ts`) owns the Tab cycle; the
launcher wires it in `Launcher.tsx` and renders its ghost as a selection. The
entry text is `committed + ghost`: Tab fills the next candidate into the ghost
half, Shift+Tab cycles back, Right Arrow locks the ghost in as committed text.
`!p <path>`, `!code <path>` and `!a <path>` run the same cycle behind the bang
prefix — an abbreviated token included, so `!co ~/x` completes exactly like
`!code ~/x` (a token's spelling never gates its argument). That prefix stays
committed text. The completion is active only when the text is
path-shaped, and that gate is the shared `isPathShaped`
(`common/path/complete.ts`) — the launcher keeps no private path-shape copy,
so it cannot drift from promptd's input dialog, which gates on the same rule.

A typed path whose BASENAME carries `*` or `?` is a PATTERN query
(`isGlobQuery` in `common/path/complete.ts`) and narrows the completion
candidates instead of producing result rows:

- Candidates are the entries of the pattern's parent directory whose basename
  matches, matched by `GPatternSpec` — `*` and `?` are the supported
  metacharacters, case-sensitively; bracket classes and brace expansion are
  not, and the pattern is never expanded by a shell. ONE directory level: the
  segments before the last `/` are a literal directory name, so
  `notes/*/README.md` (a wildcard in a directory segment) yields no
  candidates, and neither does a pattern
  followed by a trailing separator.
- NEWEST FIRST (mtime, name as the tie-break), so the file just downloaded is
  the first Tab.
- Hidden entries are excluded unless the pattern's basename itself starts with
  a dot (`~/.config/.*`).
- Capped at `GLOB_MAX_RESULTS` (50). Matches beyond the cap are neither cycled
  nor reported: the card carries no status line, so the cap is silent.
- The ghost is a REPLACE-PREVIEW: the whole matched path, not a remainder,
  because a candidate does not extend a pattern. GTK keeps the caret (the
  filename end) visible, so a long path clips on the left. Prefix queries keep
  the append-remainder ghost.
- The pattern stays the cycle's base for as long as it cycles: Tab previews
  the matches, Right Arrow commits the preview as a literal path — at which
  point the path source offers its normal row for it.
- The directory is enumerated on Tab only, never per keystroke.

## Bangs

Every bang is declared ONCE in `sources/bang-token.ts` (`BANG_CATALOGUE`, 39
entries), and the entry owns three things at the same time: the hint row, the
token grammar (see below) and the row the bang produces. An entry may also
OPT INTO a preview (`enrich`, see "Previewed bangs"). An entry declares at
most one PURE builder:

- `url(arg, env)` — the row opens that URL through the desktop's own handler.
  The row is `sources/xdg-row.ts`'s `Open — <target>` builder (a custom `title`,
  so it reads `Wikipedia: hyprland`), i.e. the SAME one-spawn implementation
  the path and URL sources use.
- `compute(arg, env)` — the row shows a value built in-process; Enter copies
  `copy`. A value with no `copy` is a REFUSAL row (Enter keeps the card open).
  No subprocess runs.
- `spawn(arg, env)` — the row runs that argv; the spawn happens once, on Enter.

A builder answers `null` when its argument names nothing it can serve, which is
how a bang with a required argument shows no row until one is typed. Adding a
bang is therefore one catalogue entry: no branch in `sources/bangs.ts`, and the
hint cannot promise a command the dispatch does not know.

`BangEnv` is the only platform surface a builder may touch — the TINSHELL home, the
two configured browser commands, the configured search URL, GLib's checksum,
GLib's UUID generator and the `/etc/services` table. `bangs.ts` supplies it per
dispatch (the config values are read live, so a config change is never frozen
into a cached object); the `/etc/services` parse is kept for the session
because the file is 300 KB and does not change. The pure value shapes
themselves live in `sources/text-tools.ts` — base64, percent encoding, JSON,
colour codes, cron, JWT, instants, the port table and `SITE` (one canonical
query URL per site, shared by the bang and the `scheme:` form of the URL
source).

### The catalogue

Web search and site search: `!f`/`!c` (Firefox/Chromium,
`bangs.browserFirefox` / `bangs.browserChromium`), `!g` (the DEFAULT browser,
through `xdg-open` and `bangs.searchUrl`), `!fp` (Firefox private window),
`!ci` (Chromium incognito), `!wiki`, `!aw` (Arch Wiki), `!gh` (GitHub —
`owner/repo` opens the repository, anything else searches), `!yt`, `!def`
(Wiktionary), `!tr <text> [to <lang>]` (Google Translate; English unless a
trailing `to <code>` names a language).

Packages and pages: `!pac` (Arch package search), `!aur` (AUR search),
`!man <page>` (opens `man` in the session terminal, `kitty --single-instance`),
`!port <n>` (names the services `/etc/services` declares for a port).
`!def <word…>` is GREEDY — see "`!def` takes a greedy argument" below.

The desktop: `!grab` (the Print-key capture pipeline,
`common/shell/ensure-screengrab.sh`), `!pick` (`hyprpicker -a` — the picked
colour goes to the clipboard), `!kill <name>` (`pkill -TERM -x`, exact process
name only —
never `-f`, which would match any command line, and never a compositor window
close, which the house forbids because an unresolvable address closes the
FOCUSED window), `!mixer` (`pavucontrol`).

The clipboard picker has NO bang: it stays reachable through its own keybind
(mod+SHIFT+V in `hyprland.lua`) and the router path
(`common/shell/tinshell-route.sh clipboard toggle`, map row `clipboard=shell,clipboard`),
which is what the retired `!clip` bang spawned. Removing the bang therefore
changed three tokens and nothing else: `!c` is still the Chromium search (exact
spelling), while `!cl` and `!cli` name nothing and show the full hint list,
because no bang starts with `!cl`. `bang-token.probe.ts` asserts that removal, so a
future catalogue edit cannot resurrect the token by accident; adding a bang that
starts with `!cl` would deliberately have to revisit it.

Text and data: `!b64`/`!b64d`, `!enc`/`!dec`, `!json`, `!rgb`, `!cron`, `!jwt`,
`!epoch`, `!sha`, `!md5`, `!uuid`, `!wc`, `!cc`. Every one of these computes
in-process and copies on Enter.

App-owned and interpreter: `!n` (note), `!p` (media), `!code` (VS Code), `!a`
(annotate), `!q` (qalc) and `!py` (python) — detailed below, and the three
path-taking bangs keep `pathArg: true` as the ONE declaration of that fact.

**Token ambiguity is visible, not silent.** Adding `!wiki` made `!w` a prefix
of two entries, so `!w` now names NOTHING and the card shows both `!wiki` and
`!wc` hint rows; `!b64` stays exact even though `!b64d` starts with it, and
`!co` is still `!code`.

### Previewed bangs

Five catalogue entries declare `enrich`: `!wiki`, `!aw`, `!def`, `!pac` and
`!aur`. Such a bang shows its own URL row as always and a fetched payload
REPLACES that row when it lands — the row keeps its title and its Enter target,
so the bang's identity and what Enter does are unchanged, and only the
description carries the payload. When the payload naturally has several items
(dictionary senses, package hits) those become rows BENEATH the enriched row,
and Enter on any of them opens the browser at that item. A bang without
`enrich` keeps the row its own builder produces: `!g` (the DuckDuckGo Instant
Answer API answers only some queries), `!tr` and `!yt` have no dependable
keyless source, and the browser-specific searches each exist to open one
browser.

| Bang | Request | Rows |
| --- | --- | --- |
| `!wiki` | `en.wikipedia.org/w/api.php`: `generator=search` + `exintro` (ONE request) | the hit whose title names the query, then the other related hits |
| `!aw` | `wiki.archlinux.org/api.php`: `list=search`, then that article's `rvsection=0` revision | the article title and its lead paragraph |
| `!def` | `en.wiktionary.org/api/rest_v1/page/definition/<word>`, then Datamuse `rel_syn` | one row per part of speech, then the synonyms |
| `!pac` | `archlinux.org/packages/search/json/?q=` | the exact package (with the version installed here), then the other hits |
| `!aur` | `aur.archlinux.org/rpc/v5/info?arg[]=` | the exactly-named package |
| `!g` | `api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=` | the instant answer (abstract, answer or definition), then its related topics; an EMPTY answer falls back to the title-guarded Wikipedia search |
| `!tr` | `translate.googleapis.com/translate_a/single?client=gtx` | the translated text |
| `!yt` | `www.youtube.com/results?search_query=` | the first videos found on the results page |

The Arch Wiki serves neither a page-summary handler nor `prop=extracts`, so its
lead comes from that section's wikitext (`rvsection=0`, which is 905 B for
`Greetd` against 17 KB for the whole page) with templates, categories, links
and emphasis stripped out.

**Every Wikipedia hit is checked against the query before it becomes a row, by a
WORD-WISE relevance test** — a confidently wrong answer is worse than no preview,
and `greetd`'s top hit is the page `Phosh`. The test compares the title's
significant words (case-folded, split on non-alphanumerics, stopwords and
one-character words dropped) with the query's, scoring `recall` (the share of the
query the title covers) and `cover` (the share of the title the query names),
over the title's NAME and over its disambiguating parenthetical separately. A hit
qualifies when `max(recall, cover)` reaches `TITLE_MATCH_THRESHOLD` (0.5); two
words match when they are equal or when the shorter — at least four characters —
is a prefix of the longer, so plurals and typos still match. `Spiracle
(arthropods)` answers `arthropods` through its parenthetical and `Rust
(programming language)` answers `rust ownership` through its name, while `Phosh`
shares no word with `greetd` and scores zero.

That replaced a FOLDED-SUBSTRING test (lowercase, drop non-alphanumerics, require
one folded string to contain the other), which failed multi-word queries in both
directions: it rejected `rust ownership` (the title carries a parenthetical) and
`kernel linux` (reordered words), while it ACCEPTED the shorter unrelated `Linux`
for `kernel linux` because those letters did sit inside the query. Substring
containment is not the rule anywhere in this path any more; the probe's fixtures
pin the shapes it got wrong, so reintroducing it fails.

A hit whose title names the query but whose `extract` did not come back is
SKIPPED, and the scan takes the next hit that has both: `generator=search` +
`exintro` returned an extract for every mainspace hit measured across the query
matrix, and the whole ranked list is scanned, so the loss window is "no hit at
all has an extract" rather than "the top hit does not". No second request is
staged for it — a re-fetch would add a request for a case the probe never
produced.

`!pac` names both versions because the repository and the local pacman database
can differ, and reads the local one from `/var/lib/pacman/local` rather than
spawning `pacman`.

The mechanism is `Soup-3.0` in process: no subprocess, so a preview spends no
spawn budget, and the fetch rides the async slot calc uses — the same debounce,
the same `onBusy` spinner bracket, the same latest-query guard.
`sources/bang-preview.ts` is the pure half (every endpoint URL and parser);
`sources/bang-preview-fetch.ts` is the transport half, whose session is built
on the first fetch and whose one `Gio.Cancellable` per query cancels a request
a newer query — or `Combiner.cancel()` on hide — superseded.

- The fetch reaches the combiner as a THUNK, so it starts on the SETTLED query
  rather than on each keystroke that scheduled it, and it asks for its batch to
  take the sync row's place (`SourceResponse.replace`) instead of doubling it.
- DEGRADATION is silent: the promise always resolves, and an empty batch is the
  failure answer — offline, a timeout, a non-2xx status, a rate limit or a
  payload that names nothing all leave the bang's own row exactly as it is
  and enter nothing. The card has no status line and shows no error row; the
  reason goes to the log and to `launcher debug preview`.
- **One request's budget is 6 s, MEASURED rather than chosen**: 20 serial
  requests to each of the seven endpoints the five sources call (140 total)
  give a median of 0.65 s, a p95 of 0.93 s and a slowest SUCCESSFUL request of
  5.11 s (the synonym endpoint; the Arch package database is the slowest source
  by median at 0.84 s). 6 s therefore covers every success measured — the old
  3 s cut real answers off — while a genuinely stuck request still gives up.
  What it costs: a dead endpoint holds the spinner for those 6 s, and the
  request is cancelled the moment the query changes.
- **Caching separates an ANSWER from a CONDITION.** Only an answer is cached:
  rows for their source's TTL (article prose 24 h, a package version 1 h) and a
  DEFINITE negative — a 404/410, or a payload that parses to "this names
  nothing" — for 60 s (`DEFINITIVE_NEGATIVE_TTL_MS`). A TRANSIENT failure is
  cached for NOTHING: a timeout, a socket error, a 5xx, a 429 or a body that
  did not parse is a condition the next attempt may well get past, so the same
  query refetches immediately instead of being poisoned for the rest of the
  minute. (`previewTtlFor`/`classifyStatus` in `sources/bang-preview.ts` own
  that split; `bang-preview.probe.ts` asserts it for every source.) Both kinds
  are bounded at 200 entries with an in-flight dedupe — so typing back and
  forth over one word never refetches it.

**One request budget per source class** (`previewTimeoutS`, `sources/bang-preview.ts`) —
the session's timeout is set per request from the source's own class, and the
fetches are sequential, so each request carries its own budget:

| Class | Sources | Budget | Measured |
| --- | --- | --- | --- |
| fast | wiktionary, datamuse, the DuckDuckGo instant answer, gtx | 3 s | 0.09–0.23 s median |
| Wikipedia | the summary search | 4 s | ~0.19 s median |
| Arch | archwiki, Arch packages, AUR | 8 s | up to ~1.0 s, one 10.18 s tail |
| scraped | the YouTube results page | 8 s | 1.38 MB page |

Each class sits well above its own p95, so a slow-but-alive source is never cut
off, and a stuck one still gives up. A timeout, a socket error, a 5xx or a 429 is
TRANSIENT and cached for nothing (the next keystroke retries); only an answer or
a definite negative (404/410, or a payload that names nothing) is cached.

**`!tr` depends on an UNOFFICIAL endpoint.** `translate.googleapis.com/…/client=gtx`
is undocumented, unversioned and rate-limited: every measurement attempt against
this endpoint answered HTTP 429 with the endpoint's HTML abuse page, so the
parser is written against the documented shape and checks every step of it — a
body that is not `[[[translated, …], …], …]` answers nothing, which keeps the
bang's plain row and caches nothing. The bang's own row keeps its target (the Google Translate
page), so Enter is unaffected by the preview failing.

**`!yt` SCRAPES the results page rather than adding a dependency.** `yt-dlp` is
not installed, and making a launcher bang depend on a new machine-wide tool for a
title list is a heavier commitment than reading a page; the page's embedded
`ytInitialData` payload carries the results, so the scan starts at that payload,
walks at most 900 000 characters of it, reads each title from a bounded 4 000
character window after its video id and stops at three entries — no DOM and no
document-wide regex. A page whose shape moves on answers nothing (the plain row
survives) and the answer is cached for a day, so one request per settled query is
the whole cost. The risk is stated plainly: this is scraping an unversioned page
with a browser user agent, and it can break without notice; the fallback is
always today's plain row.

**Every visible character is information, and only these rows are tall.** A
preview row is marked (`Result.preview`) and is the ONE row kind that may take
a FOUR-line description (`row-caps.ts`: `DESC_LINES_PREVIEW`, wrap `WORD_CHAR`,
`ellipsize=END`); every ordinary row — an app, the file rows under a typed path,
an `Open — <path>`/`<url>` row, a catalogue hint, the emoji section — keeps its
single line and its single height, so a launch renders exactly as it did before
previews existed. At the configured width the description line carries
`capChars(textBudget(width), CAP_PX_DESC)` characters (53 at `window.width` 0.3
of a 1440-wide monitor), and that budget is unchanged.

**Four lines is where the CLIP starts binding, which is why it is the budget:**
4 × 53 = 212 characters of capacity against the parsers' `MAX_SUMMARY` of 200
(`sources/bang-preview.ts`) — the row shows the whole fetched summary instead of
a sentence the line count cut in half. Two lines carried 106 and clipped the
payload; a budget above four would raise the clip with it, and nothing past the
clip would ever be read. What the row shows:

- the enriched row's description is the payload alone — the resolved page title
  is NOT repeated in it (the row's own title names the page), and an article
  extract is passed through `proseOf` before the clip, which drops the
  headword's pronunciation and audio glosses (`Arthropods ( AR-thrə-pod) are …`
  → `Arthropods are …`), the citation brackets and a leading hatnote. A real
  parenthetical survives.
- a payload item becomes a row beneath with its own title and summary, so the
  several-hits case (`!wiki`'s other pages, `!pac`'s other packages, `!def`'s
  parts of speech) is readable without opening the browser.

### `!def` takes a greedy argument

`!def` (and its `!df` alias) defines EVERY word typed after the token, each
word becoming its own entry: `!def archaic obsolete` shows a row for `archaic`
and a row for `obsolete`, never one row for the string. The split lives in
`previewArgs` (`sources/bang-preview.ts`) and nowhere else — the fetch, the
cache and the row title all read the units from it.

- **The split**: whitespace, commas and semicolons separate words; each unit is
trimmed of surrounding punctuation (a hyphen INSIDE a word stays —
`well-being`); empty units are dropped; units are de-duplicated
case-insensitively with the first spelling winning (`Archaic archaic` is one
lookup). A pasted sentence therefore does not turn into thirty lookups.
- **The cap is 5 words** (`DEFINE_WORD_CAP`) — the breadth one keypress should
buy, inside one sequential cancellable budget: each word is up to two requests,
and the list scrolls so the rows are readable rather than cut. The overflow is
NOT silent: the first row's description ends `· 5 of 7 words` (`previewWordCount`
answers the typed count, the cap the shown one).
- **The row model.** One word behaves exactly as before: the bang's own row
(`Define: archaic`, enriched in place) carries the first sense, its other
senses follow as rows beneath, and the synonyms row closes the batch — Enter on
the bang's row opens the word's Wiktionary page, Enter on a sense row opens
that sense's anchor. TWO OR THREE words switch to one row per word
(`Define: archaic`, `Define: obsolete`), each carrying its own first sense and
opening that word's page: a greedy argument asks for breadth, and at
the per-word rows stay readable at the viewport and beyond it. The senses
and the synonyms row are reserved for the single-word case. The row that stands
while the fetch runs names the FIRST word (`rowTitle` → `Define: archaic …`).
- **The cache key is PER WORD**: `wiktionary:archaic`, not
`wiktionary:archaic obsolete`, so `!def archaic obsolete` after `!def archaic`
costs one new word. `bang-preview.probe.ts` asserts the key list and that two
arguments sharing a word share that key.
- **Requests are sequential, under this query's ONE cancellable** — up to two
per word, six for three words. Sequential keeps the request rate at what the
sources tolerate (measured: a Wikipedia burst answers 429) and preserves the
typed order; one cancellable is what makes a superseding keystroke cancel the
whole batch rather than its first word. The cost is latency scaling with the
word count, bounded by the cap.
- **Partial failure loses no other word**: a word with no English entry, a 404
or a timed-out request is skipped and the other words' rows still show; when
EVERY word misses, the batch is empty and the bang keeps its own row. This is
where the transient/definitive split matters: a timed-out word is NOT cached,
so the user's next attempt retries it, while a 404 word is cached for the
minute.

## Scrolling the result list

The result list has NO result cap: it shows `config listHeight` rows (default 5)
and SCROLLS the rest, so a source may offer as many rows as it has.

**The viewport.** `.matches` lives in a `Gtk.ScrolledWindow` whose VERTICAL policy
is `AUTOMATIC` and which carries `propagate-natural-height` plus
`max-content-height` = `viewportHeightPx()` = `viewportPixels(listHeight,
rowPitchPx)` (`@common/scroll`). That trio IS the cap, and the policy is what makes
it bind: with `NEVER` a `Gtk.ScrolledWindow` propagates its child's full natural
height (and its minimum) and ignores `max-content-height`, so the card grows to
the height of every row at once — GTK sizes a window from its content, and the
`win.set_size_request` in `animateToContent()` only raises the FLOOR, it cannot
cap what the toplevel asks for. With `AUTOMATIC` the scroller's natural height is
`min(rows' natural, listHeight rows)`, so the shown card is `chrome + the
viewport` for a long list and content-sized for a short one (a two-row result is
not padded out to the cap).

`rowPitchPx` is ONE rendered row's height, read off the first child of the
`.matches` box (`matchesBox` in `Launcher.tsx`). It is not read through the
scroller: `Gtk.ScrolledWindow.get_child()` answers the `GtkViewport` GTK wraps a
non-scrollable child in, whose first child is the row box itself, so measuring
through it answers the WHOLE list's height as "one row" and inflates the cap past
the content's own height — a cap that never binds. A row's allocation exists only
after the card has been mapped, so the first measure of a session falls back to
`ROW_PITCH_FALLBACK_PX` and later ones use the real pitch.

**The controller.** ONE `Gtk.EventControllerScroll` on the scroller, built with
`SCROLL_CONTROLLER_FLAGS` = `VERTICAL | KINETIC` (1 | 8) and **never `DISCRETE`**:
with the DISCRETE flag `get_unit()` always answers `WHEEL`, which would turn every
trackpad into a notched wheel and erase the unit distinction. The unit is read per
event from `get_unit()` (valid for the LAST `::scroll` signal) and the event goes
through `scrollDecision(unit, dy, emojiGridActive())` in `@common/scroll`:

| Input | Decision | Effect |
| --- | --- | --- |
| wheel notch | `selection`, whole steps (`trunc(dy)`) | the SELECTION moves one entry per notch and the viewport animates to it (120 ms), so Enter acts on the row you scrolled to — and the event is CONSUMED, so the scroller's own wheel handling never applies it a second time |
| trackpad | `position`, raw pixels | NOT acted on: `applyScrollEvent` returns FALSE and the event is left to the SCROLLER — its own surface scaling while the fingers are down, then its kinetic scrolling after they lift (below) |
| fractional wheel click | `ignore` | nothing moves, and the event is CONSUMED so the scroller's own path cannot nudge the list either |
| either, emoji grid active | `ignore` | the LIST does not act, and CONSUMES: the list must stay still under the grid |

**Arrows** move exactly one entry (wrapping at the ends, as before) and the view
follows rigidly (`offsetForSelection`); a wheel notch's own move is animated
instead. The position is clamped to `[0, rows − viewport]`.

**The momentum is GTK's own kinetic scrolling.** `Gtk.ScrolledWindow` already
scrolls the way the notes text view does: it runs its own scroll controllers over
the gesture, scales a continuous delta by its own factor while the fingers are
down, and at the end of the gesture spends the velocity it measured in
`GtkKineticScrolling` — a friction curve (`DECELERATION_FRICTION` 4, a ~250 ms
time constant) with an overshoot spring at either end — driven per frame from the
widget's frame clock. That IS the scrolling this surface wants, and the one thing
that takes it away is a controller of this file's own: a
`Gtk.EventControllerScroll` is a NON-GESTURE controller, `gtk_widget_add_controller`
PREPENDS, and `gtk_widget_run_controllers` breaks out of the dispatch as soon as a
non-gesture controller returns TRUE — so a TRUE for a continuous delta means the
scroller's own scroll handler never runs, the state its `::decelerate` handler
gates on stays unset, and GTK's kinetic path is latched off for that whole
gesture. `applyScrollEvent` therefore returns FALSE for every CONTINUOUS delta
(wheel notches and the emoji rule are the only events it consumes), and the result
list keeps `@common/scroll`'s laws without keeping a physics of its own: the
module note in `@common/scroll` states the rule, and NO surface in the suite
carries a tail, a decay curve or a position accumulator of its own.

**The position is READ BACK, not accumulated.** The scroller moves the adjustment
itself (a trackpad delta, then every frame of its kinetic tail), so `scrollOffset`
is a VIEW of the adjustment: `syncListFromAdjustment` (the adjustment's
`value-changed`) maps it through `rowOffset` + `clampOffset` (`@common/scroll`) and
pulls the SELECTION into the viewport (`selectionInView`), so Enter still acts on a
row the user can see while the tail is still running. Two guards keep this file's
own writes out of the tail's way: a wheel notch's 120 ms step skips the read-back
while it animates (`scrollAnim` — its intermediate positions would drag the
selection along), and `followSelection` writes nothing while the selection is
already in view.

The laws are `@common/scroll`'s: the wheel's whole steps (`wheelSteps`), the
selection-follow (`offsetForSelection`, `selectionInView`), the position bound
(`clampOffset`), the pixel/row conversions (`offsetPixels` / `rowOffset`)
and the viewport arithmetic (`viewportRows`, `viewportPixels`).

**The emoji grid scrolls the same way, in its own row unit.** The grid's scroller
is a `Gtk.ScrolledWindow` of its own — that is what a glyph grid is, an inner
scroller inside the emoji row — and it owns the grid's gesture exactly as the
list's scroller owns the list's: `applyEmojiScrollEvent` returns FALSE for a
CONTINUOUS delta, so the scroller's own handler runs and the drag scaling plus the
`GtkKineticScrolling` tail are GTK's in BOTH surfaces. This file keeps only the
unit mapping and the read-back for the grid: a wheel notch moves whole grid ROWS
(`scrollDecision`'s `step`, applied to `emojiScrollRow` through `clampOffset`),
the grid's rows being its own unit because they are one row of
`grid.columns` cells. There is no `gridTail` and no `::decelerate` hand-off: a
surface that hands the gesture on has no tail to start, and the momentum the user
feels is the scroller's own.

**The grid's rendered row window follows the scroller.** The grid renders only the
visible rows plus a margin and carries the rest as spacers, so the scroller's
`value-changed` read-back does two things for a gesture this file did not run:
`rowOffset` maps the adjustment into `emojiScrollRow`, and `ensureEmojiWindow`
re-renders the window the viewport has left — without that second half a natively
scrolled grid would scroll into blank spacer cells. The app's own writes
(`setEmojiScrollRow`) set `emojiRendering` while they re-render and re-set the
value, and the read-back ignores them.

**The emoji interaction rule.** The emoji row is one list item that owns an inner
glyph-grid scroller. While that row holds the selection the arrows drive the grid
(as they always did) and the LIST does not act on any scroll event
(`scrollDecision(…, gridActive: true)` → `ignore`) and consumes it — the case that
still matters is a grid with nothing to scroll, where its own scroller propagates
the event and the list must not take it. Neither surface consumes a CONTINUOUS
delta, so a gesture carries exactly ONE of them (the inner scroller handles it
before the list's controller is reached, and `gtk_widget_run_controllers` breaks
the ancestor walk at the first widget that handled it).

`common/scroll.probe.ts` pins the laws themselves without a window — `ags bundle
--gtk 4 common/scroll.probe.ts /tmp/scroll-probe.sh && bash
/tmp/scroll-probe.sh` — including the read-back of a position a scroller moved
(`rowOffset`) and the two row pitches the suite scrolls at (a short-pitch and a
tall-pitch one, i.e. a list row and the emoji grid's rows). The grid's own row maths
stays the launcher's: `emoji.probe.ts` (`ags bundle --gtk 4
apps/launcher/emoji.probe.ts /tmp/emoji-probe.sh && bash /tmp/emoji-probe.sh`).

**Per-source limits** (a scrollable list is pointless if a source stops early):
apps `APP_LIMIT = 60` (`sources/apps.ts`, every visible desktop entry); the emoji
search is uncapped already (`searchEntries(q, Number.MAX_SAFE_INTEGER)`); the
preview payloads ask for Wikipedia `gsrlimit=5` and Arch packages `limit=8`.

**The cost of no cap**, measured through the request surface: a single letter
(`a`) builds 45 rows and the card settles at its `listHeight` viewport; a
three-row query costs less. The row cap is a MAPPED-window property — the shown
height is the window's own allocation — so it is proven on a mapped card
(screenshot / `hyprctl layers`), never by the debug path: `launcher debug
query`/`debug scroll` run with the card HIDDEN, and they report the scroll
arithmetic plus the last allocation (`shownHeight`) rather than deciding the
size. The debug path is what proves the WIRING — `debug scroll <unit> <delta>
[list|grid]` applies a decision through the same function the controller calls
(the result list's `applyScrollEvent` or the emoji grid's
`applyEmojiScrollEvent`), and `debug scroll status [grid]` moves nothing and
reports a surface a REAL gesture moved. `consumed:false` for a `surface` delta is
the hand-over itself: the event is left to the surface's own scroller, which is
what gives both surfaces GTK's kinetic scrolling. There is no `glide` unit —
neither surface has a tail this file could start, so the reply carries no tail
numbers. The reply carries the surface's rows and offset, its scroller's live
adjustment value (the authoritative position a real gesture and the kinetic tail
it starts both move) plus the emoji grid's own numbers — so a gesture's effect on
either surface is readable without a device.

### The app-owned and interpreter bangs

- `!n <name-or-path>` — open or create a note: spawns
  `apps/notes/ensure-new.sh` in this tree (router → shell notes). The notes app's
  own `open` takes a note NAME or a PATH, so the argument is Tab-completed like
  every other path bang's (see Tab autofill).
- `!q <expr>` — qalc math · `!py <code>` — python evaluation.
- `!code <path>` — open a file/directory in VS Code (spawn `code <expanded
  path>`).
- `!a <path|glob>` — annotate an image in the TINSHELL annotate app (spawn
  `apps/annotate/ensure-open.sh <path>` in this tree (resolved against
  `TINSHELL_HOME`); the shared router serves
  it from whichever instance hosts annotate — the shell in production, never a
  hardcoded instance). The argument is resolved by the SAME rule as `!p`
  (`pathTargets`), then filtered through the shared still predicate
  (`common/media/classify` `isStillImage`) because annotate decodes stills
  only: one row per resolved image (`Annotate: <path>`), and anything the
  editor cannot decode is refused instead of spawned (`Nothing to annotate:
  <typed>`, the reason in its description, logged — the same refusal row shape
  `!p` uses). With NO argument the bang offers no row: annotate's request
  surface REQUIRES a path (`error: usage: open <image-path>`, no window), and
  the app's only empty-editor start is its bare `run.sh` debug entry — not
  something the launcher's dispatch may reach around.
- `!p <path|glob|url>` — open media in the TINSHELL media app. The argument is
  RESOLVED before anything is spawned, through the same helpers the entry's
  autofill uses: `expandPath` (tilde + canonical form), and `globPath` for a
  `*`/`?` pattern in the last segment (newest first, capped). One row per
  resolved file (`Play: <path>`), so a glob with several matches is chosen in
  the row list and never silently reduced to one — and the row shows the
  absolute path that will actually open. The spawn hands media one resolved
  path, never the typed text.
- `!p`'s REFUSAL: an argument that resolves to no regular file — nothing
  there, a directory, a non-regular file, or a pattern matching nothing —
  offers ONE row instead (`Nothing to play: <typed>`, the reason in its
  description, icon `dialog-warning`), logs the same reason, and spawns
  nothing; Enter keeps the launcher open (its card carries no status line).
  Media is never asked to open a path with nothing at it: the app refuses the
  same arguments (`media/AGENTS.md`, `window.tsx` `resolveTarget`), so a
  failure is stated where the path was typed instead of appearing as an empty
  player window.

`!p`, `!code` and `!a` take the SAME path argument, and all three are completed
by the shared `pathAutofill` in `Launcher.tsx` (see Tab autofill). What each
does with that argument once Enter is pressed differs: `!p` and `!a` resolve it
through the ONE shared rule (`pathTargets`; `!a` then keeps only still images),
`!code` expands the typed text with `expandPath`, and every spawn is handed the
resolved path, never the typed text.

### Token grammar (`sources/bang-token.ts`)

The catalogue is data (`BANG_CATALOGUE`); the hint rows AND the dispatch resolve
against that one list, so an abbreviation or an alias cannot reach a different
command than the spelling it stands for. Precedence, in this order:

1. an EXACT canonical spelling — `!c` stays the Chromium search even though
   `!code` starts with it, and `!p` stays the media bang even though `!py`
   does;
2. an EXACT ALIAS, at the same precedence as a canonical spelling — `!w` is
   Wikipedia while `!wc` stays the word count;
3. a token that is a strict prefix of exactly ONE catalogue bang dispatches as
   that bang WITH THE TYPED ARGUMENT INTACT: `!co ~/shot.png` runs the `!code`
   bang on `~/shot.png`. A token naming none (`!zz`) or several (`!`) names
   nothing (case-folded, matching the hint list's own narrowing);
4. an abbreviation or alias with no argument yet (`!co`, `!w`) shows the row of
   the bang it names — the canonical spelling as a visible affordance — and
   accepting it rewrites the leading TOKEN only (`spliceBangToken`), so
   `!co ~/x` + Enter becomes `!code ~/x` and never a `!code ` with the path
   dropped. An EXACT spelling with an empty argument shows no row, unchanged:
   the hint must not preempt the bang itself once it is typed;
5. which bangs take a PATH is a flag on the catalogue entry (`pathArg`), and the
   autofill extract reads it from there — one declaration, not a second list.

**Aliases are data on the entry** (`aliases`), resolved out of the same list, so
the hint row (which prints them as `· also !w`), the token rule and the dispatch
cannot disagree about what a shorthand names. An entry declares one only where
the prefix rule CANNOT reach it in that many characters — short forms that
already work stay unaliased:

| Bang | Alias | Collision checked |
| --- | --- | --- |
| `!wiki` | `!w` | `!w` prefixes two bangs (`!wiki`, `!wc`) so it named nothing; `!wc` stays exact |
| `!def` | `!d`, `!df` | `!d` and `!de` both prefix two bangs (`!def`, `!dec`) so they named nothing; `!dec` stays exact and `!de` still shows both candidates; no `!d`/`!df` bang exists |
| `!b64` | `!be` | `!b`/`!b6` both ambiguous; `!be` is no canonical spelling and prefixes none; `!b64` stays exact |
| `!b64d` | `!bd` | same family as `!be`; `!b64d` stays exact |

Every AMBIGUOUS token (a strict prefix of two or more canonical bangs) as of
this table: `!b`, `!b6` (both covered by `!be`/`!bd`), `!d` (covered by the
`!d` alias), `!de` (deliberate: it shows `!def` and `!dec` as candidates, and
`!df`/`!dec` disambiguate), `!e` (`!enc`/`!epoch`, each reachable at three
characters: `!en`, `!ep`), `!j` (`!json`/`!jwt`, reachable as `!js`, `!jw`),
`!m` (`!man`/`!mixer`/`!md5`, reachable as `!ma`, `!mi`, `!md`), `!w` (covered
by the `!w` alias). Tokens that name nothing for ANY OTHER reason do not exist:
an alias can never be a canonical spelling (asserted), and an alias that would
be a unique prefix of another bang is asserted against too, so an alias cannot
silently take over a working abbreviation.

No alias may equal a canonical spelling or another entry's alias, and the probe
asserts the table, both facts, and the precedence order over the whole catalogue
— an old abbreviation cannot be silently stolen by a new alias.

**Short forms that need no alias**, because the prefix rule already answers them:
`!pa` → `!pac`, `!au` → `!aur`, `!t` → `!tr`, `!y` → `!yt`, `!js` → `!json`,
`!po` → `!port`, `!gr` → `!grab`, `!mi` → `!mixer`, `!cl` was the clipboard bang
(REMOVED — see below), `!k` → `!kill`, `!ma` → `!man`, `!u` → `!uuid`. `!gh` is
already two characters and `!g` is the search bang, so `!gh` keeps its spelling.

**The bare `site:` forms keep their canonical spellings — the shorthands do NOT
apply there.** `wiki:`, `gh:`, `pac:`, `aur:`, `aw:`, `yt:`, `def:` and `g:` are
the URL source's own vocabulary (`sources/urls.ts`), claimed by `isUrlQuery` and
decided before the bang source ever runs; a one-or-two-letter scheme would claim
a namespace a real URI scheme may want (`w:`, `js:`), which is a different
decision from a bang shorthand. They cannot disagree with the bangs about a
site: both build their URL through the one `SITE` table (`text-tools.ts`), so
`!w` and `wiki:` open the same Wikipedia query URL by construction.

## Emoji mode

The launcher searches an emoji table and inserts the chosen glyph into the
window that was focused when the launcher opened (clipboard + synthetic
paste). The table/search/store/insertion machinery lives in `common/emoji/`;
the launcher owns the list, the grid and the config.

### One presentation, both routes

- Emoji matches ALWAYS render as a labelled glyph section: one label that
  folds the term and the count together — `Emoji: <term> - <n> matches`
  (singular `match`) — with the glyph grid directly under it. There is no
  separate count line and no expand step: the grid is the content, visible
  immediately and filtering as the query changes.
- **Emoji mode (`mod+.` or a leading `:`): the section is the whole list.**
  Every other source is suppressed for every query (no apps, calc, time or
  bangs — those live on `mod+Space`). An empty query shows the recents grid,
  labelled `Emoji - <n> recents` (the count names what it counts when there is
  no term); the grid is empty until the first pick seeds the store. An
  unmatched query shows nothing (just the search row).
- **Ordinary searches: the section is the last block.** It appears only when
  the query matches emoji entries; a slot is reserved for it inside
  a cap: the list ORDER puts the emoji row last, and nothing is cut, so no slot
  has to be reserved for it. It shares
  the app rows' chrome and selected treatment (`.match`), so among the app
  rows it reads as one more block of the same list whose contents happen to be
  glyphs — the label is the block's header, the cells are its rows.
- Selection: the section is one list item. Up/Down (or Tab) move onto it; once
  it holds the selection the arrows drive its grid (`columns` per line for
  Up/Down, ±1 for Left/Right), the block takes the selected treatment and its
  current cell is highlighted. Enter (or a glyph click) inserts that glyph
  through the ladder; Escape closes the whole card.
- **Multi-pick (Shift) — accumulate, then commit.** Shift+Enter / Shift+click
  APPEND the picked cell to a commit buffer instead of inserting: the card
  stays open, nothing is injected (the paste path only runs once the card
  hides), and the buffer renders as its own preview line under the count label
  (`Pending (2): 😀😄`, hidden while empty). A plain Enter (or a glyph click)
  COMMITS: the card hides and the whole buffer goes through the ladder as ONE
  insertion — one clipboard write, one paste, one restore — then closes.
  Nothing buffered = the pre-buffer behaviour (the selected/clicked glyph, one
  insert, close). A glyph already buffered appends AGAIN (the buffer is a
  sequence, not a set). Escape / click-outside / focus-loss close the card and
  DISCARD the buffer; a plain click while buffering commits the buffer without
  adding the clicked cell (hold Shift to add one more).
- **Scrolling: every match is reachable.** The search is UNCAPPED — the label
  counts every match — and the grid renders them all inside a vertical scroller
  of its own whose visible area is `grid.visibleRows` rows (`emojiGridHeight()`
  in `emoji.ts`). Arrowing past the last visible row scrolls exactly one row (the
  selection never leaves the viewport; `emojiScrollTop()` is the pure row
  maths). The WHEEL scrolls it through `@common/scroll`'s `scrollDecision` and
  `clampOffset`, applied in grid rows instead of entries, so a notch moves
  whole rows; a TRACKPAD gesture is left to that scroller's own scroll handler —
  the grid's scroller scales the delta and spends the gesture's velocity in
  `GtkKineticScrolling` after the fingers lift, exactly as the result list's does
  (see "Scrolling the result list").
  The position is FRACTIONAL while a gesture moves it (the adjustment carries the
  pixels) and whole for the arrows, which snap the viewport to the row the
  selection needs; the WHEEL moves the VIEW and never
  the selection, so the current cell and the per-cell clicks are untouched.
  Because the scroller's natural height is capped, the card's height stabilises
  at that cap for large match counts instead of growing without bound.

### The keybind contract (mod+. and `:`)

The same key must not mean two things:

| launcher state | mod+. does |
| --- | --- |
| closed | open the launcher IN EMOJI MODE |
| open in emoji mode | close |
| open in another mode | switch to emoji mode, never close |

A leading `:` in the query is the same entry-level trigger (it sets emoji
mode and the query is matched with its colons stripped).
`common/shell/ensure-launcher-emoji.sh` wraps `tinshell-route launcher emoji`.

### Insertion semantics

The glyph reaches the clipboard FIRST and unconditionally — mode `copy`,
every degrade path and a failed injection all leave it pasteable (the copy
floor). If the clipboard write itself throws, the insertion degrades to copy
WITHOUT injecting, so the target can never paste stale content. The ladder
(`common/emoji/insert-plan.ts`):

1. `mode=copy` → glyph copied (no injection).
2. No target captured when the launcher opened → copy.
3. No focused window after the launcher hides → copy.
4. Focus moved to another window → copy.
5. No typer binary → copy.
6. `mode=type` → type the glyph (`wtype <glyph>` / `ydotool type <glyph>`).
7. `mode=paste` → synthetic paste: `wtype -M ctrl -k v` (or
   `wtype -M ctrl -M shift -k v` for a `terminalClasses` window;
   `ydotool key 29:1 47:1 47:0 29:0` variants).
8. Chosen typer exits non-zero → retry the other typer once.
9. Both fail → copy only (glyph stays on the clipboard).
10. Clipboard write throws → copy (`reason: "clipboard write failed"`), no
    injection.

The injection is scheduled (idle + `insert.delayMs`) AFTER the launcher hides
— never synchronously on activation, because focus restore is asynchronous.
Each launcher session owns the target it captured (`beginPick()` on show →
passed to `insertGlyph`), and a generation counter drops a scheduled insertion
when a newer session/pick starts. A multi-pick COMMIT hides the card first and
then starts its one insertion, so that insertion is the newest schedule and is
not dropped by the hide's cancel. After a successful paste with
`restoreClipboard: true` the previous clipboard text is restored
`restoreDelayMs` later — only when the clipboard still holds the glyph, so
anything the user copied meanwhile is not clobbered.

## Lifecycle

`launcherMount()` (the shell's universal entry or island `app.ts`):

1. `Launcher()` — build the window once; expose its control surface to the
   dispatcher (launcher pattern: window-as-control).
2. `appsReload()` — index desktop apps eagerly so the first query is instant.

No quit hook. Dismiss: Escape (consumed by the window key controller) /
click-outside (Graphene bounds) / focus-loss — all via
`common/window/popup-dismiss`.

## Gotchas

- The launcher is the pattern-setter for window-as-control surfaces (dock
  applets, notifications centre, clipboard picker all mirror it).
- **One press sequence activates a row ONCE.** The dispatch sites are known and
  single: the entry's CAPTURE-phase key controller consumes Return (the entry's
  own `::activate` → `onActivate` and the window-level controller are fallbacks
  that never fire in practice), and a row's click gesture ignores the repeated
  presses of one
  sequence (`n_press > 1` — the row and the prime-run button alike). A real
  activation also HIDES the card synchronously, so the second press of a
  double-click cannot reach the row again; only the catalogue hint rows keep
  the card open, and their action (rewriting the leading bang token) is
  idempotent.
- The card is `valign CENTER` inside the surface box, NOT top-aligned: the
  surface is anchored NONE (Hyprland centres the box) and a mapped layer
  surface does not reliably shrink, so a top-aligned card paints above the
  monitor centre as soon as the results shrink — the upward drift. Do not
  change the card's valign back to START.
- The emoji row's grid wrap is HIDDEN (not empty) while the row rests: an
  empty result container still lays out its margins/padding, which leaves a
  dead bottom gap under the search row.
- The copy floor is UNCONDITIONAL and runs FIRST: never move a `kind ===
  "copy"` early return above the clipboard write (that bug dropped the glyph
  on every degrade path), and never let a failed clipboard write fall through
  to injection.
- The insertion ladder's copy-only floor is deliberate: an uncertain target
  must never receive a synthetic keystroke. Do not "improve" it by dropping
  the `targetAfter === targetBefore` check.
- `wtype` types the paste chord with `-M` modifiers (they auto-release when
  the process exits). Terminals need Ctrl+Shift+V (config `terminalClasses`).
- **An app row carries no file, so a file-requiring entry cannot start its app
  from the app search.** Its file codes are omitted, and annotate's request
  surface rejects an empty `open` on purpose: "TINSHELL Annotate" in an ordinary
  search lists, but activating it answers the usage error and opens nothing.
  The file reaches annotate through the file rows (a typed path) or the `!a
  <path>` bang — never by making `open` accept an empty path, and never by
  launching annotate's debug entry.
- The glyph grid is rebuilt imperatively (plain widgets) per result batch; do
  not convert it to gnim state — reconciliation races keystrokes.
- The clipboard restore runs `restoreDelayMs` after injection; restoring
  earlier would race the target's paste.
- `wtype`/`ydotool` availability is probed per insert; missing both degrades
  to copy-only, never an error.
- `!n`/`!f`/`!c` spawn absolute paths inside this tree (resolved from
  the tree root at spawn time) — keep them
  valid when the layout changes.
- prime-run button clears the `VK_ICD_FILENAMES`/EGL pins before spawning
  (`env -u … prime-run <cmd>`) — required for the NVIDIA ICD.

## Facts

- **A query change cancels the pending async kickoff BEFORE any early return**
  (`combiner.ts`): a debounce is a closure over the earlier keystroke's
  `pending` but reads `this.query` when it fires, so an uncancelled one merges
  the EARLIER keystroke's snapshot — the current query's sync rows (unit
  conversions, time) disappear and a qalc answer appears for a query qalc was
  never meant to answer. Do not move that cancel below the path/URL/emoji early
  returns.
- The result card auto-sizes to its content and stays centred on the monitor
  through every resize.
- The calc source shells out to `qalc -t` (terse mode) for arithmetic,
  constants, currency and any conversion the curated table does not parse. A
  query the table answered (`20C`, `100 km to mi`, `255 in binary`) never also
  reaches qalc: the rows it produced suppress the implicit calc, so one
  conversion is one row.
