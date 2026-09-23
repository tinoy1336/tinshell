/**
 * Popup dismiss helpers — shared by the launcher and the clipboard picker
 * (both layer-surface popups with the same three dismissal paths).
 *
 * Dismiss semantics (the three paths every such popup uses):
 *   - Escape (window-level key controller, consume the key so it never leaks
 *     to the window behind — keymode EXCLUSIVE surfaces).
 *   - click outside the card bounds (Gtk.GestureClick + Graphene
 *     compute_bounds/contains_point — Graphene.Rect.contains_point THROWS at
 *     runtime on this gjs build, so bounds are computed via
 *     compute_bounds(win) which returns a Graphene rect already in window
 *     coordinates).
 *   - focus loss (notify::is-active while visible).
 *
 * Each binder is a plain function — no window state required. The caller
 * keeps its own show/hide and passes them in.
 */

import Graphene from "gi://Graphene"
import { ignore } from "@common/log/logger"
import { type Astal, Gdk, Gtk } from "ags/gtk4"

/** Escape dismisses: window-level key controller, returns true (consumed). */
export function bindEscape(win: Astal.Window, onEscape: () => void): void {
  const keyCtrl = new Gtk.EventControllerKey()
  keyCtrl.connect("key-pressed", (_c: any, keyval: number) => {
    if (keyval === Gdk.KEY_Escape) {
      onEscape()
      return true
    }
    return false
  })
  win.add_controller(keyCtrl)
}

/**
 * Click outside the `card` bounds dismisses. `card` must be a descendant of
 * `win` (its bounds are computed in window coordinates via compute_bounds).
 */
export function bindOutsideClick(win: Astal.Window, card: Gtk.Widget, onOutside: () => void): void {
  const click = new Gtk.GestureClick()
  click.connect("pressed", (_g: Gtk.GestureClick, _n: number, x: number, y: number) => {
    if (!win.visible) return
    try {
      const [, rect] = card.compute_bounds(win)
      if (!rect) return
      const point = new Graphene.Point({ x, y })
      if (!rect.contains_point(point)) onOutside()
    } catch (e) {
      // A failed bounds check must not dismiss the popup.
      ignore("popup bounds check", e)
    }
  })
  win.add_controller(click)
}

/** Focus loss while visible dismisses (Astal window is-active notify). */
export function bindFocusLoss(win: Astal.Window, onLost: () => void): void {
  win.connect("notify::is-active", () => {
    if (!win.is_active && win.visible) onLost()
  })
}
