/**
 * Main.tsx — the keyboard layer-shell surface + layout engine.
 *
 * ONE bottom-anchored full-width layer surface (namespace "keyboard-main",
 * layer TOP, exclusive zone — windows are pushed up, never overlapped).
 * keyboard-interactive FALSE (keymode NONE) is MANDATORY: a keyboard-grabbing
 * layer surface steals focus from the app being typed into (the wvkbd/
 * Hyprland focus-steal bug class, hyprwm/Hyprland#4512). With keymode NONE
 * the surface never takes keyboard focus, so the input backend (ydotool)
 *  keeps delivering to the focused app below.
 *
 * Keys are plain Gtk.Box widgets, each carrying its OWN gesture controller,
 * so TWO SIMULTANEOUS taps on two keys each fire press/release
 * independently (GTK4 gesture controllers are isolated per widget).
 *
 * Layout engine: JSON layouts (layouts/*.json) rendered row-by-row. Standard
 * rows centre; thumbs rows split at the centre palm-rest gap (a key with
 * action "gap", or auto-split by width half) with the left half flush-left,
 * the right flush-right, and a per-row staircase inset (THUMBS_BASE_MARGIN +
 * THUMBS_STAGGER — the angled-half look — no widget rotation, which would
 * rotate hitboxes too).
 *
 * State: shift (one-shot), caps (sticky), symbols (toggle), layout. Key
 * repeat is client-side (keys/repeat.ts) — NEVER a cancelable hold.
 *
 * Show/hide: window.visible. Fullscreen auto-hide (exclusive zones don't
 * cover fullscreen windows): a 1s poll while visible. Tablet auto-show/hide:
 * edge-triggered via tablet.ts — a manual dismissal is sticky until the next
 * tablet ON edge or a manual show.
 */

import GLib from "gi://GLib"
import { hyprctlJson } from "@common/hyprland/dispatch"
import { Astal, Gtk } from "ags/gtk4"
import {
  config,
  getShowMode as getShowModeCfg,
  set as setConfig,
  setShowMode as setShowModeCfg,
} from "./config"
import { sendKey, sendText } from "./keys/backend"
import { startRepeat, stopRepeat } from "./keys/repeat"
import { getLayout, type KeyDef, type LayoutDef, layoutNames, type RowDef } from "./layouts"
import { log } from "./log"
import { effectiveTablet, onTabletChange } from "./tablet"

export interface KeyboardControl {
  toggle(): void
  show(): void
  hide(): void
  status(): string
  setLayout(name: string): string
  nextLayout(): string
  /** Set the show policy (auto|show|hide) and apply it immediately. */
  setShowMode(mode: string): string
  getShowMode(): string
  /** Rebuild rows from live config (layout / keyScale). */
  rebuild(): void
  /** Refresh the cached monitor width from Hyprland and rebuild if it
   *  changed (used by the auto-rotate script to re-fit instantly on
   *  rotation — the width cache must be refreshed, not just rebuilt). */
  refreshMonitorWidth(): void
  /** Debug: describe the current widget tree (dev diagnostics). */
  debugTree(): string
}

const ROW_SPACING = 10
const DEFAULT_GAP_UNITS = 8

// Thumbs cascade (QWERTY stagger) + edge margin, in grid units. Each row is
// inset from the screen edge by BASE_MARGIN; the home row is notched an extra
// STAGGER inward (SwiftKey split reference). Mirrored for the two halves.
const THUMBS_BASE_MARGIN = 1.0
const THUMBS_STAGGER = [0, 0, 0.5, 0, 0]

let win: Astal.Window | null = null
let root: Gtk.Box | null = null

let visible = false
let monitorW = 0
let shift = false
let caps = false
let symbols = false
let emoji = false
let layoutName = "standard"

// Keys of the current build — for state-driven classes (shift/caps).
const keyWidgets: { btn: Gtk.Widget; action?: string }[] = []

/** The row set for the current layer (emoji > symbols > base rows). */
function activeRows(layout: LayoutDef): RowDef[] {
  return emoji
    ? (layout.emoji ?? layout.rows)
    : symbols
      ? (layout.symbols ?? layout.rows)
      : layout.rows
}

