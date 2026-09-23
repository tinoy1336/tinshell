/**
 * zoom.probe — the media zoom model over a case matrix, headless.
 *
 * Two halves, both driving the REAL modules:
 *
 *  - the arithmetic (./zoom): the readout text, the scale the fit state
 *    computed, and which way a step moves;
 *  - the GTK half (./picture-zoom): the same widget structures the window
 *    builds — a Gtk.Picture in a Gtk.ScrolledWindow for the viewer, a ratio
 *    frame in one for the transport — pinned through the SAME
 *    applyPictureZoom/applyFrameZoom the window calls, then allocated and read
 *    back: the probe prints the box the picture is drawn into against the box
 *    the request asked for, and against the readout. Nothing is presented — no
 *    window exists for the user to see, and a display connection is needed only
 *    for `Gtk.init` (the house probe pattern, common/media/divider.probe).
 *
 * The sizes are this machine's: `hyprctl monitors` reports 2880×1800 at scale 2
 * (a 1440×900 logical desktop, GDK scale_factor 2), full-screen screenshots are
 * 2880×1800 px, and the media window's own default is 670×380 logical
 * (config.defaults.json). An unrealized widget reports scale factor 1, so the
 * widget half exercises the LOGICAL geometry; the screen-px conversion is the
 * arithmetic half, run at both scales.
 *
 * Run:
 *   ags bundle --gtk 4 apps/media/zoom.probe.ts /tmp/zoom-probe.sh
 *   bash /tmp/zoom-probe.sh          # exit 1 on any violated invariant
 */
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import { NullIntrinsicPaintable } from "@common/media/paintable"
import { applyFrameZoom, applyPictureZoom, boxedZoom } from "./picture-zoom"
import { fitScale, steppedZoom, ZOOM_STEP, zoomedExtent, zoomLabel } from "./zoom"

Gtk.init()

/** A viewport as GTK hands it to the app: LOGICAL px (what sizing is in). */
interface Viewport {
  name: string
  w: number
  h: number
}

/** A source image, in its own pixels. */
interface Image {
  name: string
  w: number
  h: number
}

/** What one case shows: the readout text, the scale it claims, and the box
 *  the compositor gets (screen px) plus the size request that produced it
 *  (logical px). */
interface Shot {
  label: string
  scale: number
  logicalW: number
  logicalH: number
  drawnW: number
  drawnH: number
}

/** This output's screen px per logical px (`gdk_monitor_get_scale_factor`). */
const DEVICE_SCALE = 2
/** An unscaled output, to show the conversion is what carries the truth. */
const UNSCALED = 1

const SMALL: Viewport = { name: "small 670x380 (app default)", w: 670, h: 380 }
const FULL: Viewport = { name: "full-screen 1440x900", w: 1440, h: 900 }

const IMAGES: Image[] = [
  { name: "full-screen shot 2880x1800", w: 2880, h: 1800 },
  { name: "4K shot 3840x2160", w: 3840, h: 2160 },
  { name: "small photo 400x300", w: 400, h: 300 },
]

const failures: string[] = []

function check(ok: boolean, what: string): void {
  if (!ok) failures.push(what)
}

/** A numeric zoom: the window sets a size request of image px × zoom ÷ scale,
 *  which the surface draws at × scale screen px. */
function numericShot(zoom: number, img: Image, scale: number): Shot {
  const logicalW = zoomedExtent(img.w, zoom, scale)
  const logicalH = zoomedExtent(img.h, zoom, scale)
  return {
    label: zoomLabel(zoom, null),
    scale: zoom,
    logicalW,
    logicalH,
    drawnW: logicalW * scale,
    drawnH: logicalH * scale,
  }
}

/** The fit state: the picture CONTAINs the viewport (no size request, expand
 *  on), so the drawn box is the scale fitScale computes. */
function fitShot(img: Image, view: Viewport, scale: number): Shot {
  const fit = fitScale(img.w, img.h, view.w * scale, view.h * scale) ?? 0
  const drawnW = img.w * fit
  const drawnH = img.h * fit
  return {
    label: zoomLabel("fit", fit),
    scale: fit,
    logicalW: Math.round(drawnW / scale),
    logicalH: Math.round(drawnH / scale),
    drawnW,
    drawnH,
  }
}

