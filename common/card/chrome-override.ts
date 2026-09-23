/**
 * common/card/chrome-override.ts — the stylesheet a card app must apply ON TOP
 * of the shared chrome: the rules that have to out-rank `card-chrome` (a denser
 * header control box, trimmed header padding) without living in the app's own
 * sheet.
 *
 * GTK compares provider PRIORITY before specificity, so such a rule cannot be
 * carried by the app's stylesheet: in a resident instance the boot sheet holds
 * an eager card app's chrome at `STYLE_PROVIDER_PRIORITY_USER`, while a lazy
 * app's own sheet arrives at `STYLE_PROVIDER_PRIORITY_APPLICATION`
 * (common/app/lazy). This adds the app's provider at USER priority, i.e. after
 * the boot sheet, so its rules win by priority rather than by selector weight.
 */
import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import { log } from "@common/log/logger"

/** The apps whose override provider is already on the display. */
const applied = new Set<string>()

/** Add `app`'s chrome override to the display. ONE provider per app per
 *  process: the first call wins and the provider is never removed — removing a
 *  provider after the app's windows closed triggers a GTK restyle storm
 *  (common/app/lazy's cssProviders rule) — so a later call (a re-mount) is a
 *  no-op instead of a stacked duplicate. A CSS load that throws leaves the
 *  shared chrome in place (every window still works, its header is only as wide
 *  as the shared chrome made it) and is named in the app's log. */
export function applyChromeOverride(app: string, css: string): void {
  if (applied.has(app)) return
  try {
    const display = Gdk.Display.get_default()
    if (!display) return
    const provider = new Gtk.CssProvider()
    provider.load_from_string(css)
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER)
    applied.add(app)
  } catch (e) {
    log(`[${app}] chrome override css failed: ${String(e)}`)
  }
}
