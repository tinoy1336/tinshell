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
  setTitle(title: string): void
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
    setTitle: (title: string) => win.set_title(title),
  }
}
