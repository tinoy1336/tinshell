/**
 * Clipboard picker theme — dynamic tokens from config.clipboard.appearance.*.
 *
 * Static structure lives in style.css; every visible TOKEN (card colour,
 * radius, text colours) comes from config here, assembled at startup — the
 * dock's "nothing visual hardcoded in code" culture. Appearance is a baked
 * tier (restart applies), so assembling once at startup is honest.
 */
import { ACCENT, INK, INK_MUTED } from "@common/css/tokens"
import { get } from "./config"

export function buildClipboardCss(): string {
  const rgb = get<number[]>("appearance.cardRgb", [10, 12, 17]).join(", ")
  const alpha = get<number>("appearance.cardAlpha", 0.5)
  const radius = get<number>("appearance.radius", 14)
  const ink = get<string>("appearance.ink", INK)
  const muted = get<string>("appearance.muted", INK_MUTED)
  const accent = get<string>("appearance.accent", ACCENT)
  // Dark pill rows on the dark card, in the launcher's materials: rows the wash
  // surface token, snippet ink the suite ink, the selected row the shared
  // selected-row fill plus white text.
  const hoverBg = get<string>("appearance.hoverBg", "rgba(255, 255, 255, 0.10)")
  const focusBg = get<string>("appearance.focusBg", "var(--tinshell-row-selected)")

  return `
/* ── clipboard picker dynamic tokens (config.appearance.*) ── */
window.clipboard-picker .main {
  background: rgba(${rgb}, ${alpha});
  border-radius: ${radius}px;
}
window.clipboard-picker .entry-row {
  background: ${hoverBg};
  border-radius: ${Math.max(8, radius - 2)}px;
}
window.clipboard-picker .row {
  background: ${hoverBg};
  border-radius: ${Math.max(8, radius - 2)}px;
}
window.clipboard-picker .row .snippet,
window.clipboard-picker .row .pin-badge {
  color: ${ink};
}
window.clipboard-picker .row .timestamp {
  color: ${muted};
}
/* Delete control: dim at rest; hover and keyboard focus brighten the glyph ink.
 * Ink is the ONLY cue it carries — the button paints no box in any state (see
 * style.css), so a boxed hover or focus ring here would undo that. */
window.clipboard-picker .row .row-delete {
  color: ${muted};
}
window.clipboard-picker .row .row-delete:hover,
window.clipboard-picker .row .row-delete:focus,
window.clipboard-picker .row .row-delete:focus-visible {
  color: ${ink};
}
/* Preview control (IMAGE rows): the delete control's ink discipline — dim at
 * rest, brighter on hover and focus, no box in any state (see style.css). */
window.clipboard-picker .row .row-preview {
  color: ${muted};
}
window.clipboard-picker .row .row-preview:hover,
window.clipboard-picker .row .row-preview:focus,
window.clipboard-picker .row .row-preview:focus-visible {
  color: ${ink};
}
window.clipboard-picker .row.selected {
  background: ${focusBg};
}
window.clipboard-picker .row.selected .snippet {
  color: var(--tinshell-ink-emphasis); /* launcher convention — selected text is always white */
}
window.clipboard-picker .row.empty .snippet {
  color: ${muted};
}
window.clipboard-picker .entry-icon {
  color: ${accent};
}
`
}
