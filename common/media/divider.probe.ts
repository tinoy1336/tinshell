/**
 * divider.probe — reproducible probe for the width judgement the shared divider
 * applies to the preview pane (`common/media/divider`).
 *
 * REAL modules and REAL GTK geometry, no window and no pointer: it builds the
 * split a host builds (`createMediaPane` + `createPreviewSession` +
 * `attachPaneDivider`), drives a "drag" by writing the paned's `position` — the
 * one geometry signal the judgement rides on — and calls `Gtk.Widget.allocate`
 * itself, which runs the paned's real size-allocate. The pane's visibility is
 * wired to the window's switch the way a host wires it (`apps/files/preview`,
 * whose `sync` is those same lines), so a fold takes the pane off screen. Nothing
 * is presented: no window exists for the user to see, and a display connection is
 * needed only for `Gtk.init` and the fixture's own stylesheet.
 *
 * The drag target of each case is derived from the paned's own separator strip,
 * measured after the seed, so a case asks the pane for exactly the width it
 * names — the same position↔width relation the divider itself judges with.
 *
 * The pane in the `hairline` section carries the edge BOTH hosts draw on it
 * (`media-pane-split`: a 1px CSS border, apps/files/style.css). A CSS border
 * sits inside the slot the paned allocates and is NOT part of the width the pane
 * reports, so a judgement taken on the reported width holds a pane at its floor
 * and then folds it; that section covers the floor with the edge on.
 *
 * The preference store is sandboxed by XDG_STATE_HOME — the probe never reads or
 * writes the user's preview preference.
 *
 * Run: bundle with the repo bundler and run the wrapper under gjs, e.g.
 *   XDG_STATE_HOME=/tmp/divider-probe-state \
 *     /usr/bin/ags bundle --gtk 4 common/media/divider.probe.ts /tmp/divider-probe.sh
 * (then point the wrapper's `file=` line at a probe-only JS path), and
 *   GDK_BACKEND=wayland XDG_STATE_HOME=/tmp/divider-probe-state \
 *     bash /tmp/divider-probe.sh
 */
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import { attachPaneDivider } from "./divider"
import { createMediaPane } from "./pane"
import {
  createPreviewSession,
  PREVIEW_MIN_WIDTH,
  PREVIEW_SNAP_SHUT_WIDTH,
  previewSettings,
  setPreviewEnabled,
  setPreviewWidth,
} from "./preview"

/** The paned width every drag case allocates — a host window's body row. */
const PANED_WIDTH = 900
/** The height every case allocates; the judgement reads widths only. */
const PANED_HEIGHT = 600
/** The listing side's minimum — the split may not be pushed past it. */
const LIST_MIN = 240
/** The width every case seeds from, before the drag. */
const SEED_WIDTH = 260
/** The divider's settle debounce, with slack for the main loop. */
const SETTLE_MS = 400
/** The pane widths a drag is exercised at: both sides of both thresholds. */
const WIDTHS = [320, 260, 200, 199, 175, 150, 120, 101, 100, 99, 50]
/** Upper bound on the seed's overshoot: the divider measures the paned's
 *  separator from a layout where the pane is still hidden, so a pane can come
 *  back up to one separator (plus the list's grab margin) above the stored one. */
const SEED_SLACK = 16
/** What a drag asks for when it is driven back OUT of the fold's way. */
const BACK_OUT_WIDTH = 300
/** A window too narrow to give the pane its floor, to observe that case. */
const CRAMPED_WIDTH = 300
/** The pane slot widths the `hairline` section drags to: both sides of the floor. */
const HAIRLINE_WIDTHS = [300, 260, 200, 199, 175, 150, 120]
/** The side-slot edge both hosts draw on the pane (`media-pane-split`) and its
 *  width — the fixture's own copy of `apps/files/style.css`. */
const HAIRLINE_CLASS = "media-pane-split"
const HAIRLINE_PX = 1

