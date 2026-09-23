/**
 * common/card/keys.ts — the window-level key backstop every card window
 * installs alongside its focused widget.
 *
 * A card's focused widget (a ColumnView, a canvas, an entry) handles the keys
 * it owns natively; this controller carries the WINDOW's own bindings and the
 * Escape policy, at the default BUBBLE phase, so the focused widget sees a
 * press first. The controller is installed once, by the frame
 * (common/card/frame.ts), never per window binding site.
 */
import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"

/** One window-level binding. Modifier flags are tri-state: `true` requires the
 *  mask, `false` requires it clear, and an omitted flag is not tested at all
 *  (so Ctrl+R binds with or without Shift). */
interface CardKeyBinding {
  /** Gdk.KEY_* keyval. */
  key: number
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  /** Handle the press. Return true when this binding consumed the event; false
   *  lets GTK keep propagating it to the focused widget. */
  run: () => boolean
}

export interface CardKeys {
  /** Escape policy — the app's own back/close action. A plain card window has
   *  no default Escape behaviour, so an app that binds none leaves Escape
   *  unhandled. */
  escape?: () => void
  /** Bindings, in order; the first match wins. */
  bindings: CardKeyBinding[]
}

/** Install the backstop on a card window. */
export function installCardKeys(win: Gtk.Window, keys: CardKeys): void {
  const controller = Gtk.EventControllerKey.new()
  controller.connect("key-pressed", (_c, keyval, _keycode, state) => {
    const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0
    const alt = (state & Gdk.ModifierType.ALT_MASK) !== 0
    const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0

    if (keys.escape && keyval === Gdk.KEY_Escape) {
      keys.escape()
      return true
    }
    for (const b of keys.bindings) {
      if (b.key !== keyval) continue
      if (b.ctrl !== undefined && b.ctrl !== ctrl) continue
      if (b.alt !== undefined && b.alt !== alt) continue
      if (b.shift !== undefined && b.shift !== shift) continue
      return b.run()
    }
    return false
  })
  win.add_controller(controller)
}
