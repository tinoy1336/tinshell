/**
 * common/applets/layout.ts — position → geometry derivation (the generic-direction core).
 *
 * All dock directionality derives from the position string here, in one
 * auditable module. Consumers take a DockGeometry and branch only on its
 * scalars — no per-position switches scattered through rendering code.
 *
 * The 12 positions collapse to:
 *
 *   rotation — 0 for the top/bottom family; ±90° for left/right. The pill is
 *     ALWAYS painted as a vertical shape (proven code, never edited); for
 *     horizontal docks the draw_func applies this rotation before delegating
 *     to the unchanged vertical paint. So rotation is a Layer-A (Cairo)
 *     concern, applied at the paint entry point only.
 *
 *   growDir — which way the pill's value increases along its long axis.
 *     -1 = toward smaller coords (bottom grows up; right grows left toward 0).
 *     +1 = toward larger coords (top grows down; left grows right).
 *
 *   rowAxis — the axis applets stack along: "x" for top/bottom (a horizontal
 *     row), "y" for left/right (a vertical column).
 *
 *   anchor — WindowAnchor flags. ALWAYS two perpendicular edges (grow-edge +
 *     row-start edge). Without the row-start anchor, the compositor centres
 *     every window on one point and they stack. Corner (start/end) changes
 *     only the offset BASE, never the anchor.
 *
 *   rowAlign — centre | start | end. Plain edges centre; corner variants flush.
 *
 *   margin — which config edge margins apply (the window sets the one(s)
 *     matching its anchored edges).
 *
 * Reading order is uniform (applet 0 at the lowest offset) across all
 * positions. Reversing for an end-corner is a one-line change in rowOffsets.
 */

import type { AppletConfig } from "@common/applets/config"
import { geo } from "@common/applets/utils/geo-log"
import { Astal } from "ags/gtk4"

export type Axis = "x" | "y"

export interface DockGeometry {
  position: string
  /** Canvas rotation for the pill paint: 0 (top/bottom) | +90 | -90 (left/right). */
  rotation: number
  /** Value-vs-coord direction along the pill's long axis: -1 (toward 0) | +1. */
  growDir: 1 | -1
  /** Axis applets stack along. */
  rowAxis: Axis
  /** The pill grows along the other axis (the window's long dimension). */
  growAxis: Axis
  /** Layer-shell anchor flags (always two perpendicular edges). */
  anchor: Astal.WindowAnchor
  /** Row alignment: center | start | end (corner handling). */
  rowAlign: "center" | "start" | "end"
  /** Edge margins from config. */
  margin: { top: number; bottom: number; left: number; right: number }
}

export const POSITIONS = [
  "bottom-middle",
  "bottom-left",
  "bottom-right",
  "top-middle",
  "top-left",
  "top-right",
  "left-middle",
  "left-top",
  "left-bottom",
  "right-middle",
  "right-top",
  "right-bottom",
] as const

/**
 * Overflow caret orientation angles (radians, Cairo y-down) for a dock
 * geometry. Both angles are the rotation applied to the base caret glyph
 * (`appearance.icons.overflow`, caret-up — rotate(+π/2) maps up→right):
 *
 *   resting — perpendicular to the row axis, pointing INTO the screen along
 *     the dock's grow direction (bottom→up, top→down, left→right, right→left).
 *   reveal — parallel to the row axis, pointing in the reading-order
 *     direction the revealed icons appear from (right for bottom/top docks,
 *     down for left/right docks — uniform across start/centre/end alignment,
 *     since the overflow icon always sits at the row's reading-order end of
 *     the visible block and the parked icons extend past it).
 *
 * The reveal angle is represented so the resting→reveal tween is always a
 * clean 90° (right-edge uses −π ≡ π to avoid a 270° sweep).
 */
export function overflowCaretAngles(dg: Pick<DockGeometry, "position">): {
  resting: number
  reveal: number
} {
  const primary = dg.position.split("-")[0]
  switch (primary) {
    case "bottom":
      return { resting: 0, reveal: Math.PI / 2 }
    case "top":
      return { resting: Math.PI, reveal: Math.PI / 2 }
    case "left":
      return { resting: Math.PI / 2, reveal: Math.PI }
    case "right":
      return { resting: -Math.PI / 2, reveal: -Math.PI }
  }
  return { resting: 0, reveal: Math.PI / 2 } // fallback: bottom-like
}