interface Row {
  /** The pane width the drag asks for. */
  wanted: number
  /** The position the drag writes — the pointer's position in a real drag. */
  target: number
  /** The position the divider HOLDS after the drag. */
  position: number
  /** The pane width the held position leaves room for (the paned's relation). */
  slot: number
  /** The pane width GTK allocates after the drag. */
  width: number
  /** The pane's own switch, after the divider's settle pass. */
  enabled: boolean
  /** The pane's visibility, after the divider's settle pass. */
  visible: boolean
  /** The stored side-slot width, after the divider's settle pass. */
  stored: number
}

Gtk.init()

const hairline = new Gtk.CssProvider()
hairline.load_from_string(
  `.${HAIRLINE_CLASS} { border-left: ${HAIRLINE_PX}px solid rgba(255, 255, 255, 0.06); }`,
)
const gdkDisplay = Gdk.Display.get_default()
if (!gdkDisplay) throw new Error("divider probe: no display connection")
Gtk.StyleContext.add_provider_for_display(
  gdkDisplay,
  hairline,
  Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
)

const paned = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL })
const list = new Gtk.Box()
list.set_size_request(LIST_MIN, -1)
const session = createPreviewSession()
const pane = createMediaPane({
  appearance: { textColour: "#e6e6e6", fontSize: 16, iconSize: 16 },
  mode: "pane",
  onOpen: () => {},
})
paned.set_start_child(list)
paned.set_end_child(pane.widget)
/** The host window's stand-in: the divider reads its `map` for the seed. */
const display = new Gtk.Box()
const detach = attachPaneDivider({ paned, pane: pane.widget, display, session })
/** The host's half of the fold: the window's switch is what puts the pane on
 *  screen (`apps/files/preview.sync`), so off means the pane is not there. */
const offSession = session.subscribe(() => pane.widget.set_visible(session.enabled()))

function allocate(width: number): void {
  paned.allocate(width, PANED_HEIGHT, -1, null)
}

/** Run the main loop long enough for the divider's settle debounce to fire. */
function settleSpin(): void {
  const loop = GLib.MainLoop.new(null, false)
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
    loop.quit()
    return GLib.SOURCE_REMOVE
  })
  loop.run()
}

/** Put the pane on screen at the stored width — the state a user's window hands
 *  the divider before they take it — and return the paned's OWN separator strip,
 *  measured from that allocation (the pane has the seed width there). */
function seed(panedWidth: number): number {
  setPreviewEnabled(true)
  setPreviewWidth(SEED_WIDTH)
  pane.widget.set_visible(false)
  allocate(panedWidth)
  session.setEnabled(true, false) // the probe owns the store writes
  pane.widget.set_visible(true) // the divider's own seed (notify::visible → apply)
  allocate(panedWidth)
  return panedWidth - paned.position - pane.widget.get_width()
}

/** Take the divider to `wanted` the way a drag does, and report what the pane is
 *  left as once the divider's own settle pass has run. */
function runCase(panedWidth: number, wanted: number): Row {
  const handle = seed(panedWidth)
  const target = panedWidth - wanted - handle
  paned.position = target
  const position = paned.position // a held drag is corrected inside this write
  allocate(panedWidth)
  const width = pane.widget.get_width()
  settleSpin()
  return {
    wanted,
    target,
    position,
    slot: panedWidth - position - handle,
    width,
    enabled: session.enabled(),
    visible: pane.widget.get_visible(),
    stored: previewSettings().width,
  }
}

/** What the pane is left as, from the observations alone. */
function verdictOf(r: Row): string {
  if (!r.enabled) return "folds shut"
  if (r.slot < PREVIEW_MIN_WIDTH) return "divider ran past"
  if (r.width < PREVIEW_MIN_WIDTH) return "sliver below floor"
  if (r.wanted < PREVIEW_MIN_WIDTH) return "held at floor"
  return "accepted"
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}

