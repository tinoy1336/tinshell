/**
 * media window — one Gtk.Window PER media surface (plain XDG toplevels, NOT
 * layer-shell, so Hyprland's `media-float` window rule floats + rounds them;
 * multi-instance, mirroring notes), built on the shared card frame
 * (common/card/frame).
 *
 * The file's KIND picks the mode (common/media/classify's isStillImage):
 *  - viewer — a still rendered inline: a decoded Gdk.Texture in a
 *    Gtk.ScrolledWindow (no pipeline, no MPRIS, no transport) with the
 *    filename control at the bottom left and the zoom readout at the bottom
 *    right, both over the still.
 *  - transport — audio/video played by this window's own playbin3 pipeline
 *    (common/media/pipeline): a picture + an auto-hiding seek scrubber
 *    overlay.
 * The same window can switch modes when a different file loads.
 *
 * NO HEADER: the window carries no titlebar row and no toolbar — the media
 * gets the whole card. The only chrome is the viewer's overlay footer (the
 * filename at the left, the zoom readout and the dimensions at the right) and
 * the transport's scrubber row, so nothing is spent on a permanent toolbar.
 *
 * ONE REQUESTED FILE = ONE FILE. `load()` shows the file it was given and
 * builds no sibling list behind it; the folder ring is an explicit action
 * (`ring()` — the `media ring` request). Opening a path into a viewer window
 * is therefore not a gallery.
 *
 * EMPTY STATE: a window created without a file paints no media at all — no
 * header, no toolbar, no placeholder, no scrubber — so it reads as empty and
 * see-through over the usual frosted card (see style.css for why the card's
 * own translucency and not zero alpha), and it immediately asks the PORTAL for
 * a file to open (./picker — the xdg-desktop-portal FileChooser, i.e. the
 * house chooser).
 *
 * Registry: `media open` = focus the most-recent surface else create;
 * `media new` = always create. MPRIS + the transport commands route through
 * the ACTIVE TRANSPORT surface (most-recently-playing else last-focused
 * transport window) via active.setActiveInstance; the viewer commands act on
 * the active surface while it is in viewer mode.
 *
 * The window NEVER STRETCHES MEDIA (no distorted aspect, ever):
 *  - the viewer's picture binds the still's own texture, whose intrinsic
 *    aspect ratio Gtk.ContentFit.CONTAIN honours;
 *  - the transport's picture binds a NullIntrinsicPaintable (no intrinsic
 *    size — the toplevel must not resize itself after map) and Gtk.Picture
 *    scales a RATIO-LESS paintable straight onto its allocation, so the
 *    allocation is what has to carry the ratio: a Gtk.AspectFrame takes it
 *    from the source paintable's real intrinsic size;
 *  - a numeric zoom pins the picture to (image px × zoom) ÷ the surface scale
 *    WITHOUT the expand flags, so the scrolled window allocates exactly that
 *    box (the image's own shape) instead of the viewport's. GTK lays out in
 *    LOGICAL px, so that division is what makes the readout's percentage
 *    true: `100%` is one image px per one SCREEN px, and screen px are the
 *    device px of a scaled output (2 on a 2880×1800@2 monitor).
 * Leftover space stays empty and shows the usual frosted card surface.
 *
 * The zoom arithmetic itself lives in ./zoom (pure, GTK-free, and driven
 * headlessly by ./zoom.probe).
 *
 * State comes from the pipeline's events (each playbin3 instance is the
 * single source of truth for its window) — NEVER set widget state from an
 * action you just sent; wait for the event round-trip.
 *
 * GJS/GTK notes:
 *  - Gtk.Scale.set_value() does not emit value-changed in GTK4 — value-
 *    changed fires only on user input, so a syncing flag around programmatic
 *    sets is enough to tell user seeks from event syncs.
 *  - Gtk.Picture with a null paintable renders nothing — a placeholder label
 *    covers the no-video case of a LOADED media (never the empty window).
 *  - A CAPTURE-phase gesture on the Gtk.Scale owns the scrub sequence, so the
 *    scale's own drag never sees it and the vertical scrub ramp stays under
 *    this window's control.
 *  - `scrubbing` is declared before refreshSeek's definition but assigned only
 *    by the scrub handlers: the poll must not fight the drag for the slider.
 */

import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import { easeCubicInOut } from "@common/anim/easings"
import { runFrames } from "@common/anim/run-frames"
import { scheduleUnload } from "@common/app/lazy"
import { createCardFrame } from "@common/card/frame"
import { ignore, log } from "@common/log/logger"
import { isStillImage } from "@common/media/classify"
import { loadStill } from "@common/media/decode"
import { NullIntrinsicPaintable } from "@common/media/paintable"
import { createMediaPipeline } from "@common/media/pipeline"
import type { MediaPipeline, StillImage } from "@common/media/types"
import { createPathAutofill } from "@common/path/autofill"
import { expandPath, isPathShaped } from "@common/path/complete"
import { setActiveInstance } from "./active"
import { get as getConfig } from "./config"
import { pickMediaFile } from "./picker"
import { applyFrameZoom, applyPictureZoom, boxedZoom, deviceScale } from "./picture-zoom"
import { fitScale, steppedZoom, type Zoom, zoomLabel } from "./zoom"

/** Accumulated scroll delta that advances one zoom step: a wheel notch
 *  arrives as 1 (Gdk.ScrollUnit.WHEEL), a touchpad's smooth scrolling as
 *  small fractions (Gdk.ScrollUnit.SURFACE). */
const SCROLL_WHEEL_STEP = 1
const SCROLL_SURFACE_STEP = 0.15
/** Slowest scrub rate — the hard floor of the vertical scrub ramp. */
const SCRUB_MIN_RATE = 0.25
/** Smallest rate change worth a rate-seek while scrubbing. */
const SCRUB_RATE_EPSILON = 0.05
/** Decoded-still cache caps: cached pixels and entry count. */
const STILL_CACHE_PX = 12_000_000
const STILL_CACHE_MAX = 4
/** Delay before the neighbour preload decode, so it never competes with the
 *  still that was just handed to the compositor — and lands well inside the
 *  pause a person takes before the next flip. */