function parts(pos: string): {
  primary: "top" | "bottom" | "left" | "right"
  corner?: "start" | "end"
} {
  const [a, b] = pos.split("-")
  if (a === "bottom" || a === "top") {
    return { primary: a, corner: b === "left" ? "start" : b === "right" ? "end" : undefined }
  }
  return {
    primary: a as "left" | "right",
    corner: b === "top" ? "start" : b === "bottom" ? "end" : undefined,
  }
}

/** Derive the full geometry from a position string (the caller's live config
 *  supplies the margins). Unknown positions fall
 *  back to a bottom dock (default case) and log an event — never undefined. */
export function dockGeometry(position: string, config: AppletConfig): DockGeometry {
  const { primary, corner } = parts(position)
  const m = config.layout
  const margin = {
    top: m.marginTop,
    bottom: m.marginBottom,
    left: m.marginLeft,
    right: m.marginRight,
  }
  const rowAlign = corner ?? "center"
  const A = Astal.WindowAnchor

  let g: DockGeometry
  switch (primary) {
    case "bottom":
      // grows UP (value-max at top). Row is horizontal (x). Anchor bottom + left.
      g = {
        position,
        rotation: 0,
        growDir: -1,
        rowAxis: "x",
        growAxis: "y",
        anchor: A.BOTTOM | A.LEFT,
        rowAlign,
        margin,
      }
      break
    case "top":
      // grows DOWN (value-max at bottom). Row horizontal. Anchor top + left.
      g = {
        position,
        rotation: 0,
        growDir: 1,
        rowAxis: "x",
        growAxis: "y",
        anchor: A.TOP | A.LEFT,
        rowAlign,
        margin,
      }
      break
    case "left":
      // grows RIGHT (value-max at right). Row vertical (y). Anchor left + top.
      // Rotation +90° so the vertical pill paint faces right.
      g = {
        position,
        rotation: 90,
        growDir: 1,
        rowAxis: "y",
        growAxis: "x",
        anchor: A.LEFT | A.TOP,
        rowAlign,
        margin,
      }
      break
    case "right":
      // grows LEFT (value-max at left/0). Row vertical. Anchor right + top.
      // Rotation -90° so the vertical pill paint faces left.
      g = {
        position,
        rotation: -90,
        growDir: -1,
        rowAxis: "y",
        growAxis: "x",
        anchor: A.RIGHT | A.TOP,
        rowAlign,
        margin,
      }
      break
    default:
      // Unknown position (hand-edited config.json past the schema enum):
      // fall back to a bottom dock instead of leaving g undefined — the
      // undefined crash took the dock down at mount.
      geo("geometry", { event: "unknown-position-fallback", pos: position, fallback: "bottom" })
      g = {
        position,
        rotation: 0,
        growDir: -1,
        rowAxis: "x",
        growAxis: "y",
        anchor: A.BOTTOM | A.LEFT,
        rowAlign,
        margin,
      }
      break
  }
  geo("geometry", {
    pos: position,
    rot: g.rotation,
    growDir: g.growDir,
    rowAxis: g.rowAxis,
    rowAlign: g.rowAlign,
  })
  return g
}

/** Per-applet offset along the row axis, measured from the row-start edge
 *  (LEFT → marginLeft for top/bottom; TOP → marginTop for left/right).
 *  centred → (screenLen−total)/2; start → 0; end → screenLen−total. */
export function rowOffsets(
  dg: DockGeometry,
  count: number,
  screenW: number,
  screenH: number,
  config: AppletConfig,
): number[] {
  const sz = config.layout.iconSize
  const spacing = config.layout.spacing
  const screenLen = dg.rowAxis === "x" ? screenW : screenH
  const totalLen = count * sz + (count - 1) * spacing

  // Margins along the row axis: start margin for start-aligned corners,
  // end margin for end-aligned corners. Centre uses no margin (it's implicit
  // in the centring).
  const m = dg.margin
  const startMargin = dg.rowAxis === "x" ? m.left : m.top
  const endMargin = dg.rowAxis === "x" ? m.right : m.bottom

  let start: number
  if (dg.rowAlign === "center") start = Math.round((screenLen - totalLen) / 2)
  else if (dg.rowAlign === "start") start = startMargin
  else start = Math.round(screenLen - totalLen - endMargin)

  const offs = Array.from({ length: count }, (_, i) => start + i * (sz + spacing))
  geo("rowOffsets", { count, screenLen, totalLen, align: dg.rowAlign, offsets: offs.join(",") })
  return offs
}