function unitPx(): number {
  const base = Math.round(52 * (config.keyScale ?? 1))
  // Auto-fit: the widest row (keys + thumbs gap + inter-key spacing) must fit
  // the monitor width minus the horizontal padding — otherwise wide layouts
  // (the thumbs bottom row) overflow the surface and get clipped at the edge.
  const layout = getLayout(layoutName)
  if (!layout) return base
  const rows = activeRows(layout)
  let maxUnits = 1
  let widestKeyCount = 0
  for (const row of rows) {
    const keys = row.keys.reduce((s, k) => s + (k.width ?? 1), 0)
    // The gap-marker key is replaced by the spacer (width = row.gap), so its
    // own width must NOT count toward the row's minimum width.
    const markerW = row.keys.reduce((s, k) => s + (k.action === "gap" ? (k.width ?? 0) : 0), 0)
    const units = keys - markerW + (row.gap ?? 0)
    if (units > maxUnits) {
      maxUnits = units
      widestKeyCount = row.keys.length
    }
  }
  // The thumbs edge margin + cascade insets widen the rows beyond their key
  // content — the widest row's total must fit too.
  if (layoutName === "thumbs" && rows.length > 1) {
    maxUnits += 2 * (THUMBS_BASE_MARGIN + Math.max(...THUMBS_STAGGER))
  }
  const mw = monitorWidth()
  if (mw > 0 && maxUnits > 1) {
    // Reserve horizontal room for the inter-key gaps (ROW_SPACING between
    // every key widget, INCLUDING the thumbs centre spacer).
    const gapTotal = Math.max(0, widestKeyCount - 1) * ROW_SPACING
    const fit = Math.floor((mw - 24 - gapTotal) / maxUnits)
    // Scale the screen-fill unit by keyScale so the keyboard can be made
    // smaller (or larger) than full width — the halves stay pinned to the
    // screen edges and the centre gutter absorbs the difference.
    if (fit > 0) return Math.max(Math.floor(fit * (config.keyScale ?? 1)), 24) // never smaller than ~24px keys
  }
  return base
}

/** Key height — phone-like keys are WIDER THAN TALL: a fraction of the
 *  (screen-fill) horizontal unit, clamped so the keyboard never gets absurdly
 *  tall on very wide monitors. */
function keyHeightPx(): number {
  const h = Math.round(unitPx() * 0.5)
  return Math.max(38, Math.min(h, 88))
}

/** The keyboard's monitor width (logical px) — the surface is anchored full
 *  width, so this is the widest the rows can ever be. Cached by
 *  refreshMonitorWidth(), which is TRANSFORM-AWARE: `hyprctl monitors` reports
 *  the monitor's NATIVE resolution regardless of the output transform, so the
 *  effective bottom-edge width is the HEIGHT when rotated 90/270deg. */
function monitorWidth(): number {
  return monitorW
}

/** Refresh the cached monitor width from Hyprland, transposing for rotation. */
async function refreshMonitorWidth(): Promise<void> {
  const mons = await hyprctlJson("monitors")
  if (!Array.isArray(mons) || mons.length === 0) return
  const m = mons[0]
  const t = typeof m.transform === "number" ? m.transform : 0
  const w = typeof m.width === "number" ? m.width : 0
  const h = typeof m.height === "number" ? m.height : 0
  const scale = typeof m.scale === "number" && m.scale > 0 ? m.scale : 1
  // hyprctl reports the monitor's NATIVE (unscaled) resolution + a separate
  // transform. The keyboard lays out in LOGICAL pixels, so divide by the
  // scale factor, and transpose (use height) when rotated 90/270deg.
  const effective = Math.round((t % 2 === 1 ? h : w) / scale)
  if (effective > 0 && effective !== monitorW) {
    monitorW = effective
    rebuild()
  }
}

// ── Keysym resolution (shift/caps apply locally; the backend sends the
//    shifted keysym directly — never a modifier hold, so nothing can stick) ──

function resolveKeysym(k: KeyDef): string | null {
  if (!k.keysym) return null
  const shifted = shift || caps
  if (shifted && k.shiftKeysym) return k.shiftKeysym
  if (shifted && /^[a-z]$/.test(k.keysym)) return k.keysym.toUpperCase()
  return k.keysym
}