const PRELOAD_DELAY_MS = 150

/** Which UI a surface shows: the viewer for stills, the transport otherwise. */
type SurfaceMode = "transport" | "viewer"
/** A zoom REQUEST (`media zoom …`, the readout button, the keys): the fit
 *  state, the 1:1 state, or a step from wherever the surface is now. */
type ZoomMode = "fit" | "100" | "in" | "out"
/** An explicit multi-file load: the folder ring plus the entry to show. */
interface RingLoad {
  ring: string[]
  index: number
}

/** One media window + the state it owns. */
export interface Surface {
  win: Gtk.Window
  media: MediaPipeline
  readonly mode: SurfaceMode
  /** Load `path` (focus path for `open`), switching mode by its kind. */
  load(path: string): void
  /** Load `path` WITH its folder ring — the explicit multi-file action. */
  ring(target: string): boolean
  /** Viewer step-through; no-op without a ring. */
  step(delta: number): void
  /** Does this viewer hold an explicit folder ring? */
  hasRing(): boolean
  setZoom(mode: ZoomMode): void
  /** Live-config refresh (view.* toggles from `config set`). */
  refreshView(): void
}

// ── decoded-still cache ──

interface CachedStill {
  image: StillImage
  px: number
}

/** Decoded stills by path, in least-recently-used order. Decoding is the
 *  entire cost of a flip — a 2880×1800 screen capture measures 55-160 ms
 *  through Gdk.Texture.new_from_filename — so a still the viewer has already
 *  shown, or the one the idle preload decoded ahead of the next step, must
 *  never be decoded twice. */
const stillCache = new Map<string, CachedStill>()
let stillCachePx = 0

function cachedStill(path: string): StillImage | null {
  const hit = stillCache.get(path)
  if (!hit) return null
  // Re-insert: the Map's iteration order is the LRU order eviction walks.
  stillCache.delete(path)
  stillCache.set(path, hit)
  return hit.image
}

/** Decode `path` through the shared still decoder, keeping the result while
 *  the pixel budget allows. */
function decodeStill(path: string): StillImage {
  const hit = cachedStill(path)
  if (hit) return hit
  const image = loadStill(path)
  const px = image.width * image.height
  if (px > 0 && px <= STILL_CACHE_PX) {
    stillCache.set(path, { image, px })
    stillCachePx += px
    while (stillCachePx > STILL_CACHE_PX || stillCache.size > STILL_CACHE_MAX) {
      const oldest = stillCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      const evicted = stillCache.get(oldest)
      stillCache.delete(oldest)
      stillCachePx -= evicted?.px ?? 0
    }
  }
  return image
}

/** Drop every cached still — the app's largest heap objects, released with
 *  the lazy-unload / instance-quit teardown. */
export function clearStillCache(): void {
  stillCache.clear()
  stillCachePx = 0
}

/** The stills a ring holds: every sibling `isStillImage` accepts in the
 *  path's folder, name-sorted — or, for a DIRECTORY, that directory's own
 *  stills. Null when it holds none. */