/** The percentage a label prints, or null when it prints none. */
function labelPercent(label: string): number | null {
  const m = /(\d+)%$/.exec(label)
  return m ? Number(m[1]) : null
}

function row(img: Image, view: Viewport, state: string, shot: Shot, scale: number): void {
  const viewW = view.w * scale
  const viewH = view.h * scale
  const fits = shot.drawnW <= viewW && shot.drawnH <= viewH
  console.log(
    [
      img.name.padEnd(28),
      view.name.padEnd(28),
      state.padEnd(18),
      shot.label.padEnd(10),
      shot.scale.toFixed(3).padStart(7),
      `${Math.round(shot.drawnW)}x${Math.round(shot.drawnH)}`.padEnd(12),
      `${viewW}x${viewH}`.padEnd(12),
      shot.label.startsWith("fit") ? (fits ? "fits" : "OVERFLOWS") : "",
    ].join(" "),
  )

  // The readout must describe the picture that is drawn.
  const printed = labelPercent(shot.label)
  const actual = Math.round((shot.drawnW / img.w) * 100)
  check(
    printed === actual,
    `${img.name} / ${view.name} / ${state}: label "${shot.label}" but the picture is drawn at ${actual}%`,
  )
  if (printed === null) {
    check(
      shot.label === "fit",
      `${img.name} / ${view.name} / ${state}: unmeasured label must be "fit"`,
    )
  }

  if (shot.label.startsWith("fit")) {
    // CONTAIN shows the whole image and gives up the slack on one axis only.
    check(fits, `${img.name} / ${view.name} / ${state}: fit does not fit`)
    const touching =
      Math.abs(shot.drawnW - viewW) <= scale / 2 + 1 ||
      Math.abs(shot.drawnH - viewH) <= scale / 2 + 1
    check(
      touching,
      `${img.name} / ${view.name} / ${state}: fit leaves both axes short (${shot.drawnW.toFixed(1)}x${shot.drawnH.toFixed(1)} in ${viewW}x${viewH})`,
    )
  } else {
    // A numeric zoom is exact, up to the size request's rounding.
    const errW = Math.abs(shot.drawnW - img.w * shot.scale)
    const errH = Math.abs(shot.drawnH - img.h * shot.scale)
    check(
      errW <= scale / 2 && errH <= scale / 2,
      `${img.name} / ${view.name} / ${state}: drawn box off by ${errW}x${errH} screen px`,
    )
  }
}

function header(scale: number): void {
  console.log(
    `\n── device scale ${scale} (${scale === 1 ? "unscaled output" : "2880x1800 @ scale 2"}) ──`,
  )
  console.log(
    [
      "image".padEnd(28),
      "viewport (logical)".padEnd(28),
      "state".padEnd(18),
      "readout".padEnd(10),
      "scale".padStart(7),
      "drawn (screen px)".padEnd(12),
      "viewport (screen px)".padEnd(12),
    ].join(" "),
  )
}

/** One full pass: every image in both viewports at fit, at 100%, and again
 *  after a resize that swaps the viewport under the same state. */