const ACTION_KEYSYM: Record<string, string> = {
  space: "space",
  backspace: "BackSpace",
  enter: "Return",
  tab: "Tab",
}

function doAction(a: string): void {
  switch (a) {
    case "space":
      sendKey("space")
      break
    case "backspace":
      sendKey("BackSpace")
      break
    case "enter":
      sendKey("Return")
      break
    case "tab":
      sendKey("Tab")
      break
    case "caps":
      caps = !caps
      shift = false
      updateState()
      break
    case "shift":
      shift = !shift
      caps = false
      updateState()
      break
    case "symbols":
      symbols = !symbols
      emoji = false
      rebuild()
      break
    case "layout":
      nextLayout()
      break
    case "hide":
      hideKeyboard()
      break
    case "emoji":
      emoji = !emoji
      symbols = false
      rebuild()
      break
    case "letters":
      symbols = false
      emoji = false
      rebuild()
      break
    default:
      break
  }
}

function keyPressed(k: KeyDef): void {
  if (k.text) {
    sendText(k.text)
    return
  }
  if (k.action) {
    doAction(k.action)
    // Repeat-capable actions (backspace/space): start the hold-repeat.
    if (k.repeat && ACTION_KEYSYM[k.action]) startRepeat(ACTION_KEYSYM[k.action])
    return
  }
  const ks = resolveKeysym(k)
  if (!ks) return
  sendKey(ks)
  // SwiftKey "auto space": insert a space after sentence/clause punctuation.
  if (ks === "period" || ks === "comma" || ks === "question" || ks === "exclam") {
    sendKey("space")
  }
  // One-shot shift: consumed by the next letter/number/punct key.
  if (shift && !caps) {
    shift = false
    updateState()
  }
  if (k.repeat) startRepeat(ks)
}

// ── Widget building ──

function makeKey(k: KeyDef, fill = false): Gtk.Widget {
  // The spacebar is BLANK — never render a label for the space action.
  const label = k.action === "space" ? "" : (k.label ?? k.keysym ?? k.action ?? "")
  // Custom key widget: a plain Gtk.Box + a label + OUR GestureClick. NOT a
  // GtkButton — GTK4 buttons carry an internal click gesture that can claim
  // TOUCH sequences before our added gesture, so touch taps never reach the
  // pressed/released handlers (pointer still worked; touch didn't — exactly
  // the laptop-vs-tablet symptom). A plain widget + one gesture = it is the
  // only handler for both pointer and touch.
  const btn = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    halign: Gtk.Align.FILL,
    valign: Gtk.Align.FILL,
  })
  btn.add_css_class("keycap")
  if (k.action) btn.add_css_class("action")
  btn.set_size_request(Math.round((k.width ?? 1) * unitPx()), keyHeightPx())
  // In a FILL row (the standard layout) the key absorbs its share of the row's
  // leftover width so every row spans the full screen. Thumbs halves keep their
  // content width (the centre spacer absorbs the leftover) — fill=false there.
  if (fill) btn.set_hexpand(true)
  // TRUE centring: the label fills the key (hexpand/vexpand) and the text is
  // positioned by xalign/yalign (0.5 = dead centre). A natural-size label
  // sits top-shifted inside the split keys; expanding it makes the glyph
  // dead-centre both axes. Modifiers override halign to hug their edge, with
  // xalign 0/1 and a margin for breathing room.
  const lbl = new Gtk.Label({
    label,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    hexpand: true,
    vexpand: true,
  })
  const align = k.align ?? "center"
  if (align === "left") {
    lbl.set_halign(Gtk.Align.START)
    lbl.set_margin_start(18)
    lbl.set_xalign(0)
  } else if (align === "right") {
    lbl.set_halign(Gtk.Align.END)
    lbl.set_margin_end(18)
    lbl.set_xalign(1)
  }
  btn.append(lbl)
  // Per-key gesture. Keys WITHOUT swipeKeysym: a GtkGestureClick (GTK4:
  // GtkButton has NO pressed/released signals — those live in the gesture).
  // One controller per key ⇒ two SIMULTANEOUS taps on two keys each fire
  // press/release independently (GTK4 gesture controllers are isolated per
  // widget). Keys WITH swipeKeysym (quick punctuation): a single GtkGestureDrag
  // drives both tap and swipe — a co-located GestureClick rejects sibling drag
  // gestures on this gjs build.
  if (k.swipeKeysym) {
    let swiped = false
    const drag = new Gtk.GestureDrag()
    drag.connect("drag-begin", () => {
      swiped = false
      btn.add_css_class("pressed")
    })
    drag.connect("drag-update", (_g: any, offsetX: number, _offsetY: number) => {
      if (!swiped && Math.abs(offsetX) > 30) {
        swiped = true
        sendKey(k.swipeKeysym!)
      }
    })
    drag.connect("drag-end", () => {
      btn.remove_css_class("pressed")
      if (!swiped) keyPressed(k)
    })
    btn.add_controller(drag)
  } else {
    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => {
      log(`key pressed: ${k.label ?? k.keysym ?? k.action ?? "?"}`)
      btn.add_css_class("pressed")
      keyPressed(k)
    })
    gesture.connect("released", () => {
      btn.remove_css_class("pressed")
      stopRepeat()
    })
    btn.add_controller(gesture)
  }
  keyWidgets.push({ btn, action: k.action })
  return btn
}

