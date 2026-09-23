/**
 * Keyboard theme — dynamic tokens from config.appearance.*, assembled at
 * runtime (the notifications/dock pattern: static structure in style.css,
 * every visible token config-driven). Applied via a display-level provider
 * (refreshCss) so `config set appearance.*` reloads it live.
 */
import { Gdk, Gtk } from "ags/gtk4"
import { get } from "./config"
import { log } from "./log"

function rgba(rgb: number[], alpha: number): string {
  return `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${alpha})`
}

export function buildDynamicCss(): string {
  const panel = rgba(
    get<number[]>("appearance.panel.rgb", [0.09, 0.1, 0.13]),
    get<number>("appearance.panel.alpha", 0.72),
  )
  const key = rgba(
    get<number[]>("appearance.key.rgb", [0.17, 0.18, 0.23]),
    get<number>("appearance.key.alpha", 0.9),
  )
  const keyAction = rgba(
    get<number[]>("appearance.keyAction.rgb", [0.12, 0.13, 0.17]),
    get<number>("appearance.keyAction.alpha", 0.9),
  )
  const keyPressed = rgba(
    get<number[]>("appearance.keyPressed.rgb", [0.33, 0.38, 0.52]),
    get<number>("appearance.keyPressed.alpha", 0.95),
  )
  const text = rgba(
    get<number[]>("appearance.text.rgb", [0.92, 0.93, 0.95]),
    get<number>("appearance.text.alpha", 1),
  )

  return `
/* ── keyboard dynamic tokens (config.appearance.*) ── */
window.keyboard-main .keyboard-root {
  background: ${panel};
}
window.keyboard-main .keycap {
  background: ${key};
  color: ${text};
}
window.keyboard-main .keycap.action {
  background: ${keyAction};
}
window.keyboard-main .keycap:active,
window.keyboard-main .keycap.pressed,
window.keyboard-main .keycap.shift-active {
  background: ${keyPressed};
  color: ${text};
}
`
}

let provider: Gtk.CssProvider | null = null

/** (Re)apply the dynamic CSS at USER priority on the default display. */
export function refreshCss(): void {
  try {
    if (!provider) provider = new Gtk.CssProvider()
    provider.load_from_string(buildDynamicCss())
    const display = Gdk.Display.get_default()
    if (display) {
      Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER)
      log(`refreshCss: applied to display ${display}`)
    } else {
      log("refreshCss: NO DISPLAY")
    }
  } catch (e) {
    log(`refreshCss FAILED: ${e}`)
  }
}
