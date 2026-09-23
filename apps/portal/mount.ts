/**
 * portal mount — the xdg-desktop-portal FileChooser backend builder.
 *
 * Shared by the island app.ts (instanceName "portal", io.Astal.portal, unit
 * tinshell-portal.service — the DEV island) and the shell instance. The
 * backend is a SEPARATE session-bus name —
 * org.freedesktop.impl.portal.desktop.tinshell-portal (dbus.ts); io.Astal.portal
 * exists so the app is a first-class TINSHELL island with the standard
 * request/quit surface.
 *
 * Lifecycle: RESIDENT in production via the shell instance (which owns the
 * impl name before the portal frontend probes it — boot-deadlock fix).
 * The island unit is D-Bus-activated ON DEMAND in dev mode.
 * The backend never self-quits: the impl name must stay owned for the
 * whole process lifetime (dbus.ts).
 *
 * IMPORTANT: ownName() MUST run at import time (module top level), BEFORE
 * Gtk init — Gtk init otherwise blocks ~25s on the portal Settings interface
 * while portal waits for our name. Imports resolve before app.start()/Gtk
 * init in both island and shell bundles, so this ordering holds everywhere.
 */
import GLib from "gi://GLib"
import { isProductionShell } from "@common/app/mode"
import { cardAppCss } from "@common/card/app-css"
import { hexToRgba } from "@common/colour"
import { register } from "@common/commands/registry"
import { fileSink, log, setSink } from "@common/log/logger"
import { get as getConfig } from "./config"
import { ownName } from "./dbus"
import style from "./style.css"

// D-Bus-activated in dev (no systemd journal for the Exec path, no keybind) —
// log to a file like the other on-demand apps, or diagnostics vanish.
// Skipped only in the production shell (which owns the one global sink).
if (!isProductionShell) {
  setSink(fileSink("/tmp/tinshell-portal-debug.log"), "[portal]")
}

// Claim the impl bus name BEFORE Gtk init — breaks the boot-time portal
// deadlock (see dbus.ts ownName). Gtk init otherwise blocks ~25s on the
// portal Settings interface while portal waits for our name.
const t0 = GLib.get_monotonic_time()
log(`[app] pre-ownName t+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(0)}ms`)
ownName()
log(`[app] post-ownName t+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(0)}ms`)

// The shared card CSS assembly (theme primitives, the static stylesheet, the
// card theme + chrome blocks) plus the chooser skin (tier: restart). Kept
// AFTER ownName: a config hiccup must never delay the name claim.
const appearance = getConfig("appearance")
// The chooser config states no icon size, so the listing's glyph step is derived
// from the body font the rest of the card uses (the same derivation window.tsx
// feeds the pane).
const listIconSize = Math.round(appearance.fontSize + 6)
const listMetaSize = Math.max(appearance.fontSize - 3, 10)
// The dropdown's popover is its own surface and inherits nothing from the card.
// Opaque on purpose: it opens over the actionbar, so the card's translucency
// would let the buttons underneath show through the list.
const cardSolid = hexToRgba(appearance.cardColour, 1)