function updateState(): void {
  for (const w of keyWidgets) {
    if (w.action === "shift" || w.action === "caps") {
      const on = w.action === "shift" ? shift : caps
      if (on) w.btn.add_css_class("shift-active")
      else w.btn.remove_css_class("shift-active")
    }
  }
}

function buildRow(row: RowDef, rowIdx: number, isThumbs: boolean): Gtk.Widget {
  const unit = unitPx()

  // Split the row at the explicit gap marker, or auto-split by width half.
  const marker = row.keys.findIndex((k) => k.action === "gap")
  let left: KeyDef[]
  let right: KeyDef[]
  if (marker >= 0) {
    left = row.keys.slice(0, marker)
    right = row.keys.slice(marker + 1)
  } else if (isThumbs && (row.gap ?? 0) > 0) {
    const total = row.keys.reduce((s, k) => s + (k.width ?? 1), 0)
    let acc = 0
    let split = 0
    for (let i = 0; i < row.keys.length; i++) {
      acc += row.keys[i].width ?? 1
      if (acc >= total / 2) {
        split = i + 1
        break
      }
    }
    left = row.keys.slice(0, split)
    right = row.keys.slice(split)
  } else {
    left = row.keys
    right = []
  }

  const rowBox = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: ROW_SPACING,
    halign: Gtk.Align.FILL,
  })

  if (!isThumbs || right.length === 0) {
    // Standard (or an un-split thumbs row): one full-width group whose keys
    // expand so the row spans the entire screen width.
    const group = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: ROW_SPACING,
      halign: Gtk.Align.FILL,
      hexpand: true,
    })
    for (const k of left) group.append(makeKey(k, true))
    rowBox.append(group)
    return rowBox
  }

  // Thumbs: left half flush-left, right half flush-right, gap between.
  const gapW = Math.round((row.gap ?? DEFAULT_GAP_UNITS) * unit)
  const leftGroup = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: ROW_SPACING,
    halign: Gtk.Align.START,
  })
  const rightGroup = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: ROW_SPACING,
    halign: Gtk.Align.END,
  })
  // Cascade (QWERTY stagger) + edge margin — each row inset from the screen
  // edge; the home row notched an extra half-key inward. Mirrored on both
  // halves (left inset on the left half, right inset on the right half).
  const inset = THUMBS_BASE_MARGIN + (THUMBS_STAGGER[rowIdx] ?? 0)
  leftGroup.set_margin_start(inset * unit)
  rightGroup.set_margin_end(inset * unit)
  for (const k of left) leftGroup.append(makeKey(k))
  for (const k of right) rightGroup.append(makeKey(k))
  const spacer = new Gtk.Box({ hexpand: true, halign: Gtk.Align.FILL, valign: Gtk.Align.FILL })
  spacer.set_size_request(gapW, 1)
  // Empty centre = space (SwiftKey parity: no spacebar, tap the gutter).
  // FILL valign so the whole centre-column height is the tap target.
  const spaceTap = new Gtk.GestureClick()
  spaceTap.connect("released", () => sendKey("space"))
  spacer.add_controller(spaceTap)
  rowBox.append(leftGroup)
  rowBox.append(spacer)
  rowBox.append(rightGroup)
  return rowBox
}

