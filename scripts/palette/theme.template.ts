/**
 * theme.template.ts — the template for this repository's shared stylesheet,
 * `common/shell/theme.css`.
 *
 * A palette template: the default export carries `render(context)`, the module
 * imports nothing, and `render` returns the exact text of the output. The
 * renderer adds nothing to it, so the framing, the banner and the trailing
 * newline are written here. The contract a template is written against is the
 * palette repository's `docs/template-contract.md`.
 *
 * WHY THE STYLESHEET IS GENERATED WHOLE, rather than assembled from a palette
 * fragment: GTK CSS has no `@import` (the parser carries no such at-rule), and
 * the stylesheet reaches every app as a bundled text module
 * (`import theme from "@common/shell/theme.css"`), so a separate palette
 * stylesheet could only reach a widget if every app concatenated two modules
 * itself. The stylesheet's own rules are therefore written here, beside the
 * palette values they consume, and a stylesheet edit is a template edit followed
 * by a re-render (`node scripts/check-palette.mjs --write`).
 *
 * The colour tokens are read from the palette; the font stack and the geometry
 * tokens are this repository's own values and are carried here verbatim.
 */

/** The fields a template may read from a token (the palette's own Token type). */
type Token = {
  name: string
  hex?: string
  alpha?: number
}

type Context = {
  palette: { find(name: string): Token }
  colour: {
    parseHex(hex: string): { r: number; g: number; b: number }
    formatAlpha(alpha: number): string
  }
  provenance: { palette: { sha256: string; revision: string } }
}