function pass(scale: number): void {
  header(scale)
  for (const img of IMAGES) {
    for (const view of [SMALL, FULL]) {
      const other = view === SMALL ? FULL : SMALL
      const zoomed = numericShot(1, img, scale)

      row(img, view, "fit", fitShot(img, view, scale), scale)
      row(img, view, "100%", zoomed, scale)
      row(img, other, "fit after resize", fitShot(img, other, scale), scale)
      row(img, other, "100% after resize", numericShot(1, img, scale), scale)

      // A resize must move the fit readout and the fit picture together, and
      // must leave a numeric zoom alone: 100% is a screen-px scale, not a
      // fraction of the viewport.
      const fitBefore = fitShot(img, view, scale)
      const fitAfter = fitShot(img, other, scale)
      check(
        fitBefore.label !== fitAfter.label || view.w * view.h === other.w * other.h,
        `${img.name}: the fit readout did not follow the resize`,
      )
      const zoomAfter = numericShot(1, img, scale)
      check(
        zoomed.label === zoomAfter.label && zoomed.drawnW === zoomAfter.drawnW,
        `${img.name}: 100% changed on a resize`,
      )

      // 1:1 means one image pixel per one SCREEN pixel, exactly.
      check(
        Math.abs(zoomed.drawnW - img.w) <= scale / 2 &&
          Math.abs(zoomed.drawnH - img.h) <= scale / 2,
        `${img.name} / ${view.name}: 100% draws ${zoomed.drawnW}x${zoomed.drawnH}, not ${img.w}x${img.h} screen px`,
      )
    }
  }
}

/** Steps from the fit state: they continue from the scale on screen, so an
 *  "out" step always shrinks and an "in" step always grows (unless the
 *  ZOOM_* range has nowhere left to go, which keeps the fit state). */
function steps(scale: number): void {
  console.log(`\n── steps from fit (device scale ${scale}) ──`)
  for (const img of IMAGES) {
    for (const view of [SMALL, FULL]) {
      const fit = fitScale(img.w, img.h, view.w * scale, view.h * scale) ?? 0
      const out = steppedZoom("fit", fit, "out")
      const inStep = steppedZoom("fit", fit, "in")
      const outScale = out === "fit" ? fit : out
      const inScale = inStep === "fit" ? fit : inStep
      console.log(
        [
          img.name.padEnd(28),
          view.name.padEnd(28),
          `fit ${(fit * 100).toFixed(1)}%`.padEnd(12),
          `out -> ${zoomLabel(out, fit)} (${(outScale * 100).toFixed(1)}%)`.padEnd(24),
          `in -> ${zoomLabel(inStep, fit)} (${(inScale * 100).toFixed(1)}%)`,
        ].join(" "),
      )
      check(
        outScale <= fit + 1e-9,
        `${img.name} / ${view.name}: an "out" step enlarged the picture (${outScale} > ${fit})`,
      )
      check(
        inScale >= fit - 1e-9,
        `${img.name} / ${view.name}: an "in" step shrank the picture (${inScale} < ${fit})`,
      )
      if (out !== "fit") {
        check(
          Math.abs(out - fit / ZOOM_STEP) < 1e-9,
          `${img.name} / ${view.name}: "out" stepped from ${out}, not from the fit scale`,
        )
      }
    }
  }
}

// ── the GTK half: the real widget structures, the real sizing functions ──

interface Harness {
  scroll: Gtk.ScrolledWindow
  /** The widget whose allocation carries the picture's box. */
  box: Gtk.Widget
  /** The widget the source paintable is bound to. */
  picture: Gtk.Picture
}

/** Every harness the run builds; held so nothing is collected while it is still
 *  bound to a widget. */
const kept: Harness[] = []

/** A synthetic source of `img`'s own pixel size — the probe needs no file and
 *  no decode, just a paintable whose intrinsic size is the image's. */
function texture(img: Image): Gdk.Texture {
  const stride = img.w * 4
  const bytes = new GLib.Bytes(new Uint8Array(stride * img.h))
  return Gdk.MemoryTexture.new(img.w, img.h, Gdk.MemoryFormat.R8G8B8A8, bytes, stride)
}

/** The viewer's structure, built the way window.tsx builds it. */
function viewerHarness(): Harness {
  const still = new Gtk.Picture({ hexpand: true, vexpand: true })
  still.set_content_fit(Gtk.ContentFit.CONTAIN)
  const scroll = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true })
  scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
  scroll.child = still
  const harness = { scroll, box: still, picture: still }
  kept.push(harness)
  return harness
}

/** The transport's structure: the ratio frame carries the media's ratio, and
 *  the picture inside binds the wrapper the window binds (no intrinsic size) —
 *  the frame's ratio is what keeps the media proportional. */
