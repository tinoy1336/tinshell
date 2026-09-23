/**
 * common/media/pipeline.ts — GStreamer playback: one self-contained playbin3
 * pipeline per consumer window, with its own queue and event subscribers.
 *
 * `createMediaPipeline()` returns an instance holding the pipeline, the
 * playlist and the subscriber list; the CONSUMER owns the registry of
 * instances and decides which one its commands and MPRIS reflect. Nothing
 * here reads app config or names bus objects — the consumer passes the poll
 * period and keeps the identity. `Gst.init` runs on the FIRST PLAY (see
 * `ensureGst`), never at module scope: a resident eager consumer must not
 * charge every boot a GStreamer registry scan for a feature most sessions
 * never use.
 *
 * Why a raw playbin3 pipeline and NOT GstPlay.Play: GstPlay.Play exposes its
 * video sink only through the GstPlay.PlayVideoRenderer interface, and GJS
 * cannot IMPLEMENT GObject interfaces (vfunc lookup fails — verified), so a
 * custom renderer is impossible from GJS. playbin3 has a plain settable
 * `video-sink` property instead — point it at gtk4paintablesink
 * (gst-plugin-gtk4, extra repo) and drop the sink's `paintable`
 * (Gdk.Paintable) into a Gtk.Picture. Audio works without that plugin
 * (default auto sink); video shows a placeholder until it is installed.
 *
 * The queue is managed HERE (plain array) — playbin3 plays one URI at a time;
 * EOS advances the queue (auto-next) or stops at the end.
 */

import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gst from "gi://Gst"
import { log } from "@common/log/logger"
import type { MediaEvent, MediaPipeline, MediaStatus, PlaylistEntry } from "./types"

/** Default position-poll period when the consumer passes none. */
const DEFAULT_POLL_MS = 1000

interface MediaPipelineOptions {
  /** Position poll period in ms; clamped to >= 250. playbin3 has no
   *  position-updated signal, so the UI timeline is this poll. */
  pollIntervalMs?: number
}

// ── GStreamer init (idempotent, process-wide, first play only) ──
let gstReady = false
function ensureGst(): void {
  if (gstReady) return
  // Keep playback off the dGPU. NVIDIA NVDEC (nvh264dec) ties VA-API at rank
  // 257 and wins playbin3's auto-plugging order, so decode runs on the
  // discrete GPU even though the VK/EGL pins route RENDERING to the iGPU (the
  // pins don't cover the decoder path). Rank down every nvcodec DECODER by
  // ELEMENT name (GST_PLUGIN_FEATURE_RANK takes feature names, not plugin
  // names — `nvcodec:0` is silently ignored) so playbin3 uses VA-API (iGPU)
  // or software decode instead.
  GLib.setenv(
    "GST_PLUGIN_FEATURE_RANK",
    "nvh264dec:0,nvh265dec:0,nvvp8dec:0,nvvp9dec:0,nvav1dec:0,nvjpegdec:0,nvmpeg2videodec:0,nvmpeg4videodec:0,nvmpegvideodec:0",
    true,
  )
  Gst.init([])
  gstReady = true
}