function rebuild(): void {
  if (!root) return
  const name = config.layout === "thumbs" ? "thumbs" : "standard"
  layoutName = name
  keyWidgets.length = 0
  let child = root.get_first_child()
  while (child) {
    root.remove(child)
    child = root.get_first_child()
  }
  const layout = getLayout(name)
  if (!layout) {
    log(`layout not found: ${name}`)
    return
  }
  const rows = activeRows(layout)
  const isThumbs = name === "thumbs"
  rows.forEach((r, i) => {
    root!.append(buildRow(r, i, isThumbs))
  })
  updateState()
  // Force the layer surface to re-commit at the content's natural size. The
  // keyboard content height changes when rows differ (standard vs thumbs) or
  // when toggling symbols, but the Astal layer surface caches its size and the
  // child keeps its stale allocation — leaving a dead band (the root is
  // bottom-aligned) when the content shrinks. An explicit default size keeps
  // the FULL anchor width (left+right) while letting the height follow the
  // row stack: rows * keyHeightPx() + inter-row ROW_SPACING. Passing a 0
  // width leaves the width anchor-driven (full screen); a real monitor width
  // pins it. Then queue a resize so the surface re-commits.
  if (win) {
    const w = monitorWidth()
    const h = rows.length * keyHeightPx() + (rows.length - 1) * ROW_SPACING
    ;(win as any).set_default_size?.(w, h)
    win.queue_resize()
  }
}

// ── Show / hide ──

/** Monitor-rotation poll — armed only while the keyboard is visible. Rotation
 *  changes while hidden are picked up by the refresh at the next show. */
let monitorPoll: number | null = null

function startMonitorPoll(): void {
  if (monitorPoll !== null) return
  monitorPoll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
    void refreshMonitorWidth()
    return GLib.SOURCE_CONTINUE
  })
}

function stopMonitorPoll(): void {
  if (monitorPoll !== null) {
    GLib.source_remove(monitorPoll)
    monitorPoll = null
  }
}

function showKeyboard(): void {
  if (visible) return
  visible = true
  if (win) win.visible = true
  void refreshMonitorWidth()
  startMonitorPoll()
  armFullscreenCheck()
}

function hideKeyboard(): void {
  stopRepeat()
  stopMonitorPoll()
  if (!visible) return
  visible = false
  if (win) win.visible = false
  disarmFullscreenCheck()
}

function toggle(): void {
  if (visible) hideKeyboard()
  else showKeyboard()
}

// ── Fullscreen auto-hide (exclusive zones don't cover fullscreen windows) ──

let fsTimer: number | null = null

function armFullscreenCheck(): void {
  if (fsTimer !== null) return
  fsTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    if (!visible) {
      fsTimer = null
      return GLib.SOURCE_REMOVE
    }
    void hyprctlJson("activewindow").then((aw) => {
      if (aw && aw.fullscreen && visible) {
        log("fullscreen window focused — hiding keyboard")
        hideKeyboard()
      }
    })
    return GLib.SOURCE_CONTINUE
  })
}

function disarmFullscreenCheck(): void {
  if (fsTimer !== null) {
    GLib.source_remove(fsTimer)
    fsTimer = null
  }
}

// ── Auto-show focus gate (auto mode: tablet + a text-entry app focused) ──

let textFocused = false
let fullscreenNow = false
let autoTimer: number | null = null

/** Live keyboard.autoTextApps list (class names, lowercased on compare). */
function autoTextApps(): string[] {
  const apps = (config as any).autoTextApps
  return Array.isArray(apps) ? (apps as string[]) : []
}