function transportHarness(img: Image, source: Gdk.Paintable): Harness {
  const aspect = new Gtk.AspectFrame({
    ratio: img.w / img.h,
    obeyChild: false,
    xalign: 0.5,
    yalign: 0.5,
  })
  const picture = new Gtk.Picture({ hexpand: true, vexpand: true, contentFit: Gtk.ContentFit.FILL })
  picture.paintable = new NullIntrinsicPaintable(source)
  aspect.set_child(picture)
  const scroll = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true })
  scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
  scroll.child = aspect
  const harness = { scroll, box: aspect, picture }
  kept.push(harness)
  return harness
}

/** One case measured through the real widgets: allocate the scrolled window at
 *  the viewport, then read the box GTK gave the picture and report it against
 *  the box that was asked for and the readout. */
function layoutRow(
  page: string,
  img: Image,
  view: Viewport,
  state: string,
  label: string,
  fit: number | null,
  want: { w: number; h: number },
  harness: Harness,
  scale: number,
): void {
  harness.scroll.allocate(view.w, view.h, -1, null)
  const boxW = harness.box.get_width()
  const boxH = harness.box.get_height()
  // What the media is drawn at: fit CONTAINs it inside the allocation, a
  // numeric zoom fills its own box with it.
  const drawn = label.startsWith("fit")
    ? { w: img.w * (fit ?? 0), h: img.h * (fit ?? 0) }
    : { w: boxW * scale, h: boxH * scale }
  console.log(
    [
      page.padEnd(10),
      img.name.padEnd(28),
      view.name.padEnd(28),
      state.padEnd(6),
      label.padEnd(10),
      `${boxW}x${boxH}`.padEnd(12),
      `${Math.round(drawn.w)}x${Math.round(drawn.h)}`.padEnd(12),
      `want ${want.w}x${want.h}`,
    ].join(" "),
  )
  check(
    boxW === want.w && boxH === want.h,
    `${page} / ${img.name} / ${view.name} / ${state}: the drawn box is ${boxW}x${boxH}, not ${want.w}x${want.h} logical px`,
  )
  const printed = labelPercent(label)
  const actual = Math.round((drawn.w / img.w) * 100)
  check(
    printed === actual,
    `${page} / ${img.name} / ${view.name} / ${state}: readout "${label}" vs drawn ${actual}%`,
  )
}

/** The viewer and the transport over the same matrix, measured through the real
 *  widgets. This half runs at scale 1 (an unrealized widget's factor), so the
 *  boxes it prints are the LOGICAL boxes the requests ask for. */
function layout(): void {
  console.log("\n── the real widgets (viewer + transport), allocated and read back ──")
  console.log(
    [
      "page".padEnd(10),
      "image".padEnd(28),
      "viewport (logical)".padEnd(28),
      "state".padEnd(6),
      "readout".padEnd(10),
      "box (logical)".padEnd(12),
      "image drawn (screen px)".padEnd(12),
    ].join(" "),
  )
  for (const img of IMAGES) {
    const src: Gdk.Paintable = texture(img)
    for (const view of [SMALL, FULL]) {
      const fit = fitScale(img.w, img.h, view.w, view.h) ?? 0
      const viewer = viewerHarness()
      applyPictureZoom(viewer.picture, src, { kind: "fit" })
      layoutRow(
        "viewer",
        img,
        view,
        "fit",
        zoomLabel("fit", fit),
        fit,
        { w: view.w, h: view.h },
        viewer,
        1,
      )
      for (const zoom of [1, 0.1]) {
        const pin = boxedZoom(img.w, img.h, zoom, 1)
        applyPictureZoom(viewer.picture, src, pin)
        layoutRow(
          "viewer",
          img,
          view,
          `${Math.round(zoom * 100)}%`,
          zoomLabel(zoom, null),
          null,
          boxSize(pin),
          viewer,
          1,
        )
      }

      const transport = transportHarness(img, src)
      applyFrameZoom(transport.box as Gtk.AspectFrame, { kind: "fit" })
      layoutRow(
        "transport",
        img,
        view,
        "fit",
        zoomLabel("fit", fit),
        fit,
        { w: view.w, h: view.h },
        transport,
        1,
      )
      for (const zoom of [1, 0.1]) {
        const pin = boxedZoom(img.w, img.h, zoom, 1)
        applyFrameZoom(transport.box as Gtk.AspectFrame, pin)
        layoutRow(
          "transport",
          img,
          view,
          `${Math.round(zoom * 100)}%`,
          zoomLabel(zoom, null),
          null,
          boxSize(pin),
          transport,
          1,
        )
      }
    }
  }
}

