/**
 * Shared card-window chrome — the toolbar/action language the file-browsing
 * card apps share (files, portal, annotate). One emitter so the header bar,
 * its glyph buttons, the status line and the action pills cannot drift apart
 * between apps; app-specific rules stay in each app's own mount CSS block
 * (files assembles its block through common/card/app-css).
 *
 * The classes are the shared ones (`card-*`) — every card app uses the same
 * markup names, so a change here moves the whole family together.
 *
 * `labelButtonRowCss` (the label-button row rule) is exported on its own: a
 * surface whose sheet does not carry the card chrome still needs the ONE
 * definition of that rule rather than a copy of it.
 *
 * NO BACKTICKS inside the emitted template literal — a backtick terminates
 * the string and breaks the bundle silently at cold start (notes GOTCHA 13).
 */
import { hexToRgba } from "@common/colour"

export interface CardChromeAppearance {
  textColour: string
  accentColour: string
  hoverColour: string
  selectionColour: string
  fontSize: number
}

/**
 * The label-button row rule — a button carrying a label owns its whole box.
 *
 * The label sits centred in the button and the hover state repaints that SAME
 * box. What breaks it is a FlowBox/Grid child wrapper: the theme pads the
 * wrapper 3px and tints it on hover (libadwaita: `flowbox > flowboxchild:hover`
 * at 4% currentColor), so a second, dimmer box spawns around the button on
 * hover — larger than the button, and off-centre by the button's own margins.
 * A row that lays label buttons out in a FlowBox/Grid carries `card-actions`:
 * the wrapper is then flattened, so the button's box is the only box the
 * pointer can hit and the only box that repaints.
 *
 * NO BACKTICKS inside the emitted template literal — a backtick terminates the
 * string and breaks the bundle silently at cold start (notes GOTCHA 13).
 */
export const labelButtonRowCss = `
.card-actions {
  background: transparent;
}
.card-actions > flowboxchild,
.card-actions > child {
  background: transparent;
  padding: 0;
  margin: 0;
  border-radius: 0;
  outline: none;
  box-shadow: none;
}
/* The wrapper's own states too: the theme's hover tint and selected fill would
   paint back the box the padding above stopped it from being. */
.card-actions > flowboxchild:hover,
.card-actions > flowboxchild:active,
.card-actions > flowboxchild:focus,
.card-actions > flowboxchild:selected,
.card-actions > child:hover,
.card-actions > child:active,
.card-actions > child:focus,
.card-actions > child:selected {
  background: transparent;
  box-shadow: none;
  outline: none;
}
/* Row spacing belongs to the row (column_spacing / row_spacing / padding): a
   button margin is what pushed the button off its cell's centre line. */
.card-actions .card-action,
.card-actions .card-primary,
.card-actions .card-btn {
  margin: 0;
}
`

/** Flat-glass toolbar + action rules shared by every card window. */
export function cardChromeCss(a: CardChromeAppearance): string {
  const ink = a.textColour
  const dim = hexToRgba(a.textColour, 0.4)
  const muted = hexToRgba(a.textColour, 0.5)
  const accentHover = hexToRgba(a.accentColour, 0.85)

  return `
/* Header bar: transparent, hairline bottom edge (flat-glass toolbar). */
.card-header {
  background: transparent;
  padding: 6px 10px 4px;
  border-bottom: 1px solid var(--tinshell-hairline);
}

/* Flat glyph/icon button — the header's basic control. */
.card-btn {
  background: transparent;
  border: none;
  border-radius: 8px;
  padding: 3px 10px;
  font-size: 14px;
  /* ONE control box for every header control. A glyph button is laid out by
     its label, and centreGlyphInk adds a PER-GLYPH trailing margin (up to ~27%
     of the advance), so without a floor a toolbar is a row of different widths.
     The floor absorbs those margins and the ink centring still holds — the
     label box is centred inside the larger button. */
  min-width: 34px;
  min-height: 28px;
  box-shadow: none;
  color: ${ink};
}
.card-btn:hover { background: ${a.hoverColour}; border: none; box-shadow: none; }
.card-btn:focus { outline: none; box-shadow: none; }
.card-btn:active { background: ${a.selectionColour}; }
.card-btn:disabled { background: transparent; color: ${dim}; }
/* The ACTIVE (current) control keeps its accent tint through hover/focus/press:
   .card-btn:hover out-specifies a bare .card-btn-active (a class plus a state
   beats a class), so without this the current tool greys out the moment the
   pointer crosses it. */
.card-btn-active,
.card-btn-active:hover,
.card-btn-active:focus,
.card-btn-active:active { background: ${a.selectionColour}; }

/* Path / breadcrumb segment + its separator. */
.card-path-btn {
  background: transparent;
  border: none;
  border-radius: 8px;
  padding: 3px 8px;
  font-size: 13px;
  min-width: 0;
  min-height: 0;
  box-shadow: none;
  color: ${ink};
}
.card-path-btn:hover { background: ${a.hoverColour}; color: ${a.accentColour}; border: none; box-shadow: none; }
.card-path-btn:focus { outline: none; box-shadow: none; }
.card-path-btn-current { color: ${a.accentColour}; }
.card-sep { color: ${dim}; font-size: 11px; }

/* Path bar: transparent scroller + segment row (the bar scrolls the segments
 * horizontally, so both layers must paint nothing of their own). */
.card-pathscroll,
.card-pathbar { background: transparent; }

/* Path bar edit mode: the entry that replaces the breadcrumbs. Same ink and
 * metrics as the segment buttons, so the header row does not change height
 * when the bar swaps rows. */
.card-path-entry {
  background: transparent;
  color: ${ink};
  font-size: 13px;
  padding: 3px 8px;
  min-width: 0;
  min-height: 0;
  border: none;
  box-shadow: none;
}
.card-path-entry:focus { outline: none; box-shadow: none; }

/* Muted mirror of the current location (portal's path label). */
.card-path { color: ${muted}; font-size: 13px; }

/* Status line: same slot, same ink, every app. */
.card-statusbar {
  background: transparent;
  padding: 4px 10px 6px;
}
.card-status { color: ${muted}; font-size: var(--tinshell-font-size-body); }

/* Action bar: the button row at the bottom of a card (portal's Cancel/Accept). */
.card-actionbar {
  background: transparent;
  padding: 8px 10px;
}
${labelButtonRowCss}

/* Action bar buttons: secondary pill + the accent primary action. A label is
   centred in the button's own box and hover repaints that whole box — never a
   box around the label (see the label-button row rule above). */
.card-action {
  border-radius: 8px;
  padding: 5px 16px;
  color: ${ink};
}
.card-action:hover { background: ${a.hoverColour}; }
.card-primary {
  background: ${a.accentColour};
  color: #1a1a1a;
  font-weight: 600;
  border-radius: 8px;
  padding: 5px 16px;
  box-shadow: none;
}
.card-primary:hover { background: ${accentHover}; }
.card-primary:disabled { background: ${dim}; color: ${muted}; }
/* Icon-only primary action (annotate's save) — a square-ish pill, not the
 * wide text pill the action bars use. Sized to the SAME control box as
 * .card-btn, so the accent action is not the odd one out in the row. */
.card-primary-icon { border-radius: 8px; padding: 5px 10px; min-width: 34px; min-height: 28px; }
`
}