function table(rows: Row[]): void {
  const head = ["wanted", "drag", "held", "slot", "pane", "switch", "on", "stored", "verdict"]
  console.log(
    ["width", "pos", "pos", "px", "width", "", "screen", "width", ""]
      .map((h, i) => pad(h, head[i].length + 2))
      .join(""),
  )
  for (const r of rows) {
    console.log(
      [r.wanted, r.target, r.position, r.slot, r.width, r.enabled ? "on" : "OFF"]
        .map((v, i) => pad(String(v), head[i].length + 2))
        .concat([
          pad(r.visible ? "yes" : "no", head[6].length + 2),
          pad(String(r.stored), head[7].length + 2),
          verdictOf(r),
        ])
        .join(""),
    )
  }
}

function main(): void {
  const settings = previewSettings()
  const min = pane.widget.measure(Gtk.Orientation.HORIZONTAL, -1) as unknown as number[]
  console.log("probe: divider.probe (common/media/divider)")
  console.log(
    `state: ${settings.enabled ? "enabled" : "disabled"} ${settings.mode} width=${settings.width}`,
  )
  console.log(
    `pane: min=${min[0]} floor=${PREVIEW_MIN_WIDTH} snap=${PREVIEW_SNAP_SHUT_WIDTH} ` +
      `paned=${PANED_WIDTH} list-min=${LIST_MIN} seed=${SEED_WIDTH} ` +
      `shrink-end-child=${paned.get_shrink_end_child()}`,
  )

  const rows = WIDTHS.map((w) => runCase(PANED_WIDTH, w))
  table(rows)

  // ── the drag contract ──
  const failures: string[] = []
  const fail = (msg: string): void => {
    failures.push(msg)
  }
  for (const r of rows) {
    if (r.enabled && r.width < PREVIEW_MIN_WIDTH)
      fail(`${r.wanted}px: pane is ${r.width}px wide, under its ${PREVIEW_MIN_WIDTH}px floor`)
    if (r.enabled && r.slot < PREVIEW_MIN_WIDTH)
      fail(`${r.wanted}px: the divider left the pane only ${r.slot}px of slot`)
    if (r.enabled && !r.visible) fail(`${r.wanted}px: switch on but the pane is off screen`)
    if (r.wanted >= PREVIEW_MIN_WIDTH) {
      if (!r.enabled) fail(`${r.wanted}px: pane folded at or above its floor`)
      else if (r.width !== r.wanted) fail(`${r.wanted}px: pane took ${r.width}px`)
      else if (r.stored !== r.wanted) fail(`${r.wanted}px: stored width is ${r.stored}`)
    } else if (r.wanted >= PREVIEW_SNAP_SHUT_WIDTH) {
      if (!r.enabled) fail(`${r.wanted}px: pane folded inside the hold band`)
      else if (r.width !== PREVIEW_MIN_WIDTH) fail(`${r.wanted}px: pane held at ${r.width}px`)
      else if (r.stored !== PREVIEW_MIN_WIDTH) fail(`${r.wanted}px: stored width is ${r.stored}`)
    } else {
      if (r.enabled) fail(`${r.wanted}px: pane stayed on at/below the snap width`)
      if (r.visible) fail(`${r.wanted}px: switch off but the pane is still on screen`)
      if (r.stored !== SEED_WIDTH)
        fail(`${r.wanted}px: a fold rewrote the stored width to ${r.stored}`)
    }
  }

  // ── the host's side-slot edge: the pane's own CSS border sits INSIDE the slot
  //    the paned allocates and is absent from the width the pane reports, so a
  //    judgement taken on the reported width and a hold taken on the slot
  //    disagree by it ──
  // The handle is measured with the pane as the fixture built it: the edge moves
  // the pane's reported width, never the paned's separator.
  const hairlineHandle = seed(PANED_WIDTH)
  pane.widget.add_css_class(HAIRLINE_CLASS)
  interface HairlineRow {
    /** The pane SLOT width the drag asks for. */
    wanted: number
    /** The pane slot the divider left (the paned's relation, edge included). */
    slot: number
    /** The width the pane itself reports — its slot minus its own border. */
    reported: number
    enabled: boolean
    visible: boolean
    stored: number
  }
  const hairlineRows: HairlineRow[] = HAIRLINE_WIDTHS.map((wanted) => {
    seed(PANED_WIDTH)
    paned.position = PANED_WIDTH - wanted - hairlineHandle
    allocate(PANED_WIDTH)
    const slot = PANED_WIDTH - paned.position - hairlineHandle
    const reported = pane.widget.get_width()
    settleSpin()
    return {
      wanted,
      slot,
      reported,
      enabled: session.enabled(),
      visible: pane.widget.get_visible(),
      stored: previewSettings().width,
    }
  })
  seed(PANED_WIDTH)
  paned.position = PANED_WIDTH - (PREVIEW_SNAP_SHUT_WIDTH - 1) - hairlineHandle
  allocate(PANED_WIDTH)
  settleSpin()
  const hairlineFold = {
    enabled: session.enabled(),
    visible: pane.widget.get_visible(),
    stored: previewSettings().width,
  }
  pane.widget.remove_css_class(HAIRLINE_CLASS)
  for (const r of hairlineRows) {
    console.log(
      `hairline: drag asks ${r.wanted}px → slot=${r.slot} pane=${r.reported}px ` +
        `switch=${r.enabled ? "on" : "OFF"} on-screen=${r.visible ? "yes" : "no"} ` +
        `stored=${r.stored}`,
    )
    const wantSlot = Math.max(r.wanted, PREVIEW_MIN_WIDTH)
    if (!r.enabled) fail(`hairline: ${r.wanted}px: the pane folded`)
    if (r.visible !== r.enabled)
      fail(`hairline: ${r.wanted}px: the pane is not where the switch says`)
    if (r.enabled && r.slot !== wantSlot)
      fail(`hairline: ${r.wanted}px: the divider left the pane a ${r.slot}px slot`)
    if (r.enabled && r.reported !== r.slot - HAIRLINE_PX)
      fail(
        `hairline: ${r.wanted}px: the pane reports ${r.reported}px of its ${r.slot}px slot ` +
          `(its own ${HAIRLINE_PX}px edge is inside the slot)`,
      )
    if (r.enabled && r.stored !== wantSlot)
      fail(`hairline: ${r.wanted}px: stored width is ${r.stored}`)
  }
  console.log(
    `hairline: drag asks ${PREVIEW_SNAP_SHUT_WIDTH - 1}px → ` +
      `switch=${hairlineFold.enabled ? "on" : "OFF"} ` +
      `on-screen=${hairlineFold.visible ? "yes" : "no"} stored=${hairlineFold.stored}`,
  )
  if (hairlineFold.enabled || hairlineFold.visible)
    fail("hairline: a drag under the snap width left the pane on")
  if (hairlineFold.stored !== SEED_WIDTH) fail("hairline: the fold rewrote the stored width")

  // ── the hold is not sticky: a drag back out of the floor follows again ──
  const handle = seed(PANED_WIDTH)
  paned.position = PANED_WIDTH - 175 - handle // into the hold band
  allocate(PANED_WIDTH)
  const heldWidth = pane.widget.get_width()
  paned.position = PANED_WIDTH - 300 - handle // back out of it
  allocate(PANED_WIDTH)
  settleSpin()
  console.log(
    `hold is not sticky: held=${heldWidth}px, then the drag back asks 300px → ` +
      `pane=${pane.widget.get_width()}px stored=${previewSettings().width}`,
  )
  if (heldWidth !== PREVIEW_MIN_WIDTH) fail(`the hold band left the pane at ${heldWidth}px`)
  if (pane.widget.get_width() !== 300) fail("a drag back out of the floor did not follow")
  if (previewSettings().width !== 300) fail("a drag back out of the floor did not store")

  // ── recovery: a drag under the snap width closes the pane, and the way back is
  //    the window's own switch — which re-seeds from the width the user stored ──
  const handleRun = seed(PANED_WIDTH)
  paned.position = PANED_WIDTH - (PREVIEW_SNAP_SHUT_WIDTH - 1) - handleRun // under the snap
  allocate(PANED_WIDTH)
  const folded = {
    position: paned.position,
    enabled: session.enabled(),
    visible: pane.widget.get_visible(),
  }
  const storedAfterFold = previewSettings().width
  paned.position = PANED_WIDTH - BACK_OUT_WIDTH - handleRun // the drag comes back out
  allocate(PANED_WIDTH)
  settleSpin()
  const backOut = {
    position: paned.position,
    enabled: session.enabled(),
    stored: previewSettings().width,
  }
  session.setEnabled(true, false) // the window's own switch, as a host flips it
  allocate(PANED_WIDTH)
  const returned = {
    enabled: session.enabled(),
    visible: pane.widget.get_visible(),
    width: pane.widget.get_width(),
  }
  console.log(
    `recovery: drag asks ${PREVIEW_SNAP_SHUT_WIDTH - 1}px → pos=${folded.position} ` +
      `switch=${folded.enabled ? "on" : "OFF"} pane=${folded.visible ? "on screen" : "off screen"} ` +
      `stored=${storedAfterFold}; drag back asks ${BACK_OUT_WIDTH}px → pos=${backOut.position} ` +
      `switch=${backOut.enabled ? "on" : "OFF"} stored=${backOut.stored}; switch on again → ` +
      `pane=${returned.visible ? "on screen" : "off screen"} width=${returned.width}px`,
  )
  if (folded.enabled || folded.visible)
    fail("recovery: a drag under the snap width left the pane on")
  if (storedAfterFold !== SEED_WIDTH) fail("recovery: the fold rewrote the stored width")
  if (backOut.enabled) fail("recovery: a drag back out reopened the pane by itself")
  if (backOut.stored !== SEED_WIDTH) fail("recovery: a drag back out rewrote the stored width")
  if (!returned.enabled || !returned.visible)
    fail("recovery: the switch did not bring the pane back")
  if (Math.abs(returned.width - SEED_WIDTH) > SEED_SLACK)
    fail(`recovery: the pane came back at ${returned.width}px, not the stored ${SEED_WIDTH}px`)

  // ── a resize: what the paned does to the position on its own (it splits the
  //    delta between the children) is no judgement of this module's; a resize
  //    that CLAMPS the position is judged like a drag, and a clamp puts the
  //    divider at the paned's own end ──
  const handleResize = seed(PANED_WIDTH)
  paned.position = PANED_WIDTH - BACK_OUT_WIDTH - handleResize // the pane at 300, settled
  allocate(PANED_WIDTH)
  settleSpin()
  const storedBefore = previewSettings().width
  allocate(PANED_WIDTH + 200) // wider: the paned hands each side half the space
  const grown = {
    position: paned.position,
    width: pane.widget.get_width(),
    enabled: session.enabled(),
    stored: previewSettings().width,
  }
  paned.position = PANED_WIDTH + 200 - BACK_OUT_WIDTH - handleResize // a drag after it
  allocate(PANED_WIDTH + 200)
  settleSpin()
  const afterResize = {
    position: paned.position,
    width: pane.widget.get_width(),
    enabled: session.enabled(),
  }
  allocate(590) // narrower than the divider: the paned clamps the position
  const shrunk = {
    position: paned.position,
    width: pane.widget.get_width(),
    enabled: session.enabled(),
    visible: pane.widget.get_visible(),
    stored: previewSettings().width,
  }
  allocate(500) // deeper still, past the pane's floor and the list's minimum
  const deeper = {
    position: paned.position,
    width: pane.widget.get_width(),
    enabled: session.enabled(),
    visible: pane.widget.get_visible(),
  }
  console.log(
    `resize: pane at ${BACK_OUT_WIDTH}px (stored ${storedBefore}); wider ${PANED_WIDTH + 200}px → ` +
      `pos=${grown.position} pane=${grown.width}px switch=${grown.enabled ? "on" : "OFF"} ` +
      `stored=${grown.stored} (not judged); then a drag to ${BACK_OUT_WIDTH}px → ` +
      `pos=${afterResize.position} pane=${afterResize.width}px ` +
      `switch=${afterResize.enabled ? "on" : "OFF"} (judged exactly); narrower 590px → ` +
      `pos=${shrunk.position} pane=${shrunk.width}px switch=${shrunk.enabled ? "on" : "OFF"} ` +
      `stored=${shrunk.stored}; narrower still 500px → pos=${deeper.position} ` +
      `pane=${deeper.width}px switch=${deeper.enabled ? "on" : "OFF"}`,
  )
  if (!grown.enabled || grown.stored !== storedBefore)
    fail("resize: a resize that clamped nothing was judged")
  if (grown.width <= BACK_OUT_WIDTH) fail("resize: the pane did not take any of the freed space")
  if (!afterResize.enabled) fail("resize: a drag after a resize was judged as closing the pane")
  if (afterResize.width !== BACK_OUT_WIDTH)
    fail(`resize: a drag after a resize took ${afterResize.width}px, not ${BACK_OUT_WIDTH}px`)
  // A resize that moves the position is judged by the same rule as a drag: what
  // is left is either the pane at or above its floor, or the pane closed —
  // never a sliver, and never a fold while the pane could still be shown.
  for (const r of [shrunk, deeper]) {
    if (r.enabled && r.width < PREVIEW_MIN_WIDTH)
      fail(`resize: the pane is ${r.width}px wide after a resize, under its floor`)
    if (!r.enabled && r.visible) fail("resize: the pane folded but is still on screen")
  }
  if (shrunk.stored !== storedBefore) fail("resize: the resize rewrote the stored width")

  // ── a window too narrow to give the pane its floor: the divider cannot hold
  //    what the window has no room for, so the drag closes the pane — and the
  //    fold is the window's doing, which must not become the stored setting ──
  seed(CRAMPED_WIDTH)
  const crampedSeed = `seed: pane=${pane.widget.get_width()}px pos=${paned.position} switch=${session.enabled() ? "on" : "OFF"}`
  paned.position = CRAMPED_WIDTH // the drag driven all the way to the far end
  allocate(CRAMPED_WIDTH)
  settleSpin()
  const cramped =
    `cramped window (${CRAMPED_WIDTH}px, list minimum ${LIST_MIN}px): ${crampedSeed}; ` +
    `drag: pos=${paned.position} pane=${pane.widget.get_width()}px ` +
    `switch=${session.enabled() ? "on" : "OFF"} stored=${previewSettings().width} ` +
    `next-window=${previewSettings().enabled ? "on" : "OFF"}`
  console.log(cramped)
  if (session.enabled()) fail("cramped window: the drag left the pane on")
  if (previewSettings().width !== SEED_WIDTH)
    fail("cramped window: a fold rewrote the stored width")
  if (!previewSettings().enabled) fail("cramped window: the fold became the stored switch")

  // ── the persistence side: only the floor bounds a STORED width ──
  const check = (name: string, ok: boolean): boolean => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`)
    if (!ok) fail(name)
    return ok
  }
  setPreviewWidth(SEED_WIDTH)
  check(
    `a stored ${PREVIEW_SNAP_SHUT_WIDTH}px (the snap width) is rejected, kept ${SEED_WIDTH}px`,
    setPreviewWidth(PREVIEW_SNAP_SHUT_WIDTH).width === SEED_WIDTH,
  )
  check(
    `a stored ${PREVIEW_MIN_WIDTH - 1}px (just under the floor) is rejected`,
    setPreviewWidth(PREVIEW_MIN_WIDTH - 1).width === SEED_WIDTH,
  )
  check(
    `a stored ${PREVIEW_MIN_WIDTH}px (the floor) is accepted`,
    setPreviewWidth(PREVIEW_MIN_WIDTH).width === PREVIEW_MIN_WIDTH,
  )
  setPreviewWidth(SEED_WIDTH)

  console.log(
    failures.length === 0
      ? "summary: drag contract holds"
      : `summary: ${failures.length} failure(s)`,
  )
  for (const f of failures) console.log(`  - ${f}`)

  detach()
  offSession()
  pane.dispose()
  if (failures.length > 0) throw new Error(`divider probe failed: ${failures.length} failure(s)`)
}

void main()
