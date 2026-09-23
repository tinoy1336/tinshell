/**
 * common/media/types.ts — the media layer's contracts: what a file IS
 * (MediaKind), what a decoded still hands its consumer (StillImage), and the
 * transport surface a playing pipeline exposes.
 *
 * The layer decodes and plays. It owns no window, no MPRIS identity and no
 * config: a consumer supplies its own poll period and chrome and receives
 * these types back.
 */

import type Gdk from "gi://Gdk?version=4.0"
import type Cairo from "cairo"

/** The kind of media a path names. An `animated-image` is a format that can
 *  carry motion (GIF, WebP); a still consumer renders its first frame. */
export type MediaKind = "image" | "animated-image" | "audio" | "video" | "other"

/** A still image decoded from disk. `surface()` is LAZY — it costs a temp-PNG
 *  round-trip, so only a consumer that needs raw pixels (an editor, an export)
 *  calls it. */
export interface StillImage {
  readonly path: string
  readonly texture: Gdk.Texture
  readonly width: number
  readonly height: number
  /** The image's pixels as a `Cairo.ImageSurface`, same dimensions. */
  surface(): Cairo.ImageSurface
}

/** One queue entry, as the consumer's playlist shows it. */
export interface PlaylistEntry {
  filename: string
  title?: string
  current?: boolean
  playing?: boolean
}

/** One event pushed through `MediaPipeline.onEvent` (a single bridge per
 *  pipeline instance). */
export interface MediaEvent {
  kind:
    | "state"
    | "position"
    | "title"
    | "volume"
    | "playlist"
    | "ended"
    | "error"
    | "paintable"
    | "art"
  playing?: boolean
  timePos?: number | null
  duration?: number | null
  title?: string
  volume?: number
  muted?: boolean
  playlist?: PlaylistEntry[]
  pos?: number
  paintable?: Gdk.Paintable | null
  art?: Gdk.Paintable | null
  message?: string
}

/** The transport state a consumer reads on demand (commands, MPRIS). */
export interface MediaStatus {
  timePos: number | null
  duration: number | null
  title: string
  artist: string
  album: string
  pause: boolean
  volume: number
  mute: boolean
  speed: number
  playlist: PlaylistEntry[]
}

/** A self-contained playback backend: pipeline + queue + event subscribers.
 *  One instance per consumer window; the consumer owns which instance its
 *  commands and MPRIS reflect. */
export interface MediaPipeline {
  /** Subscribe to UI events; returns an unsubscribe fn. */
  onEvent(cb: (ev: MediaEvent) => void): () => void
  /** Replace the queue with one entry and play it. */
  open(pathOrUrl: string): void
  /** Append an entry and play it (queue + play). */
  append(pathOrUrl: string): void
  toggle(): void
  play(): void
  pause(): void
  /** Absolute seek to a time in seconds. */
  seekSeconds(sec: number): void
  setVolume(v0to100: number): void
  getVolume(): number
  toggleMute(): void
  /** Playback rate via a rate-seek at the current position. */
  setSpeed(x: number): void
  next(): void
  prev(): void
  playIndex(i: number): void
  removeIndex(i: number): void
  clearPlaylist(): void
  shufflePlaylist(): void
  getPlaylist(): PlaylistEntry[]
  getStatus(): MediaStatus
  /** The Gdk.Paintable for this instance's output area (null until a frame
   *  flowed, always null for audio-only). */
  getVideoPaintable(): Gdk.Paintable | null
  /** Stop the pipeline + drop all state/subscribers. */
  shutdown(): void
}
