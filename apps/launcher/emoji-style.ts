/**
 * Launcher emoji-mode dynamic tokens — config.grid.* and config.appearance.*.
 *
 * Assembled once at mount (grid/appearance are the launcher's baked tiers:
 * a restart applies them), matching the applet/clipboard token pattern; the
 * static structure lives in ./style.css.
 */
import { ACCENT } from "@common/css/tokens"
import { get } from "./config"

export function buildLauncherEmojiCss(): string {
  const glyphSize = get<number>("grid.glyphSize", 22)
  const accent = get<string>("appearance.accentColour", ACCENT)
  const selection = get<string>("appearance.selectionColour", "rgba(138, 181, 247, 0.22)")
  const hover = get<string>("appearance.hoverColour", "rgba(255, 255, 255, 0.10)")

  return `
/* ── launcher emoji section tokens (config.appearance.*, config.grid.*) ── */
window.launcher .match.emoji-section .title {
  color: ${accent};
}
window.launcher button.emoji-cell label {
  font-size: ${glyphSize}px;
}
window.launcher button.emoji-cell:hover {
  background: ${hover};
}
window.launcher button.emoji-cell.selected {
  background: ${selection};
}
`
}