/** One self-contained playback backend (pipeline + queue + subscribers). */
export function createMediaPipeline(opts: MediaPipelineOptions = {}): MediaPipeline {
  const pollMs = Math.max(250, opts.pollIntervalMs ?? DEFAULT_POLL_MS)

  // ── live state (single source of truth = this instance's playbin3) ──
  let pipeline: Gst.Element | null = null
  let videoSink: Gst.Element | null = null
  let paintable: Gdk.Paintable | null = null
  let lastEmittedPaintable: Gdk.Paintable | null = null // dedupe: paintable events are driven by post-preroll property reads, not notify::paintable
  let lastEmittedArt: Gdk.Paintable | null = null // dedupe: album art (TAG message image sample) — emit once per file
  let playlist: PlaylistEntry[] = []
  let playlistPos = -1
  let playing = false
  let ended = false // EOS-stop flag: playbin3 stays in PLAYING at EOS (no auto-pause),
  // so the pipeline state alone cannot express "stopped" — this flag is the authority.
  let volume = 100 // 0-100 (pipeline property is 0-1)
  let muted = false
  let rate = 1
  let title = ""
  let artist = ""
  let album = ""
  let pollTimer = 0
  let warnLogged = false
  let shuttingDown = false
  let subs: Array<(ev: MediaEvent) => void> = []

  function emit(ev: MediaEvent): void {
    for (const s of [...subs]) {
      try {
        s(ev)
      } catch (e) {
        log(`media event handler failed: ${(e as Error).message}`)
      }
    }
  }

  // ── pipeline lifecycle ──

  function createPipeline(): Gst.Element | null {
    ensureGst()
    const pipe = Gst.ElementFactory.make("playbin3", "media-pipeline")
    if (!pipe) {
      log("playbin3 unavailable — GStreamer broken?")
      return null
    }
    pipe.set_property("force-aspect-ratio", true)
    const bus = pipe.get_bus()
    if (!bus) {
      log("playbin3 bus unavailable")
      return pipe
    }
    bus.add_signal_watch()
    bus.connect("message", (_b: Gst.Bus, msg: Gst.Message) => onBusMessage(pipe, msg))
    return pipe
  }

  /** Remove the current pipeline entirely. A FRESH playbin3 per media load —
   * reusing one via set_uri made `status` go stale after EOS auto-advance
   * (playbin3 keeps the previous stream's duration/position/state across a
   * URI swap until the new stream is ready). */
  function teardownPipeline(): void {
    if (pipeline) {
      const bus = pipeline.get_bus()
      if (bus) bus.remove_signal_watch()
      pipeline.set_state(Gst.State.NULL)
      pipeline = null
    }
    videoSink = null
    paintable = null
    lastEmittedPaintable = null
    lastEmittedArt = null
    artist = ""
    album = ""
    // Reset the output area: a stale frame from the previous file must not
    // linger while the fresh pipeline prerolls.
    emit({ kind: "paintable", paintable: null })
    emit({ kind: "art", art: null })
  }

  /** Attach the gtk4paintablesink video sink (missing → audio only, logged once). */
  function attachVideoSink(pipe: Gst.Element): void {
    const sink = Gst.ElementFactory.make("gtk4paintablesink", "media-video-sink")
    videoSink = sink
    if (sink) {
      pipe.set_property("video-sink", sink)
      // The sink creates its Gdk.Paintable lazily — push it to the UI when
      // it appears (the Gtk.Picture binds it; placeholder hides itself).
      sink.connect("notify::paintable", () => {
        paintable = ((sink as any).paintable as Gdk.Paintable | null) ?? null
        if (paintable) lastEmittedPaintable = paintable // keep the dedupe guard coherent
        log(
          paintable
            ? `video paintable ready (${paintable.get_intrinsic_width()}x${paintable.get_intrinsic_height()})`
            : "video paintable null",
        )
        emit({ kind: "paintable", paintable })
      })
    } else if (!warnLogged) {
      log("gtk4paintablesink missing (install gst-plugin-gtk4) — video output disabled, audio only")
      warnLogged = true
    }
  }

  function ensurePipeline(): void {
    if (pipeline) return
    pipeline = createPipeline()
    if (!pipeline) return
    attachVideoSink(pipeline)
    startPolling()
  }

  /** Fresh pipeline per media load: teardown + rebuild + play. */
  function buildPipeline(uri: string): void {
    teardownPipeline()
    const pipe = createPipeline()
    if (!pipe) {
      log("playbin3 unavailable — cannot play")
      emit({ kind: "error", message: "playbin3 unavailable" })
      return
    }
    pipeline = pipe
    attachVideoSink(pipe)
    // New media: a previous EOS-stop must not leak into the fresh stream.
    ended = false
    emit({ kind: "position", timePos: 0, duration: null })
    pipe.set_property("uri", uri)
    pipe.set_state(Gst.State.PLAYING)
  }

  /** gtk4paintablesink never fires notify::paintable (verified empirically:
   * paintable property readable at 640x360 after preroll, signal fired 0x), so
   * the UI paintable bind is driven by reading the sink property post-preroll
   * (ASYNC_DONE / STATE_CHANGED→PLAYING), deduped to one emit per paintable. */
  function emitSinkPaintable(): void {
    if (!videoSink) return
    let pt: Gdk.Paintable | null = null
    try {
      pt = ((videoSink as any).paintable as Gdk.Paintable | null) ?? null
    } catch {
      pt = null // null-GType: property not ready yet
    }
    if (pt && pt !== lastEmittedPaintable) {
      const w = pt.get_intrinsic_width()
      const h = pt.get_intrinsic_height()
      if (w <= 0 || h <= 0) {
        // 0x0 paintable = no real video frame (e.g. an audio file's mjpeg
        // attached_pic stream). Don't surface it — let album art (TAG image)
        // fill the picture instead of a blank frame.
        return
      }
      paintable = pt
      lastEmittedPaintable = pt
      log(`video paintable ready (${w}x${h})`)
      emit({ kind: "paintable", paintable: pt })
    }
  }

  function onBusMessage(pipe: Gst.Element, msg: Gst.Message): void {
    switch (msg.type) {
      case Gst.MessageType.EOS:
        emit({ kind: "ended" })
        advanceOrStop()
        break
      case Gst.MessageType.ASYNC_DONE:
        // A pending async state change completed (URI swap / seek preroll) —
        // re-derive position + duration so the previous stream's values never
        // survive a media change (playbin3 keeps the old duration across a
        // set_uri until the new stream is ready).
        emit({
          kind: "position",
          timePos: currentPositionSec(),
          duration: durationSec(),
        })
        emitSinkPaintable()
        break
      case Gst.MessageType.TAG: {
        // Stream tags (mp3 ID3 APIC / m4a covr / flac PICTURE / ogg
        // METADATA_BLOCK_PICTURE) carry embedded cover art as an image sample.
        // Decode it into a Gdk.Texture and surface it to the UI — audio-only
        // files have no video paintable, so the album art fills the output
        // area instead of the placeholder.
        const taglist = msg.parse_tag()
        let sample: Gst.Sample | null = null
        if (taglist) {
          // Surface stream tags for the consumer's metadata (playbin3 re-posts
          // TAG messages; guard each string so the first non-empty value sticks).
          const [hasArtist, artistVal] = taglist.get_string("artist")
          if (hasArtist && artistVal) artist = artistVal
          const [hasAlbum, albumVal] = taglist.get_string("album")
          if (hasAlbum && albumVal) album = albumVal
          const [hasTagTitle, tagTitleVal] = taglist.get_string("title")
          if (hasTagTitle && tagTitleVal && tagTitleVal !== title) {
            title = tagTitleVal
            emit({ kind: "title", title })
          }
          // GJS wraps gst_tag_list_get_sample's out param as a [found, sample] tuple.
          const [hasImage, imageSample] = taglist.get_sample("image")
          if (hasImage && imageSample) {
            sample = imageSample
          } else {
            const [hasPreview, previewSample] = taglist.get_sample("preview-image")
            if (hasPreview && previewSample) sample = previewSample
          }
        }
        if (!sample) break
        try {
          const buffer = sample.get_buffer()
          if (!buffer) break
          const [ok, map] = buffer.map(Gst.MapFlags.READ)
          if (!ok) break
          const bytes = GLib.Bytes.new(map.data)
          buffer.unmap(map)
          const texture = Gdk.Texture.new_from_bytes(bytes)
          // TAG messages repeat (playbin3 re-posts tags), and each decode is a
          // fresh Gdk.Texture object — emit the FIRST art per media load only
          // (lastEmittedArt resets in teardownPipeline).
          if (texture && !lastEmittedArt) {
            lastEmittedArt = texture
            emit({ kind: "art", art: texture })
          }
        } catch (e) {
          log(`album art decode failed: ${(e as Error).message}`)
        }
        break
      }
      case Gst.MessageType.ERROR: {
        const [err, debug] = msg.parse_error()
        log(`gstreamer error: ${err?.message ?? "unknown"} (${debug})`)
        playing = false
        emit({ kind: "error", message: err?.message ?? "gstreamer error" })
        emit({ kind: "state", playing: false })
        break
      }
      case Gst.MessageType.STATE_CHANGED: {
        // Only the pipeline's own state matters (children churn a lot).
        if (msg.src !== pipe) break
        const [, newState] = msg.parse_state_changed()
        const isPlaying = newState === Gst.State.PLAYING
        if (isPlaying !== playing) {
          playing = isPlaying
          emit({ kind: "state", playing })
        }
        // Sink paintable may not be ready at ASYNC_DONE — re-read once playing.
        if (isPlaying) emitSinkPaintable()
        break
      }
      default:
        break
    }
  }

  function advanceOrStop(): void {
    if (playlistPos < playlist.length - 1) {
      instance.playIndex(playlistPos + 1)
    } else {
      // End of queue — park at 0:00 and stop. playbin3 stays in PLAYING at EOS,
      // so the explicit `ended` flag is set — the UI must read "paused" here,
      // and a live position query must read 0:00 (hence the seek-to-start
      // before pausing).
      if (pipeline) {
        pipeline.seek(
          1.0,
          Gst.Format.TIME,
          Gst.SeekFlags.FLUSH | Gst.SeekFlags.ACCURATE,
          Gst.SeekType.SET,
          0,
          Gst.SeekType.NONE,
          -1,
        )
        pipeline.set_state(Gst.State.PAUSED)
      }
      playing = false
      ended = true
      emit({ kind: "state", playing: false })
      emit({ kind: "position", timePos: 0, duration: durationSec() })
    }
  }

  // ── position polling (playbin3 has no position-updated signal) ──

  function startPolling(): void {
    if (pollTimer) return
    pollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, pollMs, () => {
      if (shuttingDown || !pipeline) return GLib.SOURCE_CONTINUE
      emit({
        kind: "position",
        timePos: ended ? 0 : currentPositionSec(),
        duration: durationSec(),
      })
      return GLib.SOURCE_CONTINUE
    })
  }

  // ── helpers ──

  function toUri(pathOrUrl: string): string {
    const p = pathOrUrl.replace(/^~(?=\/|$)/, GLib.get_home_dir())
    if (/^(https?|rtsp|rtmp|mms|srt|ftp|udp|tcp):\/\//i.test(p)) return p
    return GLib.filename_to_uri(p, null)
  }

  function titleFromPath(p: string): string {
    const base = GLib.path_get_basename(p)
    const dot = base.lastIndexOf(".")
    return dot > 0 ? base.slice(0, dot) : base
  }

  function currentPositionSec(): number | null {
    if (!pipeline) return null
    const [ok, pos] = pipeline.query_position(Gst.Format.TIME)
    if (!ok) return null
    const dur = durationSec()
    // Stale position can exceed a known duration right after a media change
    // (playbin3 keeps the old stream's position across a URI swap) — treat it
    // as unknown rather than surfacing a bogus value (e.g. 5.77s for a 0.7s file).
    if (dur !== null && pos / 1e9 > dur + 0.5) return null
    return pos / 1e9
  }

  function durationSec(): number | null {
    if (!pipeline) return null
    const [ok, d] = pipeline.query_duration(Gst.Format.TIME)
    // Live/unknown-length streams report GST_CLOCK_TIME_NONE (max uint64) —
    // treat as null so the UI shows a placeholder instead of ~1.8e10 seconds.
    return ok && d < Number(Gst.CLOCK_TIME_NONE) ? d / 1e9 : null
  }

  function loadUri(uri: string): void {
    // Fresh pipeline per load (see buildPipeline) — never reuse set_uri.
    buildPipeline(uri)
  }

  /** Playlist with the current entry stamped — reads playlistPos at query time. */
  function stampedPlaylist(): PlaylistEntry[] {
    return playlist.map((e, i) => ({ ...e, current: i === playlistPos }))
  }

  // ── public API (the consumer's window + command layer read this) ──

  const instance: MediaPipeline = {
    onEvent(cb: (ev: MediaEvent) => void): () => void {
      subs.push(cb)
      return () => {
        subs = subs.filter((s) => s !== cb)
      }
    },

    open(pathOrUrl: string): void {
      const entry: PlaylistEntry = {
        filename: pathOrUrl,
        title: titleFromPath(pathOrUrl),
      }
      playlist = [entry]
      playlistPos = 0
      emit({ kind: "playlist", playlist: stampedPlaylist(), pos: playlistPos })
      title = entry.title ?? ""
      emit({ kind: "title", title })
      loadUri(toUri(pathOrUrl))
    },

    append(pathOrUrl: string): void {
      const entry: PlaylistEntry = {
        filename: pathOrUrl,
        title: titleFromPath(pathOrUrl),
      }
      playlist = [...playlist, entry]
      playlistPos = playlist.length - 1
      emit({ kind: "playlist", playlist: stampedPlaylist(), pos: playlistPos })
      title = entry.title ?? ""
      emit({ kind: "title", title })
      loadUri(toUri(pathOrUrl))
    },

    toggle(): void {
      if (ended) instance.play()
      else if (playing) instance.pause()
      else instance.play()
    },

    play(): void {
      ensurePipeline()
      ended = false
      pipeline?.set_state(Gst.State.PLAYING)
    },

    pause(): void {
      pipeline?.set_state(Gst.State.PAUSED)
    },

    seekSeconds(sec: number): void {
      if (!pipeline || Number.isNaN(sec)) return
      ended = false // a seek is a deliberate resume from any ended state
      const target = Math.max(0, Math.round(sec * 1e9))
      pipeline.seek(
        rate,
        Gst.Format.TIME,
        Gst.SeekFlags.FLUSH | Gst.SeekFlags.ACCURATE,
        Gst.SeekType.SET,
        target,
        Gst.SeekType.NONE,
        -1,
      )
    },

    setVolume(v0to100: number): void {
      volume = Math.max(0, Math.min(100, v0to100))
      pipeline?.set_property("volume", volume / 100)
      emit({ kind: "volume", volume, muted })
    },

    getVolume(): number {
      return volume
    },

    toggleMute(): void {
      muted = !muted
      pipeline?.set_property("mute", muted)
      emit({ kind: "volume", volume, muted })
    },

    setSpeed(x: number): void {
      if (x <= 0) return
      rate = x
      if (!pipeline) return
      const [ok, pos] = pipeline.query_position(Gst.Format.TIME)
      const target = ok ? pos : 0
      pipeline.seek(
        rate,
        Gst.Format.TIME,
        Gst.SeekFlags.FLUSH | Gst.SeekFlags.ACCURATE,
        Gst.SeekType.SET,
        target,
        Gst.SeekType.NONE,
        -1,
      )
    },

    next(): void {
      if (playlistPos < playlist.length - 1) instance.playIndex(playlistPos + 1)
    },

    prev(): void {
      if (playlistPos > 0) instance.playIndex(playlistPos - 1)
    },

    playIndex(i: number): void {
      const entry = playlist[i]
      if (!entry) return
      playlistPos = i
      emit({ kind: "playlist", playlist: stampedPlaylist(), pos: playlistPos })
      title = entry.title ?? ""
      emit({ kind: "title", title })
      loadUri(toUri(entry.filename))
    },

    removeIndex(i: number): void {
      playlist = playlist.filter((_, idx) => idx !== i)
      if (playlistPos === i) playlistPos = -1
      else if (playlistPos > i) playlistPos -= 1
      emit({ kind: "playlist", playlist: stampedPlaylist(), pos: playlistPos })
    },

    clearPlaylist(): void {
      playlist = []
      playlistPos = -1
      ended = false
      pipeline?.set_state(Gst.State.NULL)
      title = ""
      emit({ kind: "playlist", playlist: [], pos: playlistPos })
      emit({ kind: "title", title: "" })
      emit({ kind: "position", timePos: 0, duration: null })
    },

    shufflePlaylist(): void {
      for (let i = playlist.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[playlist[i], playlist[j]] = [playlist[j], playlist[i]]
      }
      emit({ kind: "playlist", playlist: stampedPlaylist(), pos: playlistPos })
    },

    getPlaylist(): PlaylistEntry[] {
      return stampedPlaylist()
    },

    getStatus(): MediaStatus {
      return {
        timePos: ended ? 0 : currentPositionSec(),
        duration: durationSec(),
        title,
        artist,
        album,
        pause: ended || !playing,
        volume,
        mute: muted,
        speed: rate,
        playlist: stampedPlaylist(),
      }
    },

    getVideoPaintable(): Gdk.Paintable | null {
      ensurePipeline()
      if (!videoSink || !pipeline) return null
      if (!paintable) paintable = ((videoSink as any).paintable as Gdk.Paintable | null) ?? null
      return paintable
    },

    shutdown(): void {
      shuttingDown = true
      if (pollTimer) {
        GLib.source_remove(pollTimer)
        pollTimer = 0
      }
      if (pipeline) {
        const bus = pipeline.get_bus()
        if (bus) bus.remove_signal_watch()
        pipeline.set_state(Gst.State.NULL)
        pipeline = null
      }
      videoSink = null
      paintable = null
      playlist = []
      playlistPos = -1
      playing = false
      ended = false
      subs = []
    },
  }

  return instance
}
