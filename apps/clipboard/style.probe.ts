/**
 * style.probe — the clipboard picker's stylesheet invariants, exercisable headless.
 *
 * Why it exists: the row delete control carries no chrome of its own, and that
 * is a property of the STYLESHEET, not of any widget — the GTK default theme
 * gives every Gtk.Button a hover box (`button:hover`'s border + background-image
 * + box-shadow) and a 2px focus outline (`button:focus:focus-visible`), and the
 * app's sheet has to keep those off ONE control while leaving every other button
 * alone. A regression there (a stray hover background, a rounded fill, an
 * outline cascading back in) is invisible to a build and to tsc, so it is pinned
 * here as text:
 *
 *  - every rule that targets a control is scoped under the picker's window,
 *    so the override cannot leak onto another button or surface,
 *  - no rule targeting it paints an outline, border, box-shadow or background
 *    fill in any state — rested, hovered, focused or pressed,
 *  - hover and focus still change the glyph's COLOUR, so the control keeps a
 *    visual state without a box,
 *  - the row box, the control slots and the shared sheet (common/shell/
 *    theme.css) are untouched by the control's rules.
 *
 *  Both row glyph controls carry those invariants — the delete control and the
 *  image-only preview control beside it — so the checks run once per control.
 *
 * The assembled sheet (the shared theme + the app's structural css + the config
 * tokens) is then handed to a real Gtk.CssProvider: GTK reports a parse failure
 * through `parsing-error`, which is the only way to know a declaration such as
 * `outline: none` is actually understood rather than silently dropped. The same
 * provider-less step builds the button through `glyphButton` and asserts the
 * class lands on the BUTTON node (not the row).
 *
 * Gtk.init() opens a display connection and spawns no window; if it cannot run,
 * the text checks still gate and the parse/node steps report themselves skipped.
 *
 * Run:
 *   ags bundle --gtk 4 apps/clipboard/style.probe.ts /tmp/style-probe.sh
 *   bash /tmp/style-probe.sh          # exit 1 on any violated invariant
 */
import Gtk from "gi://Gtk?version=4.0"
import { glyphButton } from "@common/card/header"
import theme from "@common/shell/theme.css"
import { buildClipboardCss } from "./style"
import structural from "./style.css"

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

interface Block {
  selectors: string[]
  decls: { prop: string; value: string }[]
}

function blocks(text: string): Block[] {
  const out: Block[] = []
  for (const m of text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .split(",")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
    const decls = m[2]
      .split(";")
      .filter((d) => d.includes(":"))
      .map((d) => {
        const i = d.indexOf(":")
        return {
          prop: d.slice(0, i).trim().toLowerCase(),
          value: d
            .slice(i + 1)
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase(),
        }
      })
    out.push({ selectors, decls })
  }
  return out
}

const css = `${theme}\n${structural}\n${buildClipboardCss()}`
const all = blocks(css)
const declOf = (b: Block | undefined, prop: string) => b?.decls.find((d) => d.prop === prop)?.value
const empty: Block = { selectors: [], decls: [] }

/** Rules targeting one row glyph control (an image row carries `row-preview`
 *  beside `row-delete`). A `-slot` box is the slot, not the control. */
const controlBlocks = (control: string) =>
  all.filter((b) =>
    b.selectors.some((s) => s.includes(`.${control}`) && !s.includes(`.${control}-slot`)),
  )

const CHROME =
  /^(outline|border|box-shadow|background|background-color|background-image|border-radius)/
const chrome = (b: Block) => b.decls.filter((d) => CHROME.test(d.prop))
const neutral = (d: { prop: string; value: string }) =>
  d.prop === "border-radius"
    ? d.value === "0"
    : /^(none|0|0px|transparent|none none|0 solid transparent)$/.test(d.value)
const STATES = ["", ":hover", ":focus", ":focus-visible", ":active"]

