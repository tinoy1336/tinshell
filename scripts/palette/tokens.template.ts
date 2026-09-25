/**
 * tokens.template.ts — the template for this repository's TypeScript token
 * module, `common/css/tokens.ts`.
 *
 * A palette template: the default export carries `render(context)`, the module
 * imports nothing, and `render` returns the exact text of the output. The
 * contract a template is written against is the palette repository's
 * `docs/template-contract.md`.
 *
 * The module is generated whole because its values must agree with the
 * stylesheet's to the byte: both carriers are rendered from the one palette, so
 * a palette move re-renders both in a single pass and neither can drift from the
 * other. The font stack is this repository's own value — the palette carries no
 * typography — and is carried here verbatim.
 */

type Token = {
  name: string
  hex?: string
}

type Context = {
  palette: { find(name: string): Token }
  provenance: { palette: { sha256: string; revision: string } }
}

export default {
  render(context: Context): string {
    const { palette, provenance } = context

    const hexOf = (name: string): string => {
      const token = palette.find(name)
      if (token.hex === undefined) {
        throw new Error(`token ${name} carries no colour, so it cannot be a token constant`)
      }
      return token.hex
    }

    return `/**
 * tokens.ts — the suite's design-token values, as JS.
 *
 * Generated from the house palette — edit the template, not this file.
 * Template: scripts/palette/tokens.template.ts
 * Palette revision: ${provenance.palette.revision}
 *
 * A token has two carriers, and this module holds the SECOND one — the runtime
 * string — for consumers CSS cannot reach: a Cairo painter or a
 * \`Pango.FontDescription\` reads no stylesheet, and a config fallback is a JS
 * value before it is ever CSS text.
 *
 *   - every colour and geometry token lives in \`common/shell/theme.css\` (the
 *     stylesheet every app imports FIRST) as an \`--tinshell-*\` custom property, and
 *     a CSS consumer reads it there — no constant here;
 *   - a token whose value JS must hold adds a constant here, and that constant
 *     IS the JS carrier of the same token (never a second value).
 *
 * The colour constants are the palette's values, rendered from the same source
 * as the stylesheet's, so the two carriers cannot disagree. The font stack is
 * this repository's own value.
 *
 * The two carriers are the only files allowed to spell the value: the audit's
 * \`literal-duplicated\` class allowlists them, so a re-spelling anywhere else is
 * reported instead of silently drifting (annotate's canvas and its PNG export,
 * for one, must use the same family or the export diverges from what is on
 * screen).
 *
 * Declared on \`*\` in theme.css — GTK custom properties are inherited and a
 * \`var()\` also resolves against a property set on a matching ancestor, so \`*\`
 * (which matches every widget) puts the value on every node directly; GTK has
 * no document element to hang a browser's \`:root\` habit on.
 *
 * A token is named for the ROLE the value plays, never for the value: two apps
 * can read one role, and a value that two sites happen to share can be two
 * different decisions (media's white seek-slider fill is a control fill, not
 * label ink) — those stay spelled out at the site.
 */

/** The suite's monospace face — everything, glyphs included, renders in it.
 *  CSS carrier: \`--tinshell-font-family\`. */
export const FONT_FAMILY = "JetBrainsMono Nerd Font"

/** Primary text ink. CSS carrier: \`--tinshell-ink\`. */
export const INK = "${hexOf("text.primary")}"

/** Secondary text ink — timestamps, hints, disabled labels. A row that wants
 *  ink at reduced ALPHA derives it (\`hexToRgba(INK, 0.5)\`), which is a different
 *  value, not this token. CSS carrier: \`--tinshell-ink-muted\`. */
export const INK_MUTED = "${hexOf("text.muted")}"

/** The suite accent — caret, focus/active control, the active path segment.
 *  CSS carrier: \`--tinshell-accent\`. */
export const ACCENT = "${hexOf("accent.primary")}"
`
  },
}