export const portalCss = cardAppCss({
  app: "portal",
  style,
  appearance,
  /** The chooser's own colour-driven rules: the listing's rows and ink, the
   *  places rail, the file-type dropdown and the tooltip/popover surfaces that
   *  inherit nothing from the card. NO BACKTICKS INSIDE THIS TEMPLATE LITERAL —
   *  they terminate the string and break the bundle silently at cold start
   *  (notes GOTCHA 13). */
  extra: ({ ink, text, icon, muted, dim }) => `
window.portal entry { color: ${ink}; background: transparent; border: 1px solid ${dim}; border-radius: 8px; padding: 4px 8px; }
window.portal entry selection { background: ${appearance.selectionColour}; }
/* The listing: the files browser's row language (transparent by default, the
   hover tint, the selection tint with an accent left edge that never shifts the
   row) over this app's own ink tokens. */
window.portal .chooser-view row { background: transparent; border-radius: 8px; margin: 0 2px; }
window.portal .chooser-view row:hover { background: ${appearance.hoverColour}; }
window.portal .chooser-view row:selected { background: ${appearance.selectionColour}; box-shadow: inset 3px 0 0 ${appearance.accentColour}; }
window.portal .chooser-view row:selected:hover { background: ${appearance.selectionColour}; }
window.portal .chooser-view row:focus { outline: none; }
/* The multi-selection's picked rows: GTK paints :selected from the selection
   model (which holds the cursor), so the picks carry their own class. Both node
   names are targeted because a ColumnView row's cells are their own node. */
window.portal .chooser-view row.chooser-picked,
window.portal .chooser-view cell.chooser-picked { background: ${appearance.selectionColour}; box-shadow: inset 3px 0 0 ${appearance.accentColour}; }
window.portal .chooser-view > header button > box > arrow { color: ${dim}; }
window.portal .chooser-view > header label { color: ${muted}; }
window.portal .chooser-icon { color: ${icon}; font-size: ${listIconSize}px; }
window.portal .chooser-name { color: ${appearance.textColour}; font-size: ${appearance.fontSize}px; }
window.portal .chooser-meta { color: ${text}; font-size: ${listMetaSize}px; }
window.portal .chooser-empty { color: ${muted}; font-size: 14px; }
window.portal .chooser-hidden { color: ${dim}; }
/* The places rail: the same row language at the rail's tighter metrics. */
window.portal .chooser-places > row:hover { background: ${appearance.hoverColour}; }
window.portal .chooser-places > row:selected,
window.portal .chooser-places > row:selected:hover { background: ${appearance.selectionColour}; }
window.portal .chooser-places > row:focus { box-shadow: none; outline: none; }
window.portal .chooser-place-label { color: ${ink}; }
window.portal .chooser-place-icon { color: ${icon}; }
/* The file-type selector is a GtkDropDown and its toggle button keeps
   Adwaita's filled background, which reads as a bright pill against the card.
   Keep it flat in every state except a press — no hover fill. */
window.portal dropdown > button,
window.portal dropdown > button:hover,
window.portal dropdown > button:active,
window.portal dropdown > button:checked,
window.portal dropdown > button:focus {
  background-color: transparent;
  background-image: none;
  border-color: transparent;
  border-radius: 8px;
  padding: 2px 8px;
  box-shadow: none;
  outline: none;
  color: ${ink};
}
window.portal dropdown > button:hover { background-color: ${appearance.hoverColour}; }
window.portal dropdown > button:active { background-color: ${appearance.selectionColour}; }
window.portal dropdown > button > box > arrow { color: ${dim}; }
/* The button's content is a stack holding the selected item as a LIST ROW, and
   Adwaita paints that row's own hover/selected fill — a second, tighter box
   hugging only the text while the button's highlight wraps the whole control.
   Keep the row and the stack inert so the button owns the only highlight. */
window.portal dropdown > button > box > stack,
window.portal dropdown row,
window.portal dropdown row:hover,
window.portal dropdown row:selected,
window.portal dropdown row:focus {
  background-color: transparent;
  background-image: none;
  box-shadow: none;
  outline: none;
}
/* The button's own metrics, matched to the house control height so it does not
   read squat next to the actionbar buttons. */
window.portal dropdown > button { padding: 4px 8px; }
/* Tooltips are a separate surface and inherit nothing from the card, so they
   render in Adwaita's default box on top of whatever is underneath. */
tooltip { background-color: ${cardSolid}; border-radius: 8px; box-shadow: none; }
tooltip label { color: ${ink}; }
/* The file-type selector's popover is a separate surface, so the card fill and
   the row states have to be repeated for it. */
window.portal popover > contents { background: ${cardSolid}; border-radius: 10px; box-shadow: none; }
/* Rows sit inset vertically so the fill reads as a menu row, but their
   horizontal padding stays within the button's own, because GTK sizes a
   dropdown's popup to AT LEAST its toggle button — any extra width we add to
   the rows pushes the popover wider than the control it drops from. */
window.portal popover list,
window.portal popover listview { background: transparent; padding: 4px 0; }
window.portal popover row {
  background: transparent;
  color: ${ink};
  border-radius: 6px;
  margin: 1px 3px;
  padding: 4px 6px;
}
window.portal popover row:hover { background: ${appearance.hoverColour}; }
window.portal popover row:selected { background: ${appearance.selectionColour}; }
window.portal popover row:focus { box-shadow: none; outline: none; }
`,
})

export function mountPortal(): void {
  // No-op: the D-Bus backend is already owned/exported by ownName().
}

// Request surface: the portal has no real command tree, but the router
// (tinshell-route.sh) probes instances with the empty request + app-name grep —
// without a registered node the `portal=shell,portal` route-map row could
// never match a live instance. `portal ping` gives the probe (and humans)
// a servable check.
register(["portal", "ping"], (_t, res) => {
  res("pong (impl name org.freedesktop.impl.portal.desktop.tinshell-portal)")
})