/** The logical box a numeric pin asks for. */
function boxSize(pin: ReturnType<typeof boxedZoom>): { w: number; h: number } {
  return pin.kind === "scaled" ? { w: pin.width, h: pin.height } : { w: 0, h: 0 }
}

/** The trap the model avoids, printed for contrast: a FILL picture with no
 *  alignment clamp is handed the whole VIEWPORT box however small its request
 *  is, and FILL then stretches the image onto that box — so the image would
 *  keep filling the window while the readout falls, which is what a request
 *  below the fit scale looks like without the clamp. */
function unclamped(): void {
  const img = IMAGES[0]
  const view = SMALL
  const src: Gdk.Paintable = texture(img)
  const still = new Gtk.Picture({ hexpand: true, vexpand: true })
  still.set_content_fit(Gtk.ContentFit.CONTAIN)
  const scroll = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true })
  scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
  scroll.child = still
  const harness = { scroll, box: still, picture: still }
  kept.push(harness)

  still.paintable = src
  still.set_hexpand(false)
  still.set_vexpand(false)
  still.set_content_fit(Gtk.ContentFit.FILL)
  const want = boxedZoom(img.w, img.h, 0.1, 1)
  const box = boxSize(want)
  still.set_size_request(box.w, box.h)
  scroll.allocate(view.w, view.h, -1, null)
  const gotW = still.get_width()
  const gotH = still.get_height()
  console.log("\n── the padded case, for contrast (FILL, no alignment clamp) ──")
  console.log(
    `  request ${box.w}x${box.h} in a ${view.w}x${view.h} viewport -> box ${gotW}x${gotH}: ` +
      `the image is drawn at ${((gotW / img.w) * 100).toFixed(1)}% while the request asked 10%`,
  )
  check(gotW > box.w, `the unclamped harness was expected to pad its box, got ${gotW}x${gotH}`)
}

/** The case the report came from, spelled out: a full-screen screenshot of
 *  THIS output, first at fit in the app's default window, then at 100%. */
function surprise(scale: number): void {
  const img = IMAGES[0]
  const fit = fitShot(img, SMALL, scale)
  const oneOne = numericShot(1, img, scale)
  const viewW = SMALL.w * scale
  console.log(`\n── the reported case (2880x1800 shot in the 670x380 window, scale ${scale}) ──`)
  console.log(`  fit   : ${fit.label} — the whole image at ${(fit.scale * 100).toFixed(1)}%`)
  console.log(
    `  100%  : ${oneOne.label} — ${Math.round(oneOne.drawnW)}x${Math.round(oneOne.drawnH)} screen px, so the window shows ${((viewW / oneOne.drawnW) * 100).toFixed(1)}% of the image width (${(oneOne.scale / fit.scale).toFixed(1)}x the fit scale)`,
  )
}

console.log("media zoom model — fit, 100%, resize and steps over the real ./zoom module")
for (const scale of [DEVICE_SCALE, UNSCALED]) {
  pass(scale)
  steps(scale)
  surprise(scale)
}
layout()
unclamped()

if (failures.length > 0) {
  console.log(`\nFAIL — ${failures.length} violated invariant(s):`)
  for (const f of failures) console.log(`  - ${f}`)
  imports.system.exit(1)
}
console.log("\nOK — every readout percentage matches the picture that is drawn")
// Unbind before exiting: a bound wrapper's vfuncs would be called during
// teardown's garbage collection (gjs blocks the call and logs a CRITICAL).
for (const h of kept) h.picture.paintable = null
imports.system.exit(0)
