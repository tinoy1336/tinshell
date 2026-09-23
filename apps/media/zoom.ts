/**
 * zoom — the viewer/transport scale model, pure arithmetic (no GTK, so
 * ./zoom.probe can drive the same functions the window calls).
 *
 * A zoom is a scale factor in SCREEN pixels per IMAGE pixel: `100%` means one
 * image pixel per one screen pixel and nothing else. GTK lays a window out in
 * LOGICAL px, which are screen px ÷ the surface's scale (2 on this machine's
 * 2880×1800 output), so a box meant to be `zoom` screen px per image pixel has
 * to be divided by that scale on the way into `set_size_request` — `zoomedExtent`
 * is the one place the conversion happens, and skips it nowhere.
 *
 * `"fit"` is an explicit STATE, not a number: the picture CONTAINs the
 * viewport and the readout prints the scale CONTAIN computed (`zoomLabel`), so
 * fitting a large screenshot reads as the small honest percentage it is rather
 * than as a zoom level someone chose. The state is also the base of a step
 * (`steppedZoom`): a step out of fit continues BELOW the scale on screen, so a
 * step never reverses the picture's direction.
 */

/** Zoom factor one scroll notch / key press applies. */
export const ZOOM_STEP = 1.25
/** The manual zoom range: a hard floor and ceiling for the numeric scale. */
export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 8

/** A surface's zoom: the fit state, or a scale factor in screen px per image
 *  px. */
export type Zoom = "fit" | number

/** A step direction — the keys, the wheel and the touchpad all use these. */
type ZoomDirection = "in" | "out"

/** Clamp a scale factor into the manual zoom range. */
function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

/** The scale a CONTAIN picture takes in a `viewW`×`viewH` viewport (both in
 *  screen px): the largest factor that shows the whole image, magnifying an
 *  image smaller than the viewport as well as shrinking a larger one. Null
 *  while the viewport or the image size is not known yet. */
export function fitScale(imgW: number, imgH: number, viewW: number, viewH: number): number | null {
  if (imgW <= 0 || imgH <= 0 || viewW <= 0 || viewH <= 0) return null
  return Math.min(viewW / imgW, viewH / imgH)
}

/** One zoom step from `current`, based on the scale on screen NOW: stepping
 *  out of fit continues from the scale fit computed (a fixed 100% base would
 *  magnify a large screenshot on an "out" step). A step the ZOOM_* range
 *  cannot honour — the fit scale itself already sits past the limit — leaves
 *  the fit state alone, because there is nowhere in that direction to go. */
export function steppedZoom(current: Zoom, fit: number | null, dir: ZoomDirection): Zoom {
  const base = current === "fit" ? (fit ?? 1) : current
  const next = clampZoom(base * (dir === "in" ? ZOOM_STEP : 1 / ZOOM_STEP))
  if (current === "fit" && (dir === "in" ? next <= base : next >= base)) return "fit"
  return next
}

/** The readout text: a numeric zoom is its own percentage, and the fit state
 *  carries the percentage it computed. Bare `fit` only while the viewport or
 *  the media size is unmeasured. */
export function zoomLabel(zoom: Zoom, fit: number | null): string {
  if (zoom !== "fit") return `${Math.round(zoom * 100)}%`
  return fit !== null && fit > 0 ? `fit ${Math.round(fit * 100)}%` : "fit"
}

/** The size request for `px` image pixels at `zoom`, in the widget's own
 *  LOGICAL px — screen px ÷ the surface scale. This rounding is the only loss
 *  in the model: the drawn box lands within half a screen pixel of the scale
 *  the readout prints. */
export function zoomedExtent(px: number, zoom: number, deviceScale: number): number {
  const scale = deviceScale > 0 ? deviceScale : 1
  return Math.max(1, Math.round((px * zoom) / scale))
}
