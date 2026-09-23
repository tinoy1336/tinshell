/**
 * row-region.probe — the capture region's ORIENTATION over all 12 dock
 * positions, headless: no window, no pointer, no display.
 *
 * The region is the dock surface's delivery boundary — the router drops any
 * enter/motion/press outside it — so a stadium laid along the wrong axis
 * silently un-captures the pixels it was built for, and an open panel closes
 * when the pointer reaches it. That failure class is INVISIBLE on a
 * top/bottom dock (both stadiums happen to match the horizontal assumption),
 * which is why every position is asserted.
 *
 * It drives the REAL builders (bandCaptureShape / panelCaptureShape) through
 * the REAL compilation (compileCaptureRegion), so the orientation rule lives
 * in exactly one place and this probe fails the moment a shape stops following
 * the geometry: each box must land INSIDE the surface's grow×band extent and on
 * the axis it names, and the point test must agree with the box it compiled —
 * the icon strip captures, the idle pill band beyond the icons does not, and
 * the open panel's own footprint does.
 *
 * The fixture mirrors the live dock's numbers (config.json: iconSize 34,
 * pillHeight 140, a 434px band); the geometry itself comes from the real
 * dockGeometry, so the position table is never re-stated here.
 *
 * Run:
 *   ags bundle --gtk 4 common/applets/utils/row-region.probe.ts /tmp/row-region-probe.sh
 *   bash /tmp/row-region-probe.sh     # exit 1 on any violated invariant
 */
import type { AppletConfig } from "@common/applets/config"
import { dockGeometry, POSITIONS } from "@common/applets/layout"
import {
  bandCaptureShape,
  type CaptureAxes,
  type CaptureRect,
  compileCaptureRegion,
  panelCaptureShape,
} from "./row-region.ts"

const SZ = 34
const LG = 140
const BAND = 434
const ROW_OFFSET = 100
const PANEL_OH = 100

// Only `layout` is read by the geometry derivation; the rest of AppletConfig is
// irrelevant to a point test. The numbers are the live dock's.
const config = {
  layout: {
    iconSize: SZ,
    pillHeight: LG,
    spacing: 6,
    marginTop: 8,
    marginBottom: 8,
    marginLeft: 8,
    marginRight: 8,
  },
} as unknown as AppletConfig

const failures: string[] = []
const check = (name: string, ok: boolean): void => {
  if (!ok) failures.push(name)
}

/** A surface point from logical coordinates: (grow, row) — the whole reason a
 *  region can be laid out on either axis without a per-position branch. */
function at(vertical: boolean, grow: number, row: number): { x: number; y: number } {
  return vertical ? { x: grow, y: row } : { x: row, y: grow }
}

const box = (r: CaptureRect | null): string =>
  r ? `x ${r.x}..${r.x + r.width} y ${r.y}..${r.y + r.height}` : "empty"

console.log("capture-region orientation — every dock position, real builders")
console.log(`fixture: iconSize ${SZ}, pillHeight ${LG}, band ${BAND}, row offset ${ROW_OFFSET}\n`)

