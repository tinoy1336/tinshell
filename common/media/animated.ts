/**
 * Animated image playback — pure GDK, no media backend.
 *
 * Consumers: the clipboard picker's image rows and the media app's viewer,
 * which both show a still image inline and must not lose the motion of an
 * animated GIF or WebP. `Gtk.MediaFile` is GTK's usual route, but this GTK
 * build ships no GtkMediaFile implementation at all: constructing one aborts the
 * process with "GTK was run without any GtkMediaFile extension being present."
 * So the frames are decoded with GdkPixbuf — which animated GIFs and animated
 * WebP both go through — scaled once to the consumer's display size, and handed
 * over as textures on a per-frame timeout.
 *
 * A player OWNS its timer: `start()` schedules the first frame, `stop()` clears
 * it, and no state lives at module scope, so two rows cannot fight over one
 * animation clock. Frames are scaled before they become textures, which keeps a
 * large animation's decode cost per frame instead of per pixel on the row.
 */
import Gdk from "gi://Gdk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import { ignore } from "@common/log/logger"

/** Longest edge a frame is scaled to — the picker row's display size. */
const FRAME_PX = 96

/** A frame delay below this is treated as this (some encoders emit 0 ms). */
const MIN_DELAY_MS = 20

export interface AnimatedPlayer {
  /** Start (or resume) the animation clock. Idempotent. */
  start(): void
  /** Stop the clock; the last painted frame stays on screen. */
  stop(): void
  /** Whether the clock is running. */
  isRunning(): boolean
  /** Frames painted since this player was built (diagnostic). */
  frames(): number
}

/**
 * Build a player over `path`, calling `onFrame` with each decoded texture.
 * Returns null when the file is not decodable as an animation.
 */
export function createAnimatedPlayer(
  path: string,
  onFrame: (texture: Gdk.Texture) => void,
  maxPx: number = FRAME_PX,
): AnimatedPlayer | null {
  let animation: GdkPixbuf.PixbufAnimation
  try {
    animation = GdkPixbuf.PixbufAnimation.new_from_file(path)
  } catch (e) {
    ignore("clipboard gif open", e)
    return null
  }

  let iter: GdkPixbuf.PixbufAnimationIter | null = null
  let timer = 0
  let painted = 0

  const paint = (): void => {
    if (!iter) return
    try {
      const pixbuf = iter.get_pixbuf()
      if (!pixbuf) return
      const w = pixbuf.get_width()
      const h = pixbuf.get_height()
      const scale = Math.min(1, maxPx / Math.max(w, h, 1))
      const scaled =
        scale < 1
          ? pixbuf.scale_simple(
              Math.max(1, Math.round(w * scale)),
              Math.max(1, Math.round(h * scale)),
              GdkPixbuf.InterpType.BILINEAR,
            )
          : pixbuf
      if (!scaled) return
      onFrame(Gdk.Texture.new_for_pixbuf(scaled))
      painted++
    } catch (e) {
      ignore("clipboard gif frame", e)
    }
  }

  const tick = (): boolean => {
    timer = 0
    if (!iter) return GLib.SOURCE_REMOVE
    try {
      // `advance` answers whether the frame changed; a null time lets the
      // iterator decide from its own clock, which is what a fixed-delay loop
      // wants (the timer already encodes the delay).
      iter.advance(null)
      paint()
      const delay = Math.max(MIN_DELAY_MS, iter.get_delay_time())
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, tick)
    } catch (e) {
      ignore("clipboard gif advance", e)
    }
    return GLib.SOURCE_REMOVE
  }

  return {
    start(): void {
      if (timer !== 0) return
      try {
        iter = animation.get_iter(null)
      } catch (e) {
        ignore("clipboard gif iter", e)
        return
      }
      paint()
      const delay = (() => {
        try {
          return Math.max(MIN_DELAY_MS, iter?.get_delay_time() ?? MIN_DELAY_MS)
        } catch {
          return MIN_DELAY_MS
        }
      })()
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, tick)
    },
    stop(): void {
      if (timer !== 0) {
        GLib.source_remove(timer)
        timer = 0
      }
    },
    isRunning(): boolean {
      return timer !== 0
    },
    frames(): number {
      return painted
    },
  }
}
