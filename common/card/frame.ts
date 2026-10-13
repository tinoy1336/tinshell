/**
 * common/card/frame.ts — the card toplevel every card app builds its window
 * on: a plain XDG Gtk.Window (NOT layer-shell), the house card shape, and the
 * vertical root the app fills.
 *
 * The toplevel shape lives here: the app CSS class, no titlebar, the 520x360
 * minimum, the Wayland app_id override and `app.add_window`. Above it sits the
 * card COMPOSITION: the header slot, the window's key backstop, and the
 * present/close/title lifecycle the request handlers drive. The window's
 * default size comes from the app's config (`window.width`/`height`) and the
 * Hyprland rule owns the frost, rounding and the pinned size — so nothing here
 * resizes a mapped window.
 */
import Gtk from "gi://Gtk?version=4.0"
import { scheduleCollect } from "@common/app/collect"
import { ignore } from "@common/log/logger"
import { setAppId } from "@common/window/app-id"
import app from "ags/gtk4/app"
import { type CardKeys, installCardKeys } from "./keys"

interface CardFrameOptions {
  /** App name: the window's CSS class and its card-theme scope (e.g. "files"). */
  app: string
  /** Wayland app_id (WM_CLASS) — matched by the app's Hyprland window rule. */
  appId: string
  title: string
  defaultWidth: number
  defaultHeight: number
  modal?: boolean
  /** Header row, appended as the root's first child — a `createCardHeader()`
   *  box (common/card/header). */
  header?: Gtk.Widget
  /** Window-level key backstop (common/card/keys). */
  keys?: CardKeys
}

export interface CardFrame {
  /** The toplevel — for the app's own signals (`map`, `close-request`). */
  win: Gtk.Window
  /** The vertical root: the header is already its first child, and the body,
   *  the status bar and the action bar follow in that order. */
  root: Gtk.Box
  present(): void
  /** Request the close: GTK emits `close-request`, which is where the app's
   *  teardown and destroy live. */
  close(): void
  /** Destroy the toplevel AND release the application's own reference to it.
   *
   *  `app.add_window` takes a reference of its own, and a toplevel that still
   *  carries it is never finalised: its gjs wrapper, every closure connected to
   *  its signals and the whole widget tree those closures capture stay
   *  reachable — one window's worth of them per open/close cycle, which is the
   *  residue a card app leaks when it calls `win.destroy()` directly. Every
   *  close path goes through here. */
  destroy(): void
  setTitle(title: string): void
}

/** Detach a widget and everything under it, and dispose each one.
 *
 *  A child the window still holds has a C reference of its own, and a
 *  C-referenced wrapper keeps its JavaScript closures reachable; when one of
 *  those closures can reach the window, the two form a cycle that spans C and
 *  JavaScript. Unparenting drops the tree's C references, and disposing each
 *  widget on the way out drops the signal connections it holds — the closures
 *  those connections keep are what stays behind otherwise, measured as roughly
 *  one window's worth of handler closures per open and close. */
function detachSubtree(widget: Gtk.Widget): void {
  let child = widget.get_first_child()
  while (child) {
    const next = child.get_next_sibling()
    child.unparent()
    detachSubtree(child)
    try {
      child.run_dispose()
    } catch (e) {
      ignore("card widget dispose", e)
    }
    child = next
  }
}

/** Build the card toplevel, its root box and its header slot. */
export function createCardFrame(opts: CardFrameOptions): CardFrame {
  const win = new Gtk.Window({
    title: opts.title,
    default_width: opts.defaultWidth,
    default_height: opts.defaultHeight,
    modal: !!opts.modal,
  })
  win.add_css_class(opts.app)
  win.set_titlebar(null)
  win.set_size_request(520, 360)
  setAppId(win, opts.appId)
  app.add_window(win)

  const root = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    hexpand: true,
    vexpand: true,
  })
  win.child = root

  if (opts.header) root.append(opts.header)
  if (opts.keys) installCardKeys(win, opts.keys)
  return {
    win,
    root,
    present: () => win.present(),
    close: () => win.close(),
    destroy: () => {
      try {
        app.remove_window(win)
      } catch (e) {
        // Already unlisted (a second close, or destruction under way): the
        // destroy below is what the caller asked for either way.
        ignore("card window release", e)
      }
      // Detach the widget tree BEFORE destroying the window. A child the window
      // still holds carries a C reference of its own, and a C-referenced wrapper
      // keeps its JavaScript closures reachable; a handler on a child that can
      // reach the window closes a cycle which spans C and JavaScript, and such a
      // cycle survives every collection — measured on this shell, a card window
      // holding one button with a handler left a whole window behind on every
      // open/close, while the same window without the handler left none.
      // Unparenting the tree leaves each widget held by its wrapper alone.
      if (win.child) {
        const outer = win.child
        win.child = null
        detachSubtree(outer)
        try {
          outer.run_dispose()
        } catch (e) {
          ignore("card root dispose", e)
        }
      }
      win.set_focus(null)
      win.destroy()
      // The closed window's wrapper objects (widgets, controllers, the closures
      // they carry) are gjs garbage the engine will not collect on its own —
      // widget construction moves C memory, not JS bytes. One deferred
      // collection per burst of closes recovers what the collector would not.
      scheduleCollect()
    },
    setTitle: (title: string) => win.set_title(title),
  }
}