/** Poll hyprctl activewindow; cache the focused window's text-app + fullscreen state. */
async function refreshTextFocus(): Promise<boolean> {
  const aw = await hyprctlJson("activewindow")
  fullscreenNow = aw?.fullscreen === true
  const cls = typeof aw?.class === "string" ? aw.class.trim().toLowerCase() : ""
  const apps = autoTextApps().map((a) => a.trim().toLowerCase())
  textFocused = cls !== "" && apps.includes(cls)
  return textFocused && !fullscreenNow
}

/** Cached gate: focused window is a text app AND not fullscreen. */
function textAppFocused(): boolean {
  return textFocused && !fullscreenNow
}

/** Auto-mode focus poll (runs while showMode=auto AND tablet on; self-stops). */
function armAutoShowCheck(): void {
  if (autoTimer !== null) return
  autoTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    const m = getShowModeCfg()
    if (m !== "auto" || !effectiveTablet()) {
      autoTimer = null
      return GLib.SOURCE_REMOVE
    }
    void refreshTextFocus().then(() => {
      if (textAppFocused()) showKeyboard()
      else hideKeyboard()
    })
    return GLib.SOURCE_CONTINUE
  })
}

function disarmAutoShowCheck(): void {
  if (autoTimer !== null) {
    GLib.source_remove(autoTimer)
    autoTimer = null
  }
}

// ── Control surface (drives the request handlers) ──

function setLayout(name: string): string {
  if (!layoutNames().includes(name)) {
    return `error: unknown layout '${name}' (${layoutNames().join("|")})`
  }
  setConfig("layout", name)
  rebuild()
  return `layout=${name}`
}

function nextLayout(): string {
  const names = layoutNames()
  const i = names.indexOf(layoutName)
  const next = names[(i + 1) % names.length]
  setConfig("layout", next)
  rebuild()
  return `layout=${next}`
}

// ── Show policy (auto | show | hide) ──
// keyboard.showMode (live config): auto = tablet-driven, show = always show,
// hide = never show. The control-surface setters are what the dock applet's
// Hide/Show/Auto steps drive (via the command trie).

function setShowMode(mode: string): string {
  if (mode !== "auto" && mode !== "show" && mode !== "hide") {
    return `error: unknown showMode '${mode}' (auto|show|hide)`
  }
  setShowModeCfg(mode)
  // Apply the policy immediately (the tablet edge callback keeps it synced).
  applyShowMode()
  return `showMode=${mode}`
}

function getShowMode(): string {
  return getShowModeCfg()
}

function applyShowMode(): void {
  // showKeyboard/hideKeyboard guard on visibility internally.
  const m = getShowModeCfg()
  if (m === "show") {
    disarmAutoShowCheck()
    showKeyboard()
  } else if (m === "hide") {
    disarmAutoShowCheck()
    hideKeyboard()
  } else {
    // auto: tablet on AND a text app focused (the poll keeps it synced).
    if (effectiveTablet() && textAppFocused()) showKeyboard()
    else hideKeyboard()
    armAutoShowCheck()
  }
}

function status(): string {
  return `layout=${layoutName} showMode=${getShowModeCfg()} visible=${visible} shift=${shift} caps=${caps} symbols=${symbols}`
}

/** Debug: walk the root box and describe rows/buttons (dev diagnostics). */
function debugTree(): string {
  if (!root) return "root=null"
  const parts: string[] = [
    `root children=${childCount(root)}`,
    `root parent=${root.get_parent() ? "yes" : "NONE"}`,
    `root visible=${root.get_visible ? root.get_visible() : "?"}`,
    `root alloc=${alloc(root)}`,
    `win=${win ? "set" : "null"} win.child=${win && (win as any).child ? "set" : "NONE"} win.alloc=${win ? alloc(win as any) : "-"} win.mapped=${win ? win.get_mapped?.() : "-"} win.visible=${win ? (win as any).visible : "-"}`,
  ]
  let child = root.get_first_child()
  let rowIdx = 0
  while (child) {
    const rowInfo: string[] = []
    let sub = (child as any).get_first_child?.()
    while (sub) {
      const btnInfo: string[] = []
      let btn = (sub as any).get_first_child?.()
      while (btn) {
        btnInfo.push(`b(${cssClasses(btn)} ${(btn as any).label ?? ""})`)
        btn = (btn as any).get_next_sibling?.()
      }
      rowInfo.push(`g(${cssClasses(sub)})[${btnInfo.length}]`)
      sub = (sub as any).get_next_sibling?.()
    }
    parts.push(`row${rowIdx} ${cssClasses(child)}[${rowInfo.join(" | ")}]`)
    child = child.get_next_sibling()
    rowIdx++
  }
  return parts.join(" | ")
}