export default {
  render(context: Context): string {
    const { palette, colour, provenance } = context

    const hexOf = (name: string): string => {
      const token = palette.find(name)
      if (token.hex === undefined) {
        throw new Error(`token ${name} carries no colour, so it cannot be a stylesheet token`)
      }
      return token.hex
    }
    const alphaOf = (name: string): number => {
      const token = palette.find(name)
      if (token.alpha === undefined) {
        throw new Error(`token ${name} carries no opacity, so it cannot be composited`)
      }
      return token.alpha
    }
    /** A colour token carrying its own opacity, as the `rgba()` GTK CSS reads. */
    const translucent = (name: string): string => {
      const { r, g, b } = colour.parseHex(hexOf(name))
      return `rgba(${r}, ${g}, ${b}, ${colour.formatAlpha(alphaOf(name))})`
    }
    /** One colour token painted at another token's opacity: the frosted surface. */
    const painted = (colourToken: string, opacityToken: string): string => {
      const { r, g, b } = colour.parseHex(hexOf(colourToken))
      return `rgba(${r}, ${g}, ${b}, ${colour.formatAlpha(alphaOf(opacityToken))})`
    }

    return `/* Generated from the house palette — edit the template, not this file.
 *
 * Template: scripts/palette/theme.template.ts
 * Palette revision: ${provenance.palette.revision}
 *
 * Shared TINSHELL theme primitives (multi-app home).
 *
 * Apps import this FIRST (css: theme + appCss) and override with
 * app-specific rules. Frost comes from Hyprland blur layerrules on each
 * app's window namespace, NOT from CSS alpha alone.
 *
 * ── Tokens ──
 * Single-owner values for the whole process (the shell shares one CSS
 * namespace across every app), declared on \`*\` so every widget carries the
 * value itself. GTK custom properties (4.16+) are inherited like any other
 * inherited property, so a narrower selector would only reach that widget's
 * subtree — \`*\` is what the family already used and it covers every window of
 * every app, including a lazy app mounted long after this provider was added.
 *
 * Every colour token is the PALETTE's value; the shell declares no colour of
 * its own. \`--tinshell-panel\` is the palette's \`surface.base\` painted at its
 * \`opacity.panel\`, and the scrollbar pill reads the three
 * \`interaction.scrollbar-thumb*\` tokens. The font stack and the geometry
 * tokens are the shell's own values, which the palette does not carry.
 *
 * A token a consumer CSS cannot reach (a Cairo painter, a \`Pango.FontDescription\`,
 * a config fallback string) has a second carrier in common/css/tokens.ts; those
 * two files are the only ones allowed to spell the value (the audit's
 * \`literal-duplicated\` class allowlists them).
 *
 * Each token is named for the ROLE the value plays in this design, never for
 * the hex: two apps can read one role, and two sites can carry an equal value
 * that is two different decisions (the seek slider's white fill is a control
 * fill, not label ink; the notification centre's selected row is a heavier fill
 * than the picker rows') — those stay spelled out at the site.
 */
* {
  --tinshell-font-family: "JetBrainsMono Nerd Font", monospace;

  /* Ink. */
  --tinshell-ink: ${hexOf("text.primary")};
  --tinshell-ink-emphasis: ${hexOf("text.strong")};
  --tinshell-ink-muted: ${hexOf("text.muted")};
  --tinshell-ink-faint: ${translucent("text.faint")};
  --tinshell-accent: ${hexOf("accent.primary")};

  /* Surfaces: the frosted panel base, the washes painted inside it, the
   * hairline that separates blocks on it, and the scrollbar pill's states. */
  --tinshell-panel: ${painted("surface.base", "opacity.panel")};
  --tinshell-wash: ${translucent("interaction.wash")};
  --tinshell-row-selected: ${translucent("interaction.row-selected")};
  --tinshell-hairline: ${translucent("border.hairline")};
  --tinshell-scrollbar-thumb: ${translucent("interaction.scrollbar-thumb")};
  --tinshell-scrollbar-thumb-hover: ${translucent("interaction.scrollbar-thumb-hover")};
  --tinshell-scrollbar-thumb-active: ${translucent("interaction.scrollbar-thumb-active")};

  /* Geometry: the panel's outer radius, the radius of the rows inside it
   * (panel radius less 2), and a row band's inset. */
  --tinshell-panel-radius: 14px;
  --tinshell-row-radius: 12px;
  --tinshell-row-padding: 6px 12px;

  /* Type: the card/row family's body size. Headings, entry fields and the
   * entry base set their own. */
  --tinshell-font-size-body: 12px;
}

/* The font token, applied to every widget. */
* {
  font-family: var(--tinshell-font-family);
}

/* Gtk.Entry base: transparent frameless input inside a styled pill/row box.
 * The visible background belongs to the surrounding row, not the entry. */
entry {
  background: transparent;
  color: var(--tinshell-ink);
  caret-color: var(--tinshell-accent);
  font-size: 16px;
  padding: 0;
  outline: none;
  border: none;
  box-shadow: none;
  /* No ligatures in input fields (JetBrains Mono would join "->" into an
   * arrow glyph). GTK4 CSS: font-variant-ligatures: none. */
  font-variant-ligatures: none;
}

entry:focus {
  outline: none;
  border: none;
  box-shadow: none;
}

/* Scrollbar — the shared thin-pill family (dock menus, notifications, notes,
 * files). Transparent trough, borderless, slender rounded slider that widens
 * on hover (160ms eased). WHITE everywhere (one consistent look across all
 * surfaces). The dock menu layers its fixed-thumb + \`near\` proximity widening
 * on top. Both dimensions are set so vertical AND horizontal scrollbars (the
 * files path bar) get the same 2px thickness. */
scrollbar {
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
  min-width: 2px;
  min-height: 2px;
  transition:
    min-width 160ms ease,
    min-height 160ms ease;
}
scrollbar:hover {
  min-width: 7px;
  min-height: 7px;
}
scrollbar trough {
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
  border-radius: 1px;
  min-width: 2px;
  min-height: 2px;
  transition:
    min-width 160ms ease,
    min-height 160ms ease;
}
scrollbar:hover trough {
  min-width: 7px;
  min-height: 7px;
}
scrollbar slider {
  margin: 0;
  padding: 0;
  background: var(--tinshell-scrollbar-thumb);
  border: none;
  box-shadow: none;
  border-radius: 1px;
  min-width: 2px;
  min-height: 2px;
  transition:
    min-width 160ms ease,
    min-height 160ms ease,
    background 160ms ease;
}
scrollbar:hover slider {
  min-width: 7px;
  min-height: 7px;
  border-radius: 3px;
  background: var(--tinshell-scrollbar-thumb-hover);
}
scrollbar slider:hover,
scrollbar slider:active {
  background: var(--tinshell-scrollbar-thumb-active);
}
`
  },
}