for (const control of ["row-delete", "row-preview"]) {
  const blocks = controlBlocks(control)
  const sel = (state = "") => `window.clipboard-picker .row .${control}${state}`
  const inkBlocks = blocks.filter((b) => b.decls.some((d) => d.prop === "color"))
  const inkHover = inkBlocks.find((b) => b.selectors.some((s) => s.endsWith(`.${control}:hover`)))
  const inkRest = inkBlocks.find((b) => b.selectors.some((s) => s === sel()))
  const focusRule = blocks.find((b) =>
    b.selectors.some((s) => s.endsWith(`.${control}:focus-visible`)),
  )

  // ── the override is scoped to this one control ──
  check(`${control}: has rules`, blocks.length > 0, true)
  check(
    `${control}: every rule is scoped under the picker's window`,
    blocks.every((b) => b.selectors.every((s) => s.startsWith("window.clipboard-picker .row "))),
    true,
  )

  // ── no state paints a box ──
  check(
    `${control}: every chrome declaration is neutral`,
    blocks.flatMap(chrome).every(neutral),
    true,
  )
  check(
    `${control}: the chrome rule covers every state`,
    STATES.every((state) => css.includes(sel(state))),
    true,
  )

  // ── hover and focus keep a colour cue, and only a colour cue ──
  check(
    `${control}: hover and focus rules carry a colour`,
    [...inkBlocks].some((b) => b.selectors.some((s) => s.endsWith(`.${control}:hover`))) &&
      inkBlocks.some((b) => b.selectors.some((s) => s.endsWith(`.${control}:focus`))),
    true,
  )
  check(
    `${control}: hover brightens the glyph ink (rest colour differs)`,
    declOf(inkHover, "color") !== declOf(inkRest, "color"),
    true,
  )
  check(
    `${control}: the ink rules paint no box`,
    inkBlocks.every((b) => chrome(b).length === 0),
    true,
  )
  check(
    `${control}: the focused state neutralises the theme's outline`,
    ["none", "0", "0px"].includes(
      declOf(focusRule, "outline") ?? declOf(focusRule, "outline-width") ?? "",
    ),
    true,
  )
}

check(
  "the shared sheet gained no control-specific rule",
  theme.includes("row-delete") || theme.includes("row-preview"),
  false,
)

// ── the row box and the slots are left alone ──
const rowBlocks = all.filter((b) =>
  b.selectors.some((s) => s === "window.clipboard-picker .row" || s.endsWith(".row.selected")),
)
check(
  "no row rule draws an outline",
  rowBlocks.some((b) => b.decls.some((d) => d.prop.startsWith("outline"))),
  false,
)
const slotBlock = all.find((b) => b.selectors.some((s) => s.includes(".row-delete-slot")))
check("the slot keeps its own width only", slotBlock?.decls.length, 1)
check("and draws no box either", slotBlock?.decls[0]?.prop, "min-width")

// ── a real provider parses the assembled sheet; the class lands on the button ──
let note = "ran"
try {
  Gtk.init()
  const errors: string[] = []
  const provider = new Gtk.CssProvider()
  provider.connect("parsing-error", (_p: unknown, _section: unknown, error: unknown) => {
    errors.push(String(error))
  })
  provider.load_from_string(css)
  check("the assembled stylesheet parses", errors.length, 0)
  if (errors.length > 0) console.log(`parse errors: ${errors.slice(0, 3).join(" | ")}`)

  for (const control of ["row-delete", "row-preview"]) {
    const btn = glyphButton(control, "\u{f0a7a}", "row control")
    check(`the ${control} class is on the BUTTON node`, btn.has_css_class(control), true)
    check(`and the row's class is not (${control})`, btn.has_css_class("row"), false)
  }
} catch (e) {
  note = `skipped (${(e as Error).message})`
}

console.log(`note: GTK parse + node checks ${note}`)
const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`style probe failed: ${failed.length} check(s)`)
