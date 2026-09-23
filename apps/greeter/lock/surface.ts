/**
 * lock-surface — the lock screen's per-monitor surface builder.
 *
 * The `::monitor` signal fires AFTER the compositor lock is held, so a throw
 * inside the handler is unrecoverable: the window is never assigned for that
 * output, Hyprland renders no lock frame from the client and keeps the session
 * LOCKED (its own "lockdead" fallback), leaving a TTY as the only way back.
 *
 * This builder therefore makes the assignment unconditional:
 *   - the card is built first (it is the one part a lock surface cannot do
 *     without); if it throws, a MINIMAL surface is assigned instead — a window
 *     that exists so the compositor has a frame, carrying no credential input;
 *   - the applet strip is decoration: if it throws, the surface is composed
 *     WITHOUT it — the strip is dropped, never the backdrop it rides on;
 *   - every failure is logged with its reason, and no exception escapes.
 *
 * Every part is a parameter (including the window shell and the minimal
 * surface), so the fallback path is exercised without a display or a
 * compositor: apps/greeter/dev/lock-surface.probe.ts drives this function with a
 * throwing strip factory and stub windows.
 */
import { Gtk } from "ags/gtk4"
import type { LoginCardHandle } from "../login/card"

/** Class the minimal surface carries — also the probe's marker. */
export const LOCK_FALLBACK_CLASS = "greeter-lock-fallback"

interface LockSurfaceParts {
  /** The card and its Escape target. */
  card: () => { widget: Gtk.Widget; handle: LoginCardHandle }
  /** The applet strip, built from the window it rides in. */
  strip: (win: Gtk.Window) => Gtk.Widget
  /** Compose card + strip into the window child (wallpaper backdrop, or the
   *  plain overlay). `strip` is null when the strip failed to build — the
   *  composition still runs so the backdrop survives a strip defect. */
  compose: (card: Gtk.Widget, strip: Gtk.Widget | null) => Gtk.Widget
  /** Attach the Escape backstop to the window. */
  escape: (win: Gtk.Window, handle: LoginCardHandle) => void
  /** Minimal surface for the card-failure path (default: a "Locked" notice). */
  fallback?: () => Gtk.Widget
  /** The window shell — injectable so the fallback path needs no display. */
  makeWindow?: () => Gtk.Window
}

interface LockSurfaceResult {
  /** True when the card (with or without its strip) was assigned. */
  ok: boolean
  /** Why the minimal surface was assigned instead, when it was. */
  error?: string
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The default minimal surface: it exists so this output has a lock frame and
 *  says so, and it carries NO credential input (nothing sensitive). */
function minimalSurface(): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 })
  box.halign = Gtk.Align.CENTER
  box.valign = Gtk.Align.CENTER
  const title = new Gtk.Label({ label: "Locked" })
  title.add_css_class("greeter-fallback-title")
  const hint = new Gtk.Label({ label: "The lock screen failed to load." })
  hint.add_css_class("greeter-fallback-hint")
  box.append(title)
  box.append(hint)
  return box
}

/** Build the lock surface for ONE monitor and always hand a window to `assign`.
 *  Never throws: the last resort reports instead of escaping into the signal
 *  handler (an escaping throw is exactly the unassigned-output lockout). */
export function buildLockSurface(
  parts: LockSurfaceParts,
  assign: (win: Gtk.Window, monitor: unknown) => void,
  monitor: unknown,
): LockSurfaceResult {
  const makeWindow = parts.makeWindow ?? (() => new Gtk.Window())

  const minimal = (error: string): LockSurfaceResult => {
    try {
      const win = makeWindow()
      win.add_css_class("greeter-lock")
      win.add_css_class(LOCK_FALLBACK_CLASS)
      win.set_child((parts.fallback ?? minimalSurface)())
      assign(win, monitor)
      return { ok: false, error }
    } catch (e) {
      const fatal = `${error}; minimal surface failed: ${reason(e)}`
      console.error(`[lock] ${fatal}`)
      return { ok: false, error: fatal }
    }
  }

  let card: { widget: Gtk.Widget; handle: LoginCardHandle }
  try {
    card = parts.card()
  } catch (e) {
    const error = `login card: ${reason(e)}`
    console.error(`[lock] ${error} — assigning the minimal lock surface`)
    return minimal(error)
  }

  try {
    const win = makeWindow()
    win.add_css_class("greeter-lock")
    let strip: Gtk.Widget | null = null
    try {
      strip = parts.strip(win)
    } catch (e) {
      // Decoration only: losing the strip costs the applet cells, never the
      // card and never the backdrop the card sits on.
      console.error(`[lock] applet strip: ${reason(e)} — composing without the strip`)
    }
    parts.escape(win, card.handle)
    win.set_child(parts.compose(card.widget, strip))
    assign(win, monitor)
    return { ok: true }
  } catch (e) {
    const error = `lock window: ${reason(e)}`
    console.error(`[lock] ${error} — assigning the minimal lock surface`)
    return minimal(error)
  }
}