for (const pos of POSITIONS) {
  const g = dockGeometry(pos, config)
  const axes: CaptureAxes = { row: g.rowAxis, grow: g.growAxis }
  const vertical = axes.row === "y"
  // The icons sit flush at the grow edge their pill grows toward.
  const iconFlush = g.growDir < 0 ? LG - SZ : 0
  const panelFlush = g.growDir < 0 ? LG - PANEL_OH : 0

  const band = compileCaptureRegion(
    [bandCaptureShape(axes, { growDir: g.growDir, growDim: LG, bandLen: BAND, thickness: SZ })],
    axes,
  )
  const panel = compileCaptureRegion(
    [
      panelCaptureShape(axes, {
        growDir: g.growDir,
        growDim: LG,
        rowOffset: ROW_OFFSET,
        oh: PANEL_OH,
        thickness: SZ,
      }),
    ],
    axes,
  )
  const b = band.extents()
  const p = panel.extents()
  const tag = `${pos}:`

  console.log(
    `${pos.padEnd(14)} rowAxis=${axes.row} growAxis=${axes.grow} growDir=${g.growDir}  band=[${box(b)}]  panel=[${box(p)}]`,
  )

  if (!b || !p) {
    check(`${tag} both shapes compiled to a non-empty box`, false)
    continue
  }

  // ── The band: as long as the applied band along the ROW axis, iconSize thick
  // along the GROW axis, flush at the icons' grow edge, starting at the row's
  // own origin. ──
  const bandRowLen = vertical ? b.height : b.width
  const bandThick = vertical ? b.width : b.height
  const bandRowStart = vertical ? b.y : b.x
  const bandGrowStart = vertical ? b.x : b.y
  check(`${tag} band runs ${BAND}px along the row axis (got ${bandRowLen})`, bandRowLen === BAND)
  check(`${tag} band is iconSize thick (got ${bandThick})`, bandThick === SZ)
  check(`${tag} band starts at the row origin (got ${bandRowStart})`, bandRowStart === 0)
  check(
    `${tag} band is flush at the icons' grow edge (got ${bandGrowStart})`,
    bandGrowStart === iconFlush,
  )

  // ── The panel: PANEL_OH along the GROW axis, iconSize along the ROW axis at
  // the applet's own row offset, flush at the icons' grow edge. ──
  const panelGrowLen = vertical ? p.width : p.height
  const panelRowLen = vertical ? p.height : p.width
  const panelGrowStart = vertical ? p.x : p.y
  const panelRowStart = vertical ? p.y : p.x
  check(
    `${tag} panel runs ${PANEL_OH}px along the grow axis (got ${panelGrowLen})`,
    panelGrowLen === PANEL_OH,
  )
  check(`${tag} panel is iconSize thick along the row (got ${panelRowLen})`, panelRowLen === SZ)
  check(
    `${tag} panel sits at the applet's row offset (got ${panelRowStart})`,
    panelRowStart === ROW_OFFSET,
  )
  check(
    `${tag} panel is flush at the icons' grow edge (got ${panelGrowStart})`,
    panelGrowStart === panelFlush,
  )

  // ── Both boxes must live INSIDE the surface: grow extent pillHeight, row
  // extent the band. A stadium laid on the wrong axis runs off this box (it is
  // what a rotated region does). ──
  for (const [name, r] of [
    ["band", b],
    ["panel", p],
  ] as const) {
    const growLo = vertical ? r.x : r.y
    const growHi = vertical ? r.x + r.width : r.y + r.height
    const rowLo = vertical ? r.y : r.x
    const rowHi = vertical ? r.y + r.height : r.x + r.width
    check(
      `${tag} ${name} inside the surface: grow ${growLo}..${growHi} within 0..${LG}`,
      growLo >= 0 && growHi <= LG,
    )
    check(
      `${tag} ${name} inside the surface: row ${rowLo}..${rowHi} within 0..${BAND}`,
      rowLo >= 0 && rowHi <= BAND,
    )
  }

  // ── The point test must agree with the boxes it compiled. ──
  const rowMid = ROW_OFFSET + SZ / 2
  const iconMid = iconFlush + SZ / 2
  const iconPoint = at(vertical, iconMid, rowMid)
  check(`${tag} icon centre is captured`, band.contains(iconPoint.x, iconPoint.y))

  // The idle pill band beyond the icons stays click-through (the router must
  // not hover-open a panel for a pointer resting in the empty band).
  const beyond = iconFlush + (g.growDir < 0 ? -1 : SZ)
  const beyondPoint = at(vertical, beyond, rowMid)
  check(
    `${tag} the pill band beyond the icons is NOT captured`,
    !band.contains(beyondPoint.x, beyondPoint.y),
  )

  // The panel's own body captures — the pixel the pointer reaches when it
  // leaves the icon for the open panel.
  const panelMid = panelFlush + PANEL_OH / 2
  const panelPoint = at(vertical, panelMid, rowMid)
  check(`${tag} the open panel's body is captured`, panel.contains(panelPoint.x, panelPoint.y))
  check(
    `${tag} the open panel covers the gap the closed icon leaves (grow mid ${panelMid.toFixed(1)})`,
    panel.contains(beyondPoint.x, beyondPoint.y),
  )
}

console.log()
if (failures.length > 0) {
  console.log(`FAIL — ${failures.length} violated invariant(s):`)
  for (const f of failures) console.log(`  - ${f}`)
  imports.system.exit(1)
}
console.log(
  `OK — band and panel boxes land on the right axes at every one of the ${POSITIONS.length} positions`,
)
imports.system.exit(0)
