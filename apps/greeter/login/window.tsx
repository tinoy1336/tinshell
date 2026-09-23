/**
 * GreeterWindow — the fullscreen layer-shell window that hosts the login card.
 *
 * Lives in a .tsx file because JSX only parses in .tsx (the build entry is
 * app.ts — plain .ts, per the shared bundler's <app>/app.ts convention).
 *
 * Production window: namespace "greeter" (the greeter compositor's blur
 * layerrule in /etc/greetd/greeter.lua), OVERLAY layer, all edges anchored =
 * fullscreen, keymode EXCLUSIVE (a login screen grabs every key). Escape
 * clears the password + error as a window-level backstop. The window paints
 * NO wallpaper of its own — the compositor's wallpaper layer + its blur rule
 * are the login screen's backdrop and frost.
 */

import Gio from "gi://Gio"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GreeterDock from "../strip/Strip"
import type { LoginCardHandle } from "./card"

// Greeter (login) wallpaper — synced to this world-readable path by the lock
// screen (and a logout hook) so the login card sits on the last-used wallpaper.
export const GREETER_WALLPAPER = "/etc/greetd/ags-greeter/wallpaper.png"

const FULLSCREEN_ANCHORS =
  Astal.WindowAnchor.TOP |
  Astal.WindowAnchor.BOTTOM |
  Astal.WindowAnchor.LEFT |
  Astal.WindowAnchor.RIGHT

/** Fullscreen wallpaper picture behind the card; falls back to the plain
 *  card if the texture fails (missing file, bad format, ...). `extraOverlay`
 *  (e.g. the bottom-centre greeter dock) rides on top of the wallpaper; a
 *  null overlay (a failed strip) keeps the wallpaper and drops only the
 *  overlay. */
export function wallpaperBackdrop(
  path: string,
  card: Gtk.Widget,
  extraOverlay?: Gtk.Widget | null,
): Gtk.Widget {
  try {
    const tex = Gdk.Texture.new_from_file(Gio.File.new_for_path(path))
    const pic = new Gtk.Picture()
    pic.paintable = tex
    pic.content_fit = Gtk.ContentFit.COVER
    pic.halign = Gtk.Align.FILL
    pic.valign = Gtk.Align.FILL
    pic.hexpand = true
    pic.vexpand = true
    pic.add_css_class("greeter-wallpaper")
    const overlay = new Gtk.Overlay()
    overlay.set_child(pic)
    overlay.add_overlay(card)
    if (extraOverlay) overlay.add_overlay(extraOverlay)
    return overlay
  } catch (e: any) {
    console.error(`[greeter] wallpaper backdrop failed: ${e?.message ?? e}`)
    return card
  }
}

/** No-wallpaper fallback: card + dock stacked on an Overlay (the dock keeps
 *  its bottom-centre alignment from its own widget properties). A null
 *  overlay composes the card alone. */
export function overlayBackdrop(card: Gtk.Widget, extraOverlay?: Gtk.Widget | null): Gtk.Widget {
  const overlay = new Gtk.Overlay()
  overlay.set_child(card)
  if (extraOverlay) overlay.add_overlay(extraOverlay)
  return overlay
}

/** Escape clears the password + status (a login screen never unlocks on Esc). */
export function makeEscapeController(handle: LoginCardHandle): Gtk.EventControllerKey {
  const key = new Gtk.EventControllerKey()
  key.connect("key-pressed", (_c: any, keyval: number) => {
    if (keyval === Gdk.KEY_Escape) {
      handle.clearStatus()
      handle.resetPassword()
      return true
    }
    return false
  })
  return key
}

export default function GreeterWindow(child: Gtk.Widget, handle: LoginCardHandle): Astal.Window {
  let win!: Astal.Window

  // getWindow resolves at panel-open time (user interaction), long after the
  // window exists — but at DOCK BUILD time it is still undefined, so the
  // strip's substrate falls back to its own row for the panel-escape
  // controller (Escape-during-drag is inert in the login deployment only).
  //
  // The strip is decoration: a failure building it must never keep the CARD
  // from mapping (a login screen with no card is a wallpaper-only VT — no
  // retry, no way in).
  let winRef: Gtk.Window | null = null
  let dock: Gtk.Widget | null = null
  try {
    dock = GreeterDock({ getWindow: () => winRef })
  } catch (e: any) {
    console.error(`[greeter] applet strip failed: ${e?.message ?? e}`)
  }

  // The login window is TRANSPARENT: the greeter compositor's own wallpaper
  // layer (awww, /etc/greetd/ags-greeter/wallpaper.png) shows through it, and
  // the compositor's blur layer rule for namespace "greeter" frosts the card
  // AND the applet strip. Painting an app-side wallpaper picture here would
  // make the window opaque and kill that frost — the strip would then read as
  // a flat copy of the dock's glass instead of the same frosted surface.
  const content = dock ? overlayBackdrop(child, dock) : child

  const el = (
    <window
      namespace="greeter"
      class="greeter"
      name="greeter"
      layer={Astal.Layer.OVERLAY}
      keymode={Astal.Keymode.EXCLUSIVE}
      anchor={FULLSCREEN_ANCHORS}
      exclusivity={Astal.Exclusivity.IGNORE}
      visible
      $={(self) => {
        win = self
        winRef = self as unknown as Gtk.Window
        self.add_controller(makeEscapeController(handle))
      }}
    >
      {content}
    </window>
  )
  void el
  return win
}
