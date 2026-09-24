/**
 * Notifications theme — the frosted-glass material, built from the swaync
 * style.css tokens (the same material as the dock's menu).
 *
 * Static structure lives in style.css; every visible TOKEN (colours, radius,
 * sizes) comes from config.appearance.* here, assembled at startup — the
 * dock's "nothing visual hardcoded in code" culture. Appearance is a baked
 * tier (restart applies), so assembling once at startup is honest.
 */
import { hexToRgba } from "@common/colour"
import { ACCENT, INK, INK_MUTED } from "@common/css/tokens"
import { get } from "./config"

/** The sticky tier's surface is the card colour scaled by this factor — about
 *  30% darker than the normal card, derived from the same value rather than a
 *  second colour that a palette change would have to keep in step. The alpha is
 *  deliberately untouched: lowering it would make the never-expiring card the
 *  more transparent tier and invert the weight the two tiers read with. */
const CRITICAL_DARKEN = 0.7

/** The sticky card's glow alpha. Low enough that the accent reads as a tint
 *  spreading off the card's edge, not a drawn outline; it rides over the black
 *  elevation shadow below. */
const CRITICAL_GLOW_ALPHA = 0.22

export function buildDynamicCss(): string {
  const rgb = get<number[]>("appearance.cardRgb", [10, 12, 17])
  const rgbCss = rgb.join(", ")
  const alpha = get<number>("appearance.cardAlpha", 0.5)
  const alphaCritical = get<number>("appearance.cardAlphaCritical", 0.62)
  const criticalRgb = rgb.map((v) => Math.round(v * CRITICAL_DARKEN)).join(", ")
  const radius = get<number>("appearance.radius", 18)
  const ink = get<string>("appearance.ink", INK)
  const muted = get<string>("appearance.muted", INK_MUTED)
  const accent = get<string>("appearance.accent", ACCENT)
  const hoverBg = get<string>("appearance.hoverBg", "rgba(255, 255, 255, 0.10)")
  const focusBg = get<string>("appearance.focusBg", "var(--tinshell-row-selected)")
  const closeBg = get<string>("appearance.closeBg", "rgba(255, 255, 255, 0.10)")
  const closeBgHover = get<string>("appearance.closeBgHover", "rgba(255, 255, 255, 0.18)")
  const actionBg = get<string>("appearance.actionBg", "rgba(255, 255, 255, 0.08)")
  const iconSize = get<number>("appearance.iconSize", 48)
  const imgRadius = get<number>("appearance.bodyImageRadius", 12)
  const sumSize = get<number>("appearance.summaryFontSize", 14)
  const bodySize = get<number>("appearance.bodyFontSize", 13)
  const timeSize = get<number>("appearance.timeFontSize", 14)

  return `
/* ── notifications dynamic tokens (config.appearance.*) ── */
window.notifications-popup .card,
window.notifications-centre .card {
  background: rgba(${rgbCss}, ${alpha});
  border-radius: ${radius}px;
}
window.notifications-popup .card.critical,
window.notifications-centre .card.critical {
  background: rgba(${criticalRgb}, ${alphaCritical});
  /* Elevation shadow — the never-expiring card reads as lifted — plus a blurred
     spread of the accent role on its outer edge. Both are shadows (blurred, no
     offset line), so the glow tints the edge instead of outlining it. */
  box-shadow: 0 6px 18px 0 rgba(0, 0, 0, 0.45), 0 0 16px 2px ${hexToRgba(accent, CRITICAL_GLOW_ALPHA)};
}
window.notifications-centre .centre {
  background: rgba(${rgbCss}, ${alpha});
  border-radius: ${radius}px;
}
window.notifications-popup .summary,
window.notifications-centre .summary {
  color: ${ink};
  font-size: ${sumSize}px;
}
window.notifications-popup .body,
window.notifications-centre .body {
  color: ${ink};
  font-size: ${bodySize}px;
}
window.notifications-popup .time,
window.notifications-centre .time {
  color: ${muted};
  font-size: ${timeSize}px;
}
window.notifications-popup .app-icon,
window.notifications-centre .app-icon {
  min-width: ${iconSize}px;
  min-height: ${iconSize}px;
  border-radius: ${Math.round(iconSize / 2)}px;
}
window.notifications-popup .body-image,
window.notifications-centre .body-image {
  border-radius: ${imgRadius}px;
}
window.notifications-popup .action,
window.notifications-centre .action {
  color: ${ink};
  background: ${actionBg};
  border-radius: var(--tinshell-row-radius);
  box-shadow: none;
  outline: none;
}
/* Hover repaints the WHOLE button (the shared row rule flattens the FlowBox
   wrapper that would otherwise tint a box of its own). The label is never a
   hover target: a label-only background or text change leaves the button's box
   unchanged and reads as a box that appeared around the text. */
window.notifications-popup .action:hover,
window.notifications-centre .action:hover {
  background: ${hoverBg};
  box-shadow: none;
  outline: none;
}
window.notifications-popup .action:focus-visible,
window.notifications-centre .action:focus-visible {
  outline: none;
  box-shadow: none;
}
window.notifications-popup .close,
window.notifications-centre .close {
  background: ${closeBg};
  color: ${muted};
  border-radius: 100%;
  min-width: 22px;
  min-height: 22px;
}
window.notifications-popup .close:hover,
window.notifications-centre .close:hover {
  background: ${closeBgHover};
  color: ${ink};
  box-shadow: none;
  outline: none;
}
window.notifications-centre .centre-row:hover {
  background: ${hoverBg};
  border-radius: ${radius}px;
}
window.notifications-centre .centre-row.selected {
  background: ${focusBg};
  border-radius: ${radius}px;
}
/* No opacity rule dims a listed entry. An entry the daemon no longer holds is
   told apart by its missing sender actions (NotificationCard renders none for a
   live: false entry); dimming it made readable content unreadable. */
window.notifications-centre .group-header {
  background: transparent;
  padding: var(--tinshell-row-padding);
  border-radius: var(--tinshell-row-radius);
  color: ${ink};
}
window.notifications-centre .group-header:hover {
  background: ${hoverBg};
}
window.notifications-centre .group-count,
window.notifications-centre .group-chevron {
  color: ${muted};
}
window.notifications-centre .widget-title label,
window.notifications-centre .widget-inhibitors label,
window.notifications-centre .widget-dnd label {
  color: ${ink};
}
window.notifications-centre .empty-state {
  color: ${muted};
  opacity: 0.5;
}
`
}
