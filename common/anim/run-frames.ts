/**
 * Per-frame animation primitive — the cross-app frame source.
 *
 * Gotcha: `add_tick_callback` returns 0 on unrealized widgets,
 * and a tick id is NOT a GLib source id — removing the wrong kind (or a source
 * that already self-removed) CRITICALs "Source ID was not found". This module
 * owns that bookkeeping once: it tries the GTK tick callback, falls back to a
 * GLib.timeout timer when the widget can't take one, and tracks WHICH kind was
 * scheduled so `cancel()` removes only that one. A source that self-removed
 * (step returned false) is guarded so cancel() becomes a no-op.
 *
 * `runFrames(widget, step, framerate?) → { cancel() }`
 *   step(nowUs): boolean — return false to stop; the source self-removes.
 *   framerate?: fallback timer cadence when no tick callback (default 60).
 *
 * `framerate` is a parameter (not read from app config) so this module stays
 * app-agnostic; callers pass their own value if they want non-default cadence.
 */
import GLib from "gi://GLib"
import type Gtk from "gi://Gtk?version=4.0"
import { ignore } from "@common/log/logger"

export interface FrameRunner {
  cancel: () => void
}

export function runFrames(
  widget: Gtk.Widget,
  step: (nowUs: number) => boolean,
  framerate = 60,
): FrameRunner {
  let id: number | null = null
  let isTick = false
  let active = true

  // Wrap step so a false return self-removes and marks the source inactive —
  // cancel() then no-ops instead of removing an already-gone source.
  const wrapped = (nowUs: number): boolean => {
    const cont = step(nowUs)
    if (!cont) {
      active = false
      id = null
    }
    return cont
  }

  const tickId = (widget as any).add_tick_callback((_w: Gtk.Widget, frameClock: any): boolean => {
    if (!active) return false
    const now = frameClock?.get_frame_time?.() ?? GLib.get_monotonic_time()
    return wrapped(now)
  })
  if (tickId !== 0 && tickId !== undefined) {
    id = tickId
    isTick = true
  } else {
    // Unrealized widget — fall back to a timer at the requested framerate.
    isTick = false
    id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(1000 / framerate), () =>
      wrapped(GLib.get_monotonic_time()) ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE,
    )
  }

  return {
    cancel: () => {
      if (id !== null && active) {
        active = false
        try {
          if (isTick) (widget as any).remove_tick_callback(id)
          else GLib.source_remove(id)
        } catch (e) {
          // The frame source is already gone (widget unrealized or removed).
          ignore("run-frames cancel", e)
        }
      }
      id = null
    },
  }
}