function alloc(w: any): string {
  try {
    const a = w.get_allocation()
    return a ? `${a.width}x${a.height}@${a.x},${a.y}` : "none"
  } catch {
    return "err"
  }
}

function childCount(w: Gtk.Widget): number {
  let n = 0
  let c = (w as any).get_first_child ? (w as any).get_first_child() : null
  while (c) {
    n++
    c = (c as any).get_next_sibling()
  }
  return n
}

function cssClasses(w: Gtk.Widget): string {
  const c = (w as any).get_css_classes?.()
  return c ? c.join(",") : "?"
}

// ── Tablet auto-show/hide (edge-triggered) ──
// The show policy gates the tablet edges: auto follows tablet state, show
// always shows, hide never shows. A manual ✕ hide key is a plain dismissal
// (the policy re-asserts on the next tablet edge / Show step).

function wireTablet(): void {
  onTabletChange((t) => {
    // Tablet-OFF EDGE: hide UNCONDITIONALLY — regardless of showMode (even
    // "show") or applet state. Folding the device closed always drops the
    // surface, so no stuck/orphan keyboard survives a physical tablet-off.
    if (!t) {
      disarmAutoShowCheck()
      hideKeyboard()
      return
    }
    // Tablet-ON edge: follow showMode. auto & show reveal the keyboard;
    // "hide" never does (a tablet-on edge must not override an explicit
    // "hide" — it can only be overridden by re-showing via the applet).
    const m = getShowModeCfg()
    if (m === "hide") {
      hideKeyboard()
      return
    }
    if (m === "show") {
      showKeyboard()
      return
    }
    // auto: show only when the focused window is a text app; the auto poll
    // then keeps the show/hide decision synced to focus changes.
    void refreshTextFocus().then(() => {
      if (textAppFocused()) showKeyboard()
      else hideKeyboard()
      armAutoShowCheck()
    })
  })
}

export default function Main(): Astal.Window {
  const w = (
    <window
      namespace="keyboard-main"
      name="keyboard-main"
      class="keyboard-main"
      layer={Astal.Layer.TOP}
      keymode={Astal.Keymode.NONE}
      exclusivity={Astal.Exclusivity.EXCLUSIVE}
      anchor={Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT | Astal.WindowAnchor.BOTTOM}
      visible={false}
      $={(self) => {
        win = self
        // Imperative child (dock AppletWindow pattern — JSX-nested children
        // did not present content on this TINSHELL build).
        root = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: ROW_SPACING,
          vexpand: false,
          halign: Gtk.Align.FILL,
          valign: Gtk.Align.END,
        })
        root.add_css_class("keyboard-root")
        ;(self as any).set_child(root)
        // Translucent presentation: clear the opaque region so the compositor
        // blends/blurs the panel instead of treating it as opaque (launcher/
        // dock/notifications pattern).
        self.connect("realize", () => {
          self.get_surface?.()?.set_opaque_region?.(null)
        })
      }}
    />
  ) as Astal.Window

  void refreshMonitorWidth()
  wireTablet()

  // Monitor-rotation refresh runs ONLY while the keyboard is visible
  // (showKeyboard arms it, hideKeyboard disarms it) — a permanent hyprctl
  // spawn poll on a hidden surface is main-loop churn for nothing.

  // Attach the control surface to the window (launcher pattern — the request
  // handlers address the window object itself).
  Object.assign(w, {
    toggle,
    show: showKeyboard,
    hide: hideKeyboard,
    status,
    setLayout,
    nextLayout,
    setShowMode,
    getShowMode,
    rebuild,
    refreshMonitorWidth,
    debugTree,
  })
  return w
}