function ringFor(target: string): RingLoad | null {
  const file = Gio.File.new_for_path(target)
  let isDir = false
  try {
    isDir = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY
  } catch (e) {
    ignore("media ring stat", e)
    return null
  }
  const dirPath = isDir ? target : GLib.path_get_dirname(target)
  const dir = Gio.File.new_for_path(dirPath)
  const names: string[] = []
  try {
    const it = dir.enumerate_children(
      "standard::name,standard::type",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    let info: Gio.FileInfo | null
    while ((info = it.next_file(null)) !== null) {
      const name = info.get_name()
      if (info.get_file_type() === Gio.FileType.REGULAR && isStillImage(name)) names.push(name)
    }
    it.close(null)
  } catch (e) {
    ignore("media folder listing", e)
    return null
  }
  names.sort()
  if (names.length === 0) return null
  const ring = names.map((n) => GLib.build_filenamev([dirPath, n]))
  if (isDir) return { ring, index: 0 }
  const index = ring.indexOf(GLib.build_filenamev([dirPath, GLib.path_get_basename(target)]))
  return index >= 0 ? { ring, index } : null
}

// ── surface registry + active selection ──

const surfaces: Surface[] = []
let lastFocused: Surface | null = null
let lastTransport: Surface | null = null

/** Lifecycle hooks wired by mount.ts (MPRIS start/stop on 0↔1 PLAYABLE
 *  surfaces — a still-only window must not claim MPRIS, or the dock's media
 *  applet appears because a jpeg was selected). */
let onFirstSurface: (() => void) | null = null
let onLastClosed: (() => void) | null = null
let mprisGate = false
export function setSurfaceHooks(hooks: {
  onFirstSurface: () => void
  onLastClosed: () => void
}): void {
  onFirstSurface = hooks.onFirstSurface
  onLastClosed = hooks.onLastClosed
}

/** The window a request acts on: the focused one, else the newest. */
function activeSurface(): Surface | null {
  return lastFocused ?? surfaces[surfaces.length - 1] ?? null
}

function transportFallback(): Surface | null {
  const playable = surfaces.filter((s) => s.mode === "transport")
  return playable[playable.length - 1] ?? null
}

/** Re-derive the active transport surface + the MPRIS gate after a focus,
 *  mode or surface-set change. */
function refreshActive(): void {
  const s = activeSurface()
  // A surface that switched to the viewer (or closed) is no longer a
  // transport target.
  if (lastTransport?.mode !== "transport" || !surfaces.includes(lastTransport)) {
    lastTransport = transportFallback()
  }
  if (s?.mode === "transport") lastTransport = s
  setActiveInstance(lastTransport?.media ?? null)
  const playable = lastTransport !== null
  if (playable && !mprisGate) {
    mprisGate = true
    onFirstSurface?.()
  } else if (!playable && mprisGate) {
    mprisGate = false
    onLastClosed?.()
  }
}

/** The pipeline the transport commands + MPRIS act on (null when no transport
 *  surface exists — a viewer-only session has no transport target). */
export function activePipeline(): MediaPipeline | null {
  const s = activeSurface()
  if (s?.mode === "transport") return s.media
  return lastTransport?.mode === "transport" ? lastTransport.media : null
}

/** The active surface when it shows a still (the ring/step target). */
export function activeViewer(): Surface | null {
  const s = activeSurface()
  return s && s.mode === "viewer" ? s : null
}

/** `media zoom …` — the active surface whatever its mode: stills and video
 *  both zoom. False when no window is open. */
export function setActiveZoom(mode: ZoomMode): boolean {
  const s = activeSurface()
  if (!s) return false
  s.setZoom(mode)
  return true
}

function focus(s: Surface): void {
  lastFocused = s
  refreshActive()
}

function removeSurface(s: Surface): void {
  const i = surfaces.indexOf(s)
  if (i >= 0) surfaces.splice(i, 1)
  if (lastFocused === s) lastFocused = surfaces[surfaces.length - 1] ?? null
  refreshActive()
  if (surfaces.length === 0) scheduleUnload("media") // shell unload grace (no-op in islands)
}

/** The schemes `common/media/pipeline` plays as URLs (its `toUri` passes them
 *  through; every other token becomes a local file URI). */
const URL_SCHEME = /^(https?|rtsp|rtmp|mms|srt|ftp|udp|tcp):\/\//i

/** What a request's path-or-URL argument names, as the window should load it,
 *  or the reason it cannot be played.
 *
 *  A request that NAMES a file gets that file: a local path with nothing at it
 *  would leave a transport showing nothing, and the empty state belongs to a
 *  request that named no file at all (that one asks the portal, ./picker). The
 *  path is resolved through the shared `expandPath` first, so `~` and a
 *  relative path reach the window as an absolute path instead of as literal
 *  text; a URL the pipeline plays directly passes through unchanged. */
export function resolveTarget(target: string): { path: string } | { reason: string } {
  const raw = target.trim()
  if (URL_SCHEME.test(raw)) return { path: raw }
  const path = expandPath(raw)
  let type: Gio.FileType
  try {
    type = Gio.File.new_for_path(path).query_file_type(Gio.FileQueryInfoFlags.NONE, null)
  } catch (e) {
    return { reason: `cannot read ${path}: ${(e as Error).message}` }
  }
  if (type === Gio.FileType.UNKNOWN) return { reason: `no such file or directory: ${path}` }
  if (type === Gio.FileType.DIRECTORY) {
    return {
      reason: `is a directory: ${path} (media plays one file; \`media ring <dir>\` loads its stills)`,
    }
  }
  if (type !== Gio.FileType.REGULAR) return { reason: `not a regular file: ${path}` }
  return { path }
}

/** Open (warm: focus the most-recent surface) or create; an optional path
 *  cold-loads. `media open` semantics (ensure-open.sh warm path relies on
 *  the no-arg focus). Returns null, or the reason a named path was REFUSED —
 *  the caller answers with it instead of a window being built for a file the
 *  pipeline cannot play. */
export function openPath(path?: string): string | null {
  const resolved = path === undefined ? undefined : resolveTarget(path)
  if (resolved && "reason" in resolved) {
    log(`media: open refused — ${resolved.reason}`)
    return resolved.reason
  }
  const target = activeSurface()
  if (target) {
    target.win.present()
    focus(target)
    if (resolved) target.load(resolved.path)
    return null
  }
  createSurface(resolved ? { path: resolved.path } : {})
  return null
}

/** Always create another media window (`media new`) — the xdg-open shape:
 *  every request that lands there gets its own window. A named path is
 *  resolved and refused exactly like `openPath`. */
export function newSurface(path?: string): string | null {
  const resolved = path === undefined ? undefined : resolveTarget(path)
  if (resolved && "reason" in resolved) {
    log(`media: new refused — ${resolved.reason}`)
    return resolved.reason
  }
  createSurface(resolved ? { path: resolved.path } : {})
  return null
}

/** `media append <path|url>` — queue onto the ACTIVE transport window's
 *  playlist, or open the first window when none is up. The target goes through
 *  the SAME `resolveTarget` the open path uses: `~` is expanded, a URL the
 *  pipeline plays passes through, and a local path with no regular file at it
 *  is REFUSED with the reason instead of being queued as a playlist entry the
 *  pipeline can never load. Returns null, or the rejection reason. */
export function appendToActive(target: string): string | null {
  const resolved = resolveTarget(target)
  if ("reason" in resolved) {
    log(`media: append refused — ${resolved.reason}`)
    return resolved.reason
  }
  const m = activePipeline()
  if (m) {
    m.append(resolved.path)
    return null
  }
  createSurface({ path: resolved.path }) // no window yet → open it
  return null
}

/** `media ring <path|dir>` — load the still WITH its folder ring (the
 *  explicit multi-file load) in the active window, creating one when none is
 *  open. False when the path names no still at all. */
export function ringPath(target: string): boolean {
  const load = ringFor(target)
  if (!load) return false
  const existing = activeSurface()
  if (existing) {
    existing.win.present()
    focus(existing)
    return existing.ring(target)
  }
  createSurface({ ring: load })
  return true
}

/** Close the active window (`media close`). False when none is open. */
export function closeActive(): boolean {
  const s = activeSurface()
  if (!s) return false
  s.win.close()
  return true
}

/** Tear down on app shutdown (closes every surface; each close handler
 *  shuts its own media instance down). */
export function destroyWindow(): void {
  for (const s of [...surfaces]) {
    try {
      s.win.close()
    } catch (e) {
      // GTK4 has no is_destroyed(): the surface may already be torn down.
      ignore("media surface close", e)
    }
  }
}

/** Live-config refresh (view.* toggles) — every open surface. */
export function refreshView(): void {
  for (const s of surfaces) s.refreshView()
}

interface CreateSurfaceOptions {
  path?: string
  ring?: RingLoad
}

function createSurface(initial: CreateSurfaceOptions = {}): Surface {
  const firstWindow = surfaces.length === 0
  const pipeline = createMediaPipeline({
    pollIntervalMs: getConfig<number>("timing.pollIntervalMs"),
  })

  // Title cascade: Hyprland centres every float at the same spot and overrides
  // app sizes (GTK floats map ~720x900 regardless of config), so consecutive
  // media windows stack invisibly. GTK4 has no position API — hyprland.lua
  // offsets instances 2+ via title-matched `move` rules (media-2/media-3/...).
  // The title is invisible (no titlebar) and NEVER carries the filename, or a
  // viewer window would stop matching its cascade rule.
  const title = firstWindow ? "media" : `media-${surfaces.length + 1}`

  // ── per-window live state ──
  let mode: SurfaceMode = "transport"
  let empty = true
  let torn = false
  // transport
  const playback = { timePos: null as number | null, duration: null as number | null }
  let syncingSeek = false
  let vidW = 0
  let vidH = 0
  // viewer
  let path = ""
  let ring: string[] = []
  let index = -1
  let zoom: Zoom = "fit"
  let stillSrc: Gdk.Paintable | null = null
  let imgW = 0
  let imgH = 0
  let preloadTimer = 0
  let prompted = false
  let editing = false

  // ── helpers (function declarations: the widget block below wires them) ──

  function fmt(sec: number | null): string {
    if (sec === null || Number.isNaN(sec)) return "0:00"
    const s = Math.max(0, Math.floor(sec))
    const m = Math.floor(s / 60)
    return `${m}:${String(s % 60).padStart(2, "0")}`
  }

  function refreshSeek(): void {
    const t = playback.timePos
    const d = playback.duration
    const pct = d && d > 0 && t !== null ? Math.min(100, (t / d) * 100) : 0
    // A scrub drag owns the slider while it is down (the user's position, not
    // the poll's) — only the time readout follows the pipeline.
    if (!syncingSeek && !scrubbing) {
      syncingSeek = true
      seek.set_value(pct)
      syncingSeek = false
    }
    timeLabel.label = `${fmt(t)} / ${fmt(d)}`
  }

  function updateFooter(): void {
    nameLabel.label = path ? GLib.path_get_basename(path) : ""
    if (path) nameBtn.set_tooltip_text(path)
    const z = zoomLabel(zoom, zoom === "fit" ? currentFitScale() : null)
    zoomBtn.label = z
    transportZoom.label = z
    // The window's own media size follows the page that is showing.
    let dims = ""
    if (mode === "viewer") {
      if (imgW > 0) dims = `${imgW}×${imgH}`
    } else if (vidW > 0) {
      dims = `${vidW}×${vidH}`
    }
    const pos = ring.length > 1 ? `${index + 1}/${ring.length}` : ""
    dimsLabel.label = [dims, pos].filter(Boolean).join(" · ")
  }

  /** Screen px per widget px on this window's surface: a size request is in
   *  LOGICAL px and is DRAWN at ×scale screen px, so every pixel-true size has
   *  to come back through here. The surface's scale is the fractional one
   *  (1.5 on a fractional-scaled output); the widget's own factor is the next
   *  integer above it, hence the surface first. 1 until the window has one. */
  function currentFitScale(): number | null {
    const viewer = mode === "viewer"
    const box = viewer ? still : aspect
    const scale = deviceScale(box)
    return fitScale(
      viewer ? imgW : vidW,
      viewer ? imgH : vidH,
      box.get_width() * scale,
      box.get_height() * scale,
    )
  }

  function applyZoom(): void {
    // The viewer's picture and the transport's ratio frame are pinned by the
    // same model (./picture-zoom): CONTAIN on the texture for fit, an exactly
    // sized and centred SCREEN-px box for a numeric zoom. A fit state with no
    // measured media is the same shape as fit.
    if (mode === "viewer") {
      const pin =
        zoom === "fit" || imgW === 0
          ? ({ kind: "fit" } as const)
          : boxedZoom(imgW, imgH, zoom, deviceScale(still))
      applyPictureZoom(still, stillSrc, pin)
    } else {
      const pin =
        zoom === "fit" || vidW === 0
          ? ({ kind: "fit" } as const)
          : boxedZoom(vidW, vidH, zoom, deviceScale(aspect))
      applyFrameZoom(aspect, pin)
    }
    updateFooter()
  }

  /** Point the aspect frame at the source paintable's REAL size, and report
   *  whether that paintable carries a picture at all. The wrapper reports no
   *  intrinsic size (that is what keeps the toplevel at its config size) and
   *  Gtk.Picture stretches a RATIO-LESS paintable onto its allocation — so the
   *  frame's ratio is what keeps video and album art proportional. A sink
   *  paintable EXISTS before it carries a frame (0x0): binding one paints the
   *  whole picture black, so it is not bound at all until it has a size. */
  function trackSource(pt: Gdk.Paintable | null | undefined): boolean {
    if (!pt) return false
    const src = ((pt as any).source as Gdk.Paintable | undefined) ?? pt
    const w = src.get_intrinsic_width()
    const h = src.get_intrinsic_height()
    if (w <= 0 || h <= 0) return false
    vidW = w
    vidH = h
    aspect.ratio = w / h
    return true
  }

  function applyPicture(): void {
    if (videoPt) {
      picture.paintable = noIntrinsic(videoPt)
      placeholder.visible = false
    } else if (artPt) {
      picture.paintable = noIntrinsic(artPt)
      placeholder.visible = false
    } else {
      picture.paintable = null
      // The placeholder covers the "audio, or no video sink" case of a LOADED
      // media — never the empty window, which paints nothing at all.
      placeholder.visible = !empty && mode === "transport"
    }
  }

  function setZoom(next: ZoomMode): void {
    if (empty) return
    if (next === "fit") zoom = "fit"
    // 100% is 1:1 and nothing else: one image pixel per one screen pixel.
    else if (next === "100") zoom = 1
    // A step is relative to what is on screen NOW, so stepping out of fit
    // starts from the scale fit computed rather than from 100%.
    else zoom = steppedZoom(zoom, zoom === "fit" ? currentFitScale() : null, next)
    applyZoom()
  }

  function cancelPreload(): void {
    if (preloadTimer) {
      GLib.source_remove(preloadTimer)
      preloadTimer = 0
    }
  }

  /** Decode the NEXT ring entry while the window sits idle: the step that
   *  follows then finds its still already decoded, which is the whole cost of
   *  a flip. */
  function schedulePreload(): void {
    cancelPreload()
    if (ring.length === 0) return
    const next = ring[(index + 1) % ring.length]
    if (!next || next === path) return
    preloadTimer = GLib.timeout_add(GLib.PRIORITY_LOW, PRELOAD_DELAY_MS, () => {
      preloadTimer = 0
      try {
        decodeStill(next)
      } catch (e) {
        ignore("media still preload", e)
      }
      return GLib.SOURCE_REMOVE
    })
  }

  /** Show `target` as this window's still (the ONE display path). */
  function showStill(target: string): void {
    path = target
    try {
      const image = decodeStill(target)
      imgW = image.width
      imgH = image.height
      stillSrc = image.texture
    } catch (e) {
      imgW = 0
      imgH = 0
      stillSrc = null
      log(`media: cannot display ${target}: ${String(e)}`)
    }
    zoom = "fit"
    applyZoom()
    schedulePreload()
  }

  function step(delta: number): void {
    if (mode !== "viewer" || ring.length === 0) return
    index = (index + delta + ring.length) % ring.length
    showStill(ring[index])
  }

  function enterMode(kind: SurfaceMode): void {
    const switched = kind !== mode
    mode = kind
    stack.set_visible_child_name(mode)
    footer.visible = mode === "viewer" && !empty
    if (switched) refreshActive()
  }

  /** The empty window (no file): no chrome, no placeholder, and no zero-alpha
   *  background — the card's own translucency is the see-through look (style.css
   *  explains why zero alpha cannot be used). */
  function setEmpty(next: boolean): void {
    empty = next
    if (empty) {
      hideControls()
      placeholder.visible = false
      footer.visible = false
    }
  }

  /** The one requested file and nothing else: no sibling ring is built behind
   *  it (a gallery is the explicit `media ring` action). */
  function load(target: string): void {
    const kind: SurfaceMode = isStillImage(target) ? "viewer" : "transport"
    ring = []
    index = -1
    setEmpty(false)
    enterMode(kind)
    if (kind === "viewer") {
      cancelPreload()
      showStill(target)
    } else {
      cancelPreload()
      path = target
      pipeline.open(target)
      showControls()
      updateFooter()
    }
  }

  /** The explicit multi-file load: `target`'s folder ring, starting at the
   *  entry `target` names (a directory starts at its first still). */
  function loadRing(target: string, precomputed?: RingLoad): boolean {
    const r = precomputed ?? ringFor(target)
    if (!r) return false
    ring = r.ring
    index = r.index
    setEmpty(false)
    enterMode("viewer")
    showStill(ring[index])
    return true
  }

  /** Ask the portal for a file — the empty window's prompt. */
  function promptForFile(): void {
    if (prompted || !empty) return
    prompted = true
    pickMediaFile((picked) => {
      if (torn) return
      thisSurface.load(picked)
    })
  }

  // ── fading transport controls ──

  const FADE_IN_MS = 150
  const FADE_OUT_MS = 250
  let hideTimer = 0
  let fadeRunner: { cancel: () => void } | null = null
  const autoHideMs = getConfig<number>("timing.autoHideMs")

  function fadeTo(target: number, durMs: number): void {
    if (fadeRunner) {
      fadeRunner.cancel()
      fadeRunner = null
    }
    const from = controls.opacity
    if (from === target) return
    const start = GLib.get_monotonic_time()
    fadeRunner = runFrames(controls, (nowUs) => {
      const t = Math.min(1, (nowUs - start) / (durMs * 1000))
      controls.opacity = from + (target - from) * easeCubicInOut(t)
      if (t >= 1) {
        controls.opacity = target
        if (target === 0) controls.visible = false
        fadeRunner = null
        return false
      }
      return true
    })
  }

  function showControls(): void {
    if (empty) return
    if (hideTimer) {
      GLib.source_remove(hideTimer)
      hideTimer = 0
    }
    if (!controls.visible) {
      controls.visible = true
      controls.opacity = 0
    }
    fadeTo(1, FADE_IN_MS)
    if (autoHideMs > 0) {
      hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, autoHideMs, () => {
        fadeTo(0, FADE_OUT_MS)
        hideTimer = 0
        return GLib.SOURCE_REMOVE
      })
    }
  }

  function hideControls(): void {
    if (hideTimer) {
      GLib.source_remove(hideTimer)
      hideTimer = 0
    }
    if (fadeRunner) {
      fadeRunner.cancel()
      fadeRunner = null
    }
    controls.visible = false
    controls.opacity = 0
  }

  // ── key-binding adapters ──

  /** Viewer-only key: consume the press only while the viewer is showing. */
  function viewerKey(action: () => void): () => boolean {
    return () => {
      if (mode !== "viewer") return false
      action()
      return true
    }
  }

  /** Zoom key: consumed in either mode, and only while a media is loaded
   *  (there is nothing to scale in the empty window). */
  function zoomKey(action: () => void): () => boolean {
    return () => {
      if (empty) return false
      action()
      return true
    }
  }

  /** Space: play/pause of THIS window's transport, consumed only in transport
   *  mode (a still has nothing to play). */
  function transportKey(action: () => void): () => boolean {
    return () => {
      if (mode !== "transport" || empty) return false
      action()
      return true
    }
  }

  // ── filename editor (click the footer's name, edit the path) ──

  function beginEdit(): void {
    if (torn || !path) return
    editing = true
    nameEntry.set_text(path)
    nameEntry.set_position(-1)
    nameBtn.visible = false
    nameEntry.visible = true
    dimsLabel.visible = false
    nameEntry.grab_focus()
    nameEntry.select_region(0, -1)
  }

  function endEdit(commit: boolean): void {
    if (!editing) return
    editing = false
    const text = nameEntry.get_text().trim()
    nameEntry.visible = false
    nameBtn.visible = true
    dimsLabel.visible = true
    autofill.reset()
    if (commit && text && text !== path) {
      if (!Gio.File.new_for_path(text).query_exists(null)) {
        log(`media: no such file or directory: ${text}`)
        return
      }
      load(text)
    }
  }

  function applyAutofill(result: { text: string; committedLen: number }): void {
    nameEntry.set_text(result.text)
    nameEntry.set_position(result.text.length)
    // The ghost half shows as a selection (the shared autofill's committed +
    // ghost model — same rendering every path entry in the home uses).
    nameEntry.select_region(result.committedLen, result.text.length)
  }

  // ── widgets: the transport page ──

  const frame = createCardFrame({
    app: "media",
    appId: "io.Astal.media", // app id matched by the media-float Hyprland windowrule
    title,
    defaultWidth: getConfig("window.width"),
    defaultHeight: getConfig("window.height"),
    // NO header slot: the window has no toolbar at all.
    keys: {
      bindings: [
        { key: Gdk.KEY_Left, run: viewerKey(() => step(-1)) },
        { key: Gdk.KEY_Right, run: viewerKey(() => step(1)) },
        { key: Gdk.KEY_plus, run: zoomKey(() => setZoom("in")) },
        { key: Gdk.KEY_equal, run: zoomKey(() => setZoom("in")) },
        { key: Gdk.KEY_minus, run: zoomKey(() => setZoom("out")) },
        { key: Gdk.KEY_0, run: zoomKey(() => setZoom("fit")) },
        { key: Gdk.KEY_1, run: zoomKey(() => setZoom("100")) },
        { key: Gdk.KEY_space, run: transportKey(() => pipeline.toggle()) },
      ],
    },
  })
  const { win, root } = frame

  const stack = new Gtk.Stack({ hexpand: true, vexpand: true })
  root.append(stack)

  const transportOverlay = new Gtk.Overlay({ hexpand: true, vexpand: true })
  const videoScroll = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true })
  videoScroll.add_css_class("media-scroll")
  videoScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
  // The ratio carrier (see the file header): the media's own ratio, from the
  // source paintable's intrinsic size.
  const aspect = new Gtk.AspectFrame({
    xalign: 0.5,
    yalign: 0.5,
    ratio: 16 / 9,
    obeyChild: false,
  })
  aspect.set_hexpand(true)
  aspect.set_vexpand(true)
  const picture = new Gtk.Picture({
    hexpand: true,
    vexpand: true,
    contentFit: Gtk.ContentFit.FILL,
  })
  picture.add_css_class("media-picture")
  aspect.set_child(picture)
  videoScroll.set_child(aspect)
  transportOverlay.set_child(videoScroll)

  // The output area shows VIDEO paintable (highest priority) > album art >
  // placeholder. videoPt/artPt track the current sources; applyPicture()
  // resolves them. The picture is the overlay's always-present main child —
  // only its bound paintable and `placeholder.visible` change — and a sink
  // paintable reaches this window through the pipeline's `emitSinkPaintable`,
  // which drops one whose intrinsic size is 0 (`w <= 0 || h <= 0`) instead of
  // binding it.
  let videoPt: any = null
  let artPt: any = null
  // One wrapper per source paintable (re-wrapping would re-connect signals).
  // NullIntrinsicPaintable (common/media/paintable) reports no intrinsic size,
  // so the bound paintable never drives the toplevel's natural size.
  let shownSrc: Gdk.Paintable | null = null
  let shownWrapped: InstanceType<typeof NullIntrinsicPaintable> | null = null
  function noIntrinsic(pt: Gdk.Paintable): Gdk.Paintable {
    if (shownSrc !== pt || !shownWrapped) {
      shownSrc = pt
      shownWrapped = new NullIntrinsicPaintable(pt)
    }
    return shownWrapped
  }

  const placeholder = new Gtk.Label({ label: "▶" })
  placeholder.add_css_class("media-placeholder")
  placeholder.halign = Gtk.Align.CENTER
  placeholder.valign = Gtk.Align.CENTER
  transportOverlay.add_overlay(placeholder)

  const initialPaintable = pipeline.getVideoPaintable()
  if (initialPaintable && trackSource(initialPaintable)) videoPt = initialPaintable
  applyPicture()

  const controls = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    hexpand: true,
  })
  controls.add_css_class("media-controls")
  controls.halign = Gtk.Align.FILL
  controls.valign = Gtk.Align.END
  transportOverlay.add_overlay(controls)

  const seek = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    adjustment: Gtk.Adjustment.new(0, 0, 100, 1, 10, 0), // GTK4: no `range` prop
    hexpand: true,
  })
  seek.draw_value = false
  seek.add_css_class("media-seek")
  seek.set_value(0)

  const timeLabel = new Gtk.Label({ label: "0:00 / 0:00" })
  timeLabel.add_css_class("media-time")

  const transportZoom = new Gtk.Button({ label: "fit" })
  transportZoom.add_css_class("media-zoom")
  transportZoom.set_tooltip_text("fit / 100% — click to toggle")

  const seekRow = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 2,
    hexpand: true,
  })
  // The scale is a READ-OUT only: GtkRange installs its own CAPTURE-phase drag
  // gesture, so a gesture added to the scale wins the press and is then
  // cancelled by the range's (verified — drag-begin followed by an immediate
  // drag-end, and no drag-update ever arrived). `can-target = false` takes the
  // range out of pointer picking, and a transparent catcher over it owns the
  // sequence instead (labelled in the scrub block below).
  const seekOverlay = new Gtk.Overlay({ hexpand: true })
  const seekCatcher = new Gtk.Box({ hexpand: true, vexpand: true })
  seek.set_can_target(false)
  seekOverlay.set_child(seek)
  seekOverlay.add_overlay(seekCatcher)
  seekRow.append(seekOverlay)
  seekRow.append(timeLabel)
  seekRow.append(transportZoom)
  controls.append(seekRow)
  stack.add_named(transportOverlay, "transport")

  // ── widgets: the viewer page (still + the overlay footer) ──

  const still = new Gtk.Picture({ hexpand: true, vexpand: true })
  still.add_css_class("media-picture")
  still.set_content_fit(Gtk.ContentFit.CONTAIN)
  const scroll = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true })
  scroll.add_css_class("media-scroll")
  scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
  scroll.child = still

  const nameLabel = new Gtk.Label({ label: "", xalign: 0 })
  nameLabel.set_ellipsize(Pango.EllipsizeMode.END)
  nameLabel.set_max_width_chars(48)
  const nameBtn = new Gtk.Button()
  nameBtn.add_css_class("media-name")
  nameBtn.set_child(nameLabel)
  nameBtn.set_hexpand(true)
  nameBtn.set_tooltip_text("click to edit the path")

  const nameEntry = new Gtk.Entry({ hexpand: true })
  nameEntry.add_css_class("media-name-entry")
  nameEntry.visible = false

  const dimsLabel = new Gtk.Label({ label: "", xalign: 1 })
  dimsLabel.add_css_class("media-dims")

  const zoomBtn = new Gtk.Button({ label: "fit" })
  zoomBtn.add_css_class("media-zoom")
  zoomBtn.set_tooltip_text("fit / 100% — click to toggle")

  const footer = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 6,
    hexpand: true,
  })
  footer.add_css_class("media-footer")
  footer.halign = Gtk.Align.FILL
  footer.valign = Gtk.Align.END
  footer.append(nameBtn)
  footer.append(nameEntry)
  footer.append(dimsLabel)
  footer.append(zoomBtn)

  const viewerOverlay = new Gtk.Overlay({ hexpand: true, vexpand: true })
  viewerOverlay.set_child(scroll)
  viewerOverlay.add_overlay(footer)
  stack.add_named(viewerOverlay, "viewer")

  // ── viewer wiring: the name control, its type-ahead, the zoom toggle ──

  // The SAME inline Tab cycle every path entry in the home uses
  // (common/path/autofill over common/path/complete), gated on the shared
  // path-shape rule: an ordinary word leaves Tab as GTK's focus move.
  const autofill = createPathAutofill({
    extract: (t) => (isPathShaped(t) ? t.trim() : null),
  })
  nameEntry.connect("changed", () => autofill.onInput(nameEntry.get_text()))
  nameEntry.connect("activate", () => endEdit(true))
  const entryKeys = new Gtk.EventControllerKey()
  entryKeys.connect("key-pressed", (_c: any, keyval: number) => {
    if (keyval === Gdk.KEY_Escape) {
      endEdit(false)
      return true
    }
    if (keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab) {
      const r = autofill.onTab(nameEntry.get_text(), keyval === Gdk.KEY_ISO_Left_Tab)
      if (r === null) return false // no candidate: Tab keeps moving focus
      applyAutofill(r)
      return true
    }
    if (keyval === Gdk.KEY_Right) {
      const r = autofill.onAccept(nameEntry.get_text())
      if (r === null) return false
      applyAutofill(r)
      return true
    }
    return false
  })
  nameEntry.add_controller(entryKeys)
  nameBtn.connect("clicked", () => beginEdit())
  zoomBtn.connect("clicked", () => setZoom(zoom === "fit" ? "100" : "fit"))
  transportZoom.connect("clicked", () => setZoom(zoom === "fit" ? "100" : "fit"))

  // The readout follows the viewport. A numeric zoom is a fixed screen-px
  // scale, so only the FIT state can go stale: its percentage is a function of
  // the viewport, and the containing picture's allocation IS that viewport
  // (the transport's ratio frame likewise), so its own resize is where the
  // recomputation belongs. A scale change (a move to another output, or a
  // fractional-scale update) re-pins the numeric box in the new scale too.
  const syncZoomReadout = (): void => {
    if (zoom === "fit") updateFooter()
  }
  still.connect("notify::width", syncZoomReadout)
  still.connect("notify::height", syncZoomReadout)
  aspect.connect("notify::width", syncZoomReadout)
  aspect.connect("notify::height", syncZoomReadout)
  win.connect("notify::scale-factor", () => applyZoom())

  // ── scrubbing ──
  // The scrub gesture OWNS the drag (capture phase, so the scale's own
  // gesture never sees the sequence): the horizontal position seeks the
  // stream, and the VERTICAL position sets the playback rate — at the
  // scrubber the rate the window is playing at, rising towards the top of the
  // window steadily slower down to SCRUB_MIN_RATE, and a cursor that stays at
  // or below the scrubber changes the rate NOT AT ALL. The play state is
  // never touched: a paused scrub positions the playhead, and the rate ramp
  // applies to whatever play state follows.
  let scrubbing = false
  let scrubRate = 1
  let scrubStartRate = 1
  let scrubStartX = 0
  let scrubStartY = 0

  function scrubSeekTo(fraction: number): void {
    const pct = Math.min(100, Math.max(0, fraction * 100))
    seek.set_value(pct)
    const d = playback.duration
    if (!d || d <= 0) return
    pipeline.seekSeconds((pct / 100) * d)
  }

  /** The rate the vertical position asks for: the window's current rate at
   *  the scrubber, ramped down to the hard floor as the pointer rises to the
   *  top of the window. */
  function scrubRateFor(y: number): number {
    const [ok, , originY] = seekCatcher.translate_coordinates(win, 0, 0)
    const centre = (ok ? originY : 0) + seek.get_height() / 2
    const rise = centre - ((ok ? originY : 0) + y)
    if (rise <= 0) return scrubStartRate // at or below the scrubber: no change
    const reach = Math.max(1, centre) // the scrubber's own distance from the top
    const factor = Math.min(1, rise / reach)
    return Math.max(SCRUB_MIN_RATE, scrubStartRate * (1 - factor))
  }

  function applyScrubRate(rate: number): void {
    if (Math.abs(rate - scrubRate) < SCRUB_RATE_EPSILON) return
    scrubRate = rate
    pipeline.setSpeed(rate)
  }

  const scrub = Gtk.GestureDrag.new()
  scrub.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  seekCatcher.add_controller(scrub)
  scrub.connect("drag-begin", (_g: Gtk.GestureDrag, startX: number, startY: number) => {
    scrubbing = true
    scrubStartX = startX
    scrubStartY = startY
    scrubStartRate = pipeline.getStatus().speed > 0 ? pipeline.getStatus().speed : 1
    scrubRate = scrubStartRate
    const w = seekCatcher.get_width()
    if (w > 0) scrubSeekTo(startX / w)
  })
  scrub.connect("drag-update", (_g: Gtk.GestureDrag, offsetX: number, offsetY: number) => {
    const w = seekCatcher.get_width()
    if (w > 0) scrubSeekTo((scrubStartX + offsetX) / w)
    applyScrubRate(scrubRateFor(scrubStartY + offsetY))
  })
  scrub.connect("drag-end", () => {
    log("media: scrub end")
    scrubbing = false
    applyScrubRate(scrubStartRate)
  })

  // ── window-level input: motion reveals the transport controls, scroll
  //    zooms the media (wheel AND touchpad) ──

  const motion = new Gtk.EventControllerMotion()
  motion.connect("motion", () => {
    if (mode === "transport") showControls()
  })
  win.add_controller(motion)

  const scrollCtl = new Gtk.EventControllerScroll({
    flags: Gtk.EventControllerScrollFlags.VERTICAL,
  })
  win.add_controller(scrollCtl)
  let scrollAcc = 0
  scrollCtl.connect("scroll", (_c: Gtk.EventControllerScroll, _dx: number, dy: number) => {
    if (empty) return false
    const step =
      scrollCtl.get_unit() === Gdk.ScrollUnit.SURFACE ? SCROLL_SURFACE_STEP : SCROLL_WHEEL_STEP
    // GDK's positive delta is SOUTH (the ScrollUnit doc's own definition), so a
    // wheel notch away from the user (negative) zooms IN and the notch towards
    // it zooms OUT — the direction every viewer uses.
    scrollAcc -= dy
    let handled = false
    while (scrollAcc >= step) {
      scrollAcc -= step
      setZoom("in")
      handled = true
    }
    while (scrollAcc <= -step) {
      scrollAcc += step
      setZoom("out")
      handled = true
    }
    return handled
  })

  const thisSurface: Surface = {
    win,
    media: pipeline,
    get mode() {
      return mode
    },
    load,
    ring: (target: string) => loadRing(target),
    step,
    hasRing: () => ring.length > 0,
    setZoom,
    refreshView: () => {
      if (mode === "viewer") updateFooter()
      else refreshSeek()
    },
  }

  // ── transport events → state (single source of truth = this window's
  //    pipeline) + active selection (most-recently-playing) ──
  const unsub = pipeline.onEvent((ev) => {
    switch (ev.kind) {
      case "position":
        playback.timePos = ev.timePos ?? null
        playback.duration = ev.duration ?? null
        refreshSeek()
        break
      case "state":
        if (ev.playing) focus(thisSurface)
        break
      case "error":
        log(`media error: ${ev.message ?? "unknown"}`)
        break
      case "paintable":
        // A sink paintable without a frame yet paints black — bind only one
        // that reports a size (the initial read below applies the same rule).
        videoPt = trackSource(ev.paintable) ? ev.paintable : null
        applyPicture()
        applyZoom()
        break
      case "art":
        artPt = trackSource(ev.art) ? ev.art : null
        applyPicture()
        applyZoom()
        break
    }
  })

  // Focused window becomes the active command/MPRIS target (last-focused).
  win.connect("notify::is-active", () => {
    if (win.is_active) focus(thisSurface)
  })

  win.connect("map", () => win.grab_focus())

  // ── clean up on window close ──
  win.connect("close-request", () => {
    torn = true
    cancelPreload()
    unsub()
    pipeline.shutdown()
    removeSurface(thisSurface)
    return false // let the window close normally
  })

  // Register + activate BEFORE present so the first window owns MPRIS.
  surfaces.push(thisSurface)
  focus(thisSurface)
  enterMode("transport")
  setEmpty(true)
  refreshSeek()

  // The initial request runs on the window's `map`: deferring it keeps the
  // pipeline's preroll from starting until the window has been realized and
  // mapped (`load` picks the viewer or the transport from the file's kind),
  // and it is where a file-less window raises its portal prompt. Connect the
  // handler BEFORE present(): a toplevel is realized and mapped by the show
  // present() performs (GtkWidget::show — a shown toplevel is "immediately
  // realized and mapped"), so ::map is emitted before present() returns and a
  // handler connected after it is never called: the surface is then built
  // without its media, and only a path handed to an already open window (the
  // `load()` path) plays anything.
  // initialLoaded is a load-ONCE gate: the initial request is served on the
  // first map and never again, so a later re-map cannot overwrite what the
  // surface shows by then.
  let initialLoaded = false
  win.connect("map", () => {
    if (initialLoaded) return
    initialLoaded = true
    if (initial.path) load(initial.path)
    else if (initial.ring) loadRing(initial.path ?? "", initial.ring)
    else promptForFile()
  })

  win.present() // add_window registers; present maps it (files pattern)
  return thisSurface
}
