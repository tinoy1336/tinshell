/**
 * common/menus/menu-framework.tsx — shared centred-menu shell for the wifi,
 * bluetooth, and screengrab-settings GUIs.
 *
 * A single layer-shell window per open menu, centred on the monitor of the
 * applet that spawned it (anchor NONE → gtk-layer-shell centres the surface),
 * namespace/class `dock-menu` so Hyprland's blur + ignorealpha layer rules treat
 * it as the same frosted material as the dock.
 *
 * Visual language (per the spec): the panel is a rounded translucent rectangle
 * mimicking the icon disc — Cairo-painted from `appearance.menu` (bg rgb/alpha
 * default to the disc values, corner radius = the pill's). All colours and font
 * sizes are config-driven: row text/status use Pango attributes built from
 * config (attr_size_new_absolute = pixel-exact sizes, matching the dock's Cairo
 * pixel sizing), row highlights are Cairo fills, and glyphs are Nerd Font
 * strings from `appearance.icons`. The only CSS in the whole feature is the
 * window transparency rule + the password entry's caret/selection (GtkEntry
 * doesn't expose those via Pango attributes).
 *
 * Lifecycle: openMenu() runs inside a gnim createRoot scope so the wifi/bt
 * menus' poll timers (registered via onCleanup in onMount) are torn down when
 * the menu closes. Close = fade-out (window opacity, same eased tick pattern as
 * the pill animations) → destroy window → dispose scope. Single-open enforced:
 * opening a menu closes whichever menu (wifi or bt) is already open; the old
 * menu's fade-out completion only clears the hub if it is still the active one.
 *
 * Keyboard: keymode NONE while no menu is open, ON_DEMAND while one is. A
 * layer surface whose keyboard interactivity is not NONE takes the seat's
 * keyboard focus the moment it maps and again on every pointer motion over
 * it, so a standing ON_DEMAND on this pre-created, permanently-mapped shell
 * stole the user's keys at every dock spawn, restart and rebuild. The open
 * menu is the one state that needs them: Escape closes it and the password
 * entry receives typing.
 */

import cairo from "gi://cairo"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { easeCubicInOut } from "@common/anim/easings"
import { type FrameRunner, runFrames } from "@common/anim/run-frames"
import type { AppletConfig } from "@common/applets/config"
import { hoverGlyph as sharedHoverGlyph } from "@common/glyph/hover-glyph"
import { ignore } from "@common/log/logger"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { createRoot } from "gnim"

// ── Geometry + colours (read live from config each use) ──

const MENU = (config: AppletConfig) => config.appearance.menu
/** The menu shell's BAKED window width: max(width, maxWidth). The shell is
 *  created once at this size and NEVER resized (a resize at open time makes
 *  the compositor re-evaluate the pointer and eat the next dock click); each
 *  menu paints its panel rect at whatever width its content needs (floor
 *  width, cap maxWidth), centred inside the window. */
const SHELL_W = (config: AppletConfig) =>
  Math.max(MENU(config).width, MENU(config).maxWidth ?? MENU(config).width)
/** Panel inner padding — HARDCODED (the user: no padding values in config). */
const MENU_PAD = 8
/** Row content left inset. */
export const ROW_L = 14
/** Row content RIGHT inset — the user's "more padding on the right"; every
 *  row type (menuRow/menuEntryRow/menuInfoRow/menuSpinnerRow) shares it. */
export const ROW_R = 18
/** The action-glyph (trash) box: fits exactly on the right cap so its CENTER
 *  is the cap (a 40px box overflows the 12px cap inset — its margin clamps and
 *  the emoji lands 8px off-column, the "trash misaligned with the emojis
 *  below" bug). 2·(2 + capRadius) = 24. */
const ACTION_BOX = 24
const ROW_H = (config: AppletConfig) => MENU(config).rowHeight
const MAX_ROWS = (config: AppletConfig) => MENU(config).maxRows

/** Height of the scrollable list region: capped at MAX_ROWS visible rows. */
const listHeightFor = (rows: number, config: AppletConfig) =>
  Math.min(rows, MAX_ROWS(config)) * ROW_H(config)

type CfgColour = { rgb: number[]; alpha: number }
type MenuColour = "text" | "mutedText" | "accent" | "danger"

function colourOf(k: MenuColour, config: AppletConfig): CfgColour {
  return MENU(config)[k]
}

/** Run `fn` once after `ms` ms — a one-shot GLib timeout. */
export function later(ms: number, fn: () => void): void {
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    fn()
    return GLib.SOURCE_REMOVE
  })
}

/** Failsafe for a row's busy latch while a backend action runs (nmcli, BlueZ):
 *  `arm()` starts a timer that runs `onTimeout` — clear the latch and re-render
 *  — unless `disarm()` wins first. A hung call would otherwise hold the latch's
 *  own `if (busy) return` guard forever and swallow every later attempt.
 *  Re-arming replaces the pending timer, so one latch holds at most one source;
 *  the state lives in this closure (a menu can open more than once per process). */
export function createBusyWatchdog(
  ms: number,
  onTimeout: () => void,
): {
  arm(): void
  disarm(): void
} {
  let source: number | null = null
  const disarm = (): void => {
    if (source !== null) {
      GLib.source_remove(source)
      source = null
    }
  }
  return {
    arm(): void {
      disarm()
      source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        source = null
        onTimeout()
        return GLib.SOURCE_REMOVE
      })
    },
    disarm,
  }
}

// ── Cairo helpers ──

export function roundedRect(cr: any, x: number, y: number, w: number, h: number, r: number): void {
  if (r <= 0) {
    cr.rectangle(x, y, w, h)
    return
  }
  const rr = Math.min(r, w / 2, h / 2)
  cr.newPath()
  cr.arc(x + rr, y + rr, rr, Math.PI, 1.5 * Math.PI)
  cr.arc(x + w - rr, y + rr, rr, 1.5 * Math.PI, 2 * Math.PI)
  cr.arc(x + w - rr, y + h - rr, rr, 0, 0.5 * Math.PI)
  cr.arc(x + rr, y + h - rr, rr, 0.5 * Math.PI, Math.PI)
  cr.closePath()
}

// ── Text (Pango labels, pixel-exact sizes from config) ──

/** Pango attribute list for a config colour + pixel size — shared by the
 *  menu labels and the screengrab menu's inline-entry rows. */
export function pangoAttrs(colour: CfgColour, sizePx: number): Pango.AttrList {
  const attrs = new Pango.AttrList()
  attrs.insert(
    Pango.attr_foreground_new(
      Math.round(colour.rgb[0] * 65535),
      Math.round(colour.rgb[1] * 65535),
      Math.round(colour.rgb[2] * 65535),
    ),
  )
  attrs.insert(Pango.attr_foreground_alpha_new(Math.round(colour.alpha * 65535)))
  attrs.insert(Pango.attr_size_new_absolute(Math.round(sizePx * Pango.SCALE)))
  return attrs
}

function pangoLabel(text: string, sizePx: number, colour: CfgColour, ellipsize = false): Gtk.Label {
  const label = new Gtk.Label({ label: text })
  label.set_halign(Gtk.Align.START)
  label.set_valign(Gtk.Align.CENTER)
  label.set_single_line_mode(true)
  if (ellipsize) label.set_ellipsize(Pango.EllipsizeMode.END)
  label.set_attributes(pangoAttrs(colour, sizePx))
  return label
}

// ── Row building blocks ──

interface MenuRowOpts {
  /** Nerd Font glyph at the row's start (config icon key resolved by caller). */
  emoji?: string
  /** A WIDGET at the row's start instead of the `emoji` glyph (e.g. the white
   *  connecting spinner) — takes the leading slot. */
  emojiWidget?: Gtk.Widget
  text: string
  /** Right-aligned secondary text (e.g. "Connected", "On"). */
  status?: string
  statusColour?: MenuColour // default "mutedText"
  /** A WIDGET status (e.g. the spinning 🔄 while connecting) — takes the
   *  status slot instead of `status`. */
  statusWidget?: Gtk.Widget
  /** Persistent highlight (e.g. the network currently connected to). */
  active?: boolean
  /** Dim the whole row. */
  muted?: boolean
  onClick?: () => void
  /** A small clickable glyph button at the row's end (e.g. bluetooth forget). */
  action?: { emoji: string; onClick: () => void; colour?: MenuColour }
  /** The host's live config view (menu palette + font family). */
  config: AppletConfig
}

/** The shared hover-glyph primitive — the trash's "light up" standardized
 *  across every menu emoji. Implementation lives in
 *  common/glyph/hover-glyph; this adapter feeds it the dock's
 *  config palette (rest = call-site colour, hover brighten = menu text colour
 *  at full alpha, glow = menu accent at appearance.menu.glowAlpha). Returns
 *  the DrawingArea and a setHover() setter so rows can drive glyph hover
 *  from the row's own motion controller; pass ownHover for standalone
 *  interactive glyphs (action buttons, the eyeball, the capture-overlay
 *  buttons). */
export function hoverGlyph(opts: {
  /** Nerd Font glyph, or a live-resolving getter (the eyeball swaps glyphs). */
  emoji: string | (() => string)
  /** Square drawing-area size. The glow halo radius = box/2, so it scales
   *  with the element: 15px row glyphs → 7.5px halo, 24px trash → 12px,
   *  32px overlay button → 16px. */
  box: number
  /** Glyph font size. */
  fontSize: number
  /** Colour at rest (a config colour). */
  rest: CfgColour
  /** Attach the glyph's own motion controller (hover = the glyph itself).
   *  Off for row glyphs, whose hover is driven by the row via setHover. */
  ownHover?: boolean
  /** Non-interactive: always draws `rest` at its alpha — no hover brighten,
   *  no glow. Rows without an action use flat emojis (the user's "same colour
   *  as the text at all times" rule). */
  flat?: boolean
  onClick?: () => void
  /** The host's live config view (menu palette + font family). */
  config: AppletConfig
}): { widget: Gtk.DrawingArea; setHover(v: boolean): void } {
  const config = opts.config
  const text = MENU(config).text
  const accent = MENU(config).accent
  return sharedHoverGlyph({
    emoji: opts.emoji,
    box: opts.box,
    fontSize: opts.fontSize,
    rest: [opts.rest.rgb[0], opts.rest.rgb[1], opts.rest.rgb[2], Math.min(1, opts.rest.alpha)],
    fontFamily: config.fonts.family,
    hover: {
      colour: [text.rgb[0], text.rgb[1], text.rgb[2], 1],
      glow: [accent.rgb[0], accent.rgb[1], accent.rgb[2], 1],
      glowAlpha: MENU(config).glowAlpha ?? 0.22,
    },
    ownHover: opts.ownHover,
    flat: opts.flat,
    onClick: opts.onClick,
  })
}

function actionGlyph(
  a: { emoji: string; onClick: () => void; colour?: MenuColour },
  config: AppletConfig,
): Gtk.Widget {
  // The trash "lights up" on hover: brighten to the text colour + the accent
  // radial glow, via the shared hoverGlyph. ownHover = the glyph is its own
  // control inside the row; the row's click handler bails over its box.
  return hoverGlyph({
    config,
    emoji: a.emoji,
    box: ACTION_BOX,
    fontSize: MENU(config).emojiSize,
    rest: a.colour ? colourOf(a.colour, config) : MENU(config).mutedText,
    ownHover: true,
    onClick: a.onClick,
  }).widget
}

/** margin_end (box coords) that centres a label's glyph INK on the RIGHT cap.
 *  The cap circle centre is 2+capRadius = 12px from the row's right edge, so
 *  this is a width-independent constant — call with (label, 0, 12). Small
 *  margins only: a huge margin_start/end breaks GtkBox sequential layout (the
 *  child gets pushed off-box instead of positioned). */
function inkMarginEnd(label: Gtk.Label, targetBoxX: number, boxWidth: number): number {
  label.set_xalign(0)
  const [ink] = label.get_layout().get_extents()
  if (!ink) return 0 // no layout yet (measure before allocation)
  const inkX = ink.x / Pango.SCALE
  const inkW = ink.width / Pango.SCALE
  const [, natW] = label.measure(Gtk.Orientation.HORIZONTAL, -1)
  return Math.max(0, Math.round(boxWidth - targetBoxX - natW + inkX + inkW / 2))
}

/** One menu row: builds at its NATURAL width (the widest row drives the panel
 *  width — see panelWidthFor), then stretches to the panel's content width via
 *  hexpand. The leading emoji is centred on the left cap and the trailing
 *  status emoji / action glyph on the right cap — both read as part of the
 *  pill. Every emoji uses the shared hoverGlyph: on hover it brightens to the
 *  menu text colour with the accent radial glow behind it (standardized across
 *  all menu glyphs). */
export function menuRow(opts: MenuRowOpts): Gtk.Widget {
  const config = opts.config
  const rowH = ROW_H(config)
  // Rounded-rect row highlight (radius 10), NOT a full capsule: the old
  // ROW_H/2 end caps framed the leading/trailing emojis in semicircles — the
  // user's "circle around the selected emoji". The emoji centring below
  // tracks this radius (2 + capRadius).
  const capRadius = Math.min(10, rowH / 2)
  let hover = false
  /** Row-driven glyph hovers (leading emoji / status glyph) —
   *  set together from the row's motion controller. The action glyph tracks
   *  its own hover (it is a separate control inside the row). */
  const rowGlyphs: ((v: boolean) => void)[] = []

  const highlight = new Gtk.DrawingArea()
  highlight.set_size_request(1, rowH) // no width: the row measures its CONTENT natural
  /** The action (trash) widget — hoisted so the row's click handler can bail
   *  over its live on-screen position (see the GestureClick below). */
  let actionWidget: Gtk.Widget | null = null
  highlight.set_draw_func((_d: any, cr: any, w: number, h: number) => {
    const on = hover || !!opts.active
    if (!on) return
    const c = opts.active ? MENU(config).rowActive : MENU(config).rowHighlight
    cr.setSourceRGBA(c.rgb[0], c.rgb[1], c.rgb[2], c.alpha)
    // Inset 2px so highlights never run flush against the panel edge.
    roundedRect(cr, 2, 2, w - 4, h - 4, capRadius)
    cr.fill()
  })

  const textColour = opts.muted ? MENU(config).mutedText : MENU(config).text
  const emojiColour = opts.muted ? MENU(config).mutedText : MENU(config).text
  // ALL emojis are flat except the ACTION glyph: leading + status emojis draw
  // at the row's text colour at all times — no hover brighten, no glow (the
  // user's flat-emoji rule, baked in fully: the locks on saved networks, the
  // connected check, the signal glyphs). Only the trash (a control) glows.
  // Shared row geometry: left + right insets (the right cap anchors inside
  // the right inset — small computed margin_ends position the trailing
  // elements, never a huge padding).
  const content = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    halign: Gtk.Align.FILL,
    valign: Gtk.Align.CENTER,
  })
  content.set_margin_start(ROW_L)
  content.set_margin_end(ROW_R)
  if (opts.emojiWidget) {
    // A widget leading emoji (the connecting spinner) — same 14px air after
    // it as the glyph leading.
    opts.emojiWidget.set_margin_end(14)
    content.append(opts.emojiWidget)
  } else if (opts.emoji) {
    // Leading emoji — Cairo glyph with the shared glow, row-driven hover.
    // Margin 0 (no cap-centring margin needed: the box's centre lands where
    // the old clamped ink-margin placed the glyph).
    const e = hoverGlyph({
      config,
      emoji: opts.emoji,
      box: MENU(config).emojiSize,
      fontSize: MENU(config).emojiSize,
      rest: emojiColour,
      flat: true,
    })
    e.widget.set_margin_end(14) // air between the leading emoji and the text
    content.append(e.widget)
    rowGlyphs.push(e.setHover)
  }
  // halign FILL is REQUIRED for hexpand to work in GtkBox (START pins the
  // label to its natural width — long text would collide with the status).
  // xalign 0 is REQUIRED too: GtkLabel defaults to 0.5, which centres short
  // text inside the filling label (the "centred weirdly" bug).
  const text = pangoLabel(opts.text, MENU(config).fontSize, textColour, true)
  text.set_hexpand(true)
  text.set_halign(Gtk.Align.FILL)
  text.set_xalign(0)
  content.append(text)

  // ── Right side, anchored to the right cap. The hexpand text pushes the
  //  trailing elements to the box's right edge. The cap circle centre is
  //  2+capRadius = 12px from the row's right edge, and every trailing margin
  //  below is a WIDTH-INDEPENDENT constant (the old CONTENT_W-based boxW /
  //  rightCapCentre terms cancel in each formula), so the elements hug the
  //  right cap at any panel width. The action glyph owns the cap when
  //  present; the status then right-aligns just left of it. ──
  const STATUS_BOX = MENU(config).emojiSize // status glyph box (glow halo radius = box/2)
  const status = opts.status ?? null
  // Nerd Font glyphs live in the PUA (>= 0xE000) — that's how we tell a glyph
  // status (lock, check → Cairo + glow) from a text status ("On"/"Off"/
  // "Connecting…" → Pango label, no glow: it's text). codePointAt handles
  // glyphs above U+FFFF (lock 󰌾, check 󰄬 are surrogate pairs — charCodeAt
  // returns the high surrogate, well below 0xE000, which silently demoted
  // them to labels whose ink overflows the advance box and broke the
  // right-side column alignment with the trash).
  const statusIsGlyph =
    status !== null && status.length > 0 && (status.codePointAt(0) ?? 0) >= 0xe000
  if (opts.action) {
    const g = actionGlyph(opts.action, config)
    actionWidget = g
    // The action (forget/trash) sits NEXT TO THE TEXT; the status (lock/check)
    // right-aligns at the far end — the user's forget/secure swap.
    if (status) {
      g.set_margin_start(10) // gap from the text
      g.set_margin_end(8) // gap to the status
      content.append(g)
      if (statusIsGlyph) {
        const s = hoverGlyph({
          config,
          emoji: status,
          box: STATUS_BOX,
          fontSize: MENU(config).emojiSize,
          rest: textColour,
          flat: true,
        })
        // Cap anchor — the same column as the standalone statuses (no action).
        s.widget.set_margin_end(Math.max(0, Math.round(12 - STATUS_BOX / 2)))
        content.append(s.widget)
        rowGlyphs.push(s.setHover)
      } else {
        const statusLabel = pangoLabel(
          status,
          MENU(config).fontSize,
          colourOf(opts.statusColour ?? "mutedText", config),
          true,
        )
        statusLabel.set_margin_end(inkMarginEnd(statusLabel, 0, 12)) // cap anchor
        content.append(statusLabel)
      }
    } else {
      g.set_margin_end(0) // flush at the cap when the status is absent
      content.append(g)
    }
  } else if (opts.statusWidget) {
    // A widget status (e.g. the spinning 🔄 while connecting) — centred on
    // the right cap like a single glyph status.
    const [sw] = opts.statusWidget.get_size_request()
    const wW = sw > 0 ? sw : ROW_H(config)
    opts.statusWidget.set_margin_start(10)
    opts.statusWidget.set_margin_end(Math.max(0, Math.round(12 - wW / 2)))
    content.append(opts.statusWidget)
  } else if (status) {
    if (statusIsGlyph && status.length <= 2) {
      // Nerd Font glyph status (lock, check) → Cairo box centred on the
      // right cap (margin_end = 12 − STATUS_BOX/2, width-independent).
      // Flat: statuses are informational — text colour, no glow.
      const s = hoverGlyph({
        config,
        emoji: status,
        box: STATUS_BOX,
        fontSize: MENU(config).emojiSize,
        rest: textColour,
        flat: true,
      })
      s.widget.set_margin_start(10)
      s.widget.set_margin_end(Math.max(0, Math.round(12 - STATUS_BOX / 2)))
      content.append(s.widget)
      rowGlyphs.push(s.setHover)
    } else {
      // Text status (Connecting…/Paired/New) → right-aligned (or cap-centred
      // for ≤2 chars, e.g. "On"/"Off").
      const statusLabel = pangoLabel(
        status,
        MENU(config).fontSize,
        colourOf(opts.statusColour ?? "mutedText", config),
        true,
      )
      if (status.length <= 2) {
        statusLabel.set_margin_start(10)
        statusLabel.set_margin_end(inkMarginEnd(statusLabel, 0, 12)) // cap = 12px from the right edge
      } else {
        statusLabel.set_margin_start(10)
        statusLabel.set_margin_end(4)
      }
      content.append(statusLabel)
    }
  }

  const row = new Gtk.Overlay()
  // Natural width (the panel measures it); hexpand stretches the row to the
  // panel's content width on layout.
  row.set_size_request(1, rowH)
  row.set_hexpand(true)
  row.set_halign(Gtk.Align.FILL)
  row.set_child(highlight)
  row.add_overlay(content)
  // Width closure for panelWidthFor. The content box's measured width includes
  // every child margin; the row adds its own ROW_L/ROW_R insets.
  attachRowWidth(row, content, ROW_L, ROW_R)

  if (opts.onClick) {
    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => {
      hover = true
      highlight.queue_draw()
      for (const g of rowGlyphs) g(true)
    })
    motion.connect("leave", () => {
      hover = false
      highlight.queue_draw()
      for (const g of rowGlyphs) g(false)
    })
    row.add_controller(motion)
    const click = new Gtk.GestureClick()
    click.connect("pressed", (_c: any, _n: number, x: number, y: number) => {
      // A press over the trailing CONTROL zone belongs to the action (trash),
      // not the row — otherwise clicking "forget" would ALSO fire the row's
      // connect/disconnect. The bail covers everything from the trash's LEFT
      // edge rightward (the trash sits LEFT of the status after the
      // forget/secure swap — the old far-right bail `width − ROW_R −
      // ACTION_BOX` missed its new position, so clicking forget on a network
      // ALSO ran a connect to it: NM "new activation request" → the current
      // connection drops, then the delete fires. The trash's on-screen
      // position is read live via translate_coordinates).
      if (opts.action) {
        const farRight = row.get_allocation().width - ROW_R - ACTION_BOX
        try {
          const t = actionWidget?.translate_coordinates(row, 0, 0)
          if (t?.[0]) {
            if (x >= t[1]) return
          } else if (x >= farRight) return
        } catch {
          if (x >= farRight) return
        }
      }
      opts.onClick?.()
    })
    row.add_controller(click)
  }
  return row
}

/** A centred status line (empty states, loading, errors) — text LEFT-aligned
 *  with the row content so status lines read like the entries. Colour = muted
 *  by default; pass "danger" for failures. Ellipsizes only past the panel cap
 *  (menu.maxWidth) — a caption that fits drives the panel wider instead of
 *  clipping (the old "cut off" settings captions). */
export function menuInfoRow(
  text: string,
  config: AppletConfig,
  colour: MenuColour = "mutedText",
): Gtk.Widget {
  const row = new Gtk.Overlay()
  row.set_size_request(1, ROW_H(config))
  row.set_hexpand(true)
  row.set_halign(Gtk.Align.FILL)
  row.set_child(new Gtk.DrawingArea())
  const label = pangoLabel(text, MENU(config).fontSize, colourOf(colour, config), true)
  label.set_halign(Gtk.Align.START)
  label.set_margin_start(ROW_L)
  row.add_overlay(label)
  // Width closure: label natural + its ROW_L margin.
  attachRowWidth(row, label, ROW_L)
  return row
}

/** A loading row: the given spinner widget (see common/menus/spinner.tsx)
 *  left-aligned with the row content inset. */
export function menuSpinnerRow(spinner: Gtk.Widget, config: AppletConfig): Gtk.Widget {
  const row = new Gtk.Overlay()
  row.set_size_request(1, ROW_H(config))
  row.set_hexpand(true)
  row.set_halign(Gtk.Align.FILL)
  row.set_child(new Gtk.DrawingArea())
  spinner.set_halign(Gtk.Align.START)
  spinner.set_valign(Gtk.Align.CENTER)
  spinner.set_margin_start(ROW_L)
  row.add_overlay(spinner)
  // Width closure: spinner natural + its ROW_L margin.
  attachRowWidth(row, spinner, ROW_L)
  return row
}

/** Inline text entry (wifi password, screengrab path/template). Enter submits
 *  through the entry's own `activate` signal (Return is claimed by the entry's
 *  internal text widget and never reaches a bubble-phase controller on the
 *  entry), Escape cancels. `value` (optional) prefills the entry. */
export function menuEntryRow(opts: {
  placeholder: string
  password?: boolean
  /** Optional initial text (e.g. the current config value). */
  value?: string
  /** Grab widget focus on mount (the wifi password entry — the user types
   *  immediately after clicking the network). Default off: auto-focusing
   *  every entry paints the theme's focused-entry "blue box" in the
   *  settings menu (the user's capture-settings complaint). */
  focusOnMount?: boolean
  /** Called on every edit (the wifi menu stashes the text so a poll re-render
   *  doesn't wipe what the user is typing). */
  onChange?: (value: string) => void
  /** Show/hide toggle for password entries (the eyeball). */
  showToggle?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
  /** The host's live config view (menu palette + font family). */
  config: AppletConfig
}): Gtk.Widget {
  // No EXTERNAL margins: the box sits flush in the scrolled viewport — the
  // old INSET+PAD margins made it 22px wider than the panel (the entry row's
  // right side got clipped, "can't see what's there"). The left inset + right
  // padding now live INSIDE, on the entry/toggle. The box builds at natural
  // size and stretches to the panel's content width (hexpand) — a long value
  // (e.g. the storage path) widens the panel via measurement instead of
  // clipping inside a fixed 304px field.
  const box = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    halign: Gtk.Align.FILL,
    valign: Gtk.Align.CENTER,
  })
  const config = opts.config
  box.set_size_request(1, ROW_H(config))
  box.set_hexpand(true)
  const entry = new Gtk.Entry({ placeholderText: opts.placeholder, hexpand: true })
  if (opts.password) entry.set_visibility(false)
  if (opts.value !== undefined) entry.set_text(opts.value)
  entry.set_has_frame(false) // no theme frame/outline — borderless by default
  entry.add_css_class("menu-entry")
  if (opts.password) entry.add_css_class("menu-entry-password") // letter-spacing only here
  entry.set_margin_start(ROW_L)
  entry.set_margin_end(ROW_R) // the entry must not run flush to the row's right edge
  entry.set_attributes(pangoAttrs(MENU(config).text, MENU(config).fontSize))
  // Submit rides the entry's own `activate` signal: Return is claimed by the
  // entry's internal text widget on its way up (it emits `activate` and stops
  // the event), so a bubble-phase key controller on the entry never receives
  // Return — the entry looked focused and typing landed, yet Enter submitted
  // nothing. Escape is not claimed, so the controller keeps the cancel path.
  entry.connect("activate", () => opts.onSubmit(entry.get_text()))
  const keyCtrl = new Gtk.EventControllerKey()
  keyCtrl.connect("key-pressed", (_c: any, keyval: number) => {
    if (keyval === Gdk.KEY_Escape) {
      opts.onCancel()
      return true
    }
    return false
  })
  entry.add_controller(keyCtrl)
  if (opts.onChange) entry.connect("changed", () => opts.onChange!(entry.get_text()))
  box.append(entry)
  // Show/hide eyeball (password entries): hidden by default, click toggles.
  // Same hover treatment as every menu emoji — brighten + accent glow.
  if (opts.showToggle) {
    const I = () => config.appearance.icons as Record<string, string>
    let visible = false
    const eye = hoverGlyph({
      config,
      emoji: () => (visible ? (I().menuEye ?? "\uf06e") : (I().menuEyeOff ?? "\uf070")),
      box: MENU(config).emojiSize,
      fontSize: MENU(config).emojiSize,
      rest: MENU(config).mutedText,
      ownHover: true,
      onClick: () => {
        visible = !visible
        entry.set_visibility(visible)
      },
    })
    eye.widget.set_margin_start(8)
    eye.widget.set_margin_end(ROW_R)
    box.append(eye.widget)
  }
  // Grab focus once the row is in the tree (idle_add needs the priority arg
  // in this gjs — one-arg form CRITICALs). Only when focusOnMount — see the
  // opts docs.
  if (opts.focusOnMount) {
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      entry.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  }
  return box
}

// ── The window shell ──

export interface MenuController {
  close: () => void
  /** Replace the row list (recomputes the panel height + window size). */
  setRows: (rows: Gtk.Widget[]) => void
}

interface OpenMenuOpts {
  /** "wifi" | "bluetooth" — used for the applet toggle-close detection. */
  kind: string
  monitor: Gdk.Monitor
  /** Initial rows (menus pass a loading row and replace it on first poll). */
  rows: Gtk.Widget[]
  /** Called INSIDE the gnim scope after the window is built — menus set up
   *  poll timers here (onCleanup works inside this callback). */
  onMount?: (ctl: MenuController) => void
  /** Called during teardown after fade-out (e.g. unregister the bluez agent). */
  onClose?: () => void
  /** The host's live config view (menu palette, timing, font family). */
  config: AppletConfig
}

// Single-open hub — one menu (wifi OR bt) at a time.
let activeClose: (() => void) | null = null
let activeKind: string | null = null

/** A waiting menu open (menu-switch): the new menu's content build + fade-in
 *  run once the DISPLACED menu's fade-out completes, so a switch is a visible
 *  fade-out → fade-in instead of an instant wipe. Single slot: only one menu
 *  can be in the pipeline at a time; a newer open overwrites an older one. */
let pendingOpen: (() => void) | null = null

// Subscribers notified when a menu finishes closing (with its kind). The
// wifi/bt applets use this to close their (keepOpen-pinned) panel once their
// GUI is dismissed via any path (Escape, `menu close`, single-open swap).
const menuCloseCbs = new Set<(kind: string) => void>()

/** Subscribe to menu closes; cb receives the kind ("wifi"|"bluetooth") of the
 *  menu that closed. Returns an unsubscribe. */
export function onMenuClose(cb: (kind: string) => void): () => void {
  menuCloseCbs.add(cb)
  return () => {
    menuCloseCbs.delete(cb)
  }
}

export function closeMenu(): void {
  if (activeClose) activeClose()
}

/** Which menu is currently open ("wifi" | "bluetooth" | null) — lets the
 *  applets toggle their menu closed on a second "Open menu" click. */
export function menuKind(): string | null {
  return activeKind
}

/** Adopt the single-open hub for a CUSTOM (non-framework) menu surface —
 *  closes whatever is showing, claims activeClose/activeKind so menuKind()/
 *  closeMenu()/onMenuClose work for it. The capture-mode overlay uses this. */
export function hubAdopt(kind: string, close: () => void): void {
  if (activeClose) activeClose()
  activeClose = close
  activeKind = kind
  syncScrimRegion()
}

/** Release the hub claim + notify onMenuClose subscribers (the custom
 *  surface calls this after its fade-out, mirroring the framework's close).
 *  Returns whether THIS close was still the hub's owner (true = a genuine
 *  close; false = a supersede already replaced it — e.g. a still↔video
 *  capture-overlay switch, where the new surface owns the hub). */
export function hubRelease(kind: string, close: () => void): boolean {
  let cleared = false
  if (activeClose === close) {
    activeClose = null
    if (activeKind === kind) activeKind = null
    syncScrimRegion()
    cleared = true
  }
  for (const cb of menuCloseCbs) cb(kind)
  return cleared
}

export function openMenu(opts: OpenMenuOpts): MenuController {
  const config = opts.config
  // Hardened open: re-assert the scrim's idle state before arming (a close
  // path that never reached its sync left the scrim stuck mapped — visible
  // here is always recomputed by syncScrimRegion after the hub claim below).
  assertScrimIdle()
  const s = ensureMenuShell(opts.monitor, config)
  let ctl: MenuController = null as any
  let closed = false
  let built = false
  const fadeMs = Math.max(0, config.timing.menuFade)
  // The menu currently showing (if any) — its fade-out runs first, then this
  // open builds its rows and fades in.
  const displaced = activeClose

  // Per-open gnim scope: the menus' poll timers (registered in onMount via
  // onCleanup) die here on close. The window/shell is shared and persists.
  // For a menu-SWITCH (deferred open) the onMount runs inside the displaced
  // menu's fade completion, where this scope is no longer tracking — the
  // deferred build gets its OWN scope (see pendingOpen below) and scopeDispose
  // follows it, so the new menu's onCleanup timers are never leaked (the
  // "out of tracking context" warning).
  let scopeDispose: (() => void) | null = null
  createRoot((dispose) => {
    scopeDispose = dispose
    activeKind = opts.kind
    // ── Content column (overlay child, inset by PAD). No header/toggle/close
    //  buttons — the dock applet already owns enable/disable/reconnect, and the
    //  menu is dismissed via Escape, the applet step, or `menu close`. ──
    // The shell is SHARED and reused across opens — clear the previous menu's
    // rows first, or the old content accumulates (the wifi/bt rows + new rows
    // amalgamation). Deferred on a switch until the displaced menu's fade-out
    // completes (so its rows stay painted during the fade-out).
    const paintRows = (rows: Gtk.Widget[]): void => {
      let child = s.listBox.get_first_child()
      while (child) {
        const next = child.get_next_sibling()
        s.listBox.remove(child)
        child = next
      }
      for (const r of rows) s.listBox.append(r)
      const h = contentHeight(rows.length, config)
      // The panel width auto-sizes to the widest row (floor menu.width, cap
      // menu.maxWidth — also clamped to the baked shell width). No window
      // resize EVER: the window is fixed at its max size (resizing it would
      // re-evaluate the pointer and eat the next dock click); the painted
      // panel rect + input region just adapt, exactly like the height does.
      const w = panelWidthFor(rows, config)
      applyPanelLayout(s, w, h, config)
      s.bg.queue_draw()
      s.win.queue_draw()
    }
    const buildContent = (): void => {
      if (closed || built) return
      built = true
      paintRows(opts.rows)
      syncScrimRegion()
    }

    // ── Fade driver (window opacity, same eased tick as the pill). The fade
    //  state lives on the SHARED shell: a new open supersedes any in-flight
    //  close fade (invoking its completion) instead of two fades fighting over
    //  the same opacity — which left the new menu invisible or half-faded. ──
    const fadeTo = (to: number, onDone: () => void): void => {
      if (s.fadeRef) {
        const prevDone = s.fadeDone
        s.fadeRef.cancel()
        s.fadeRef = null
        s.fadeDone = null
        prevDone?.() // superseded menu's hub cleanup + dispose still run
      }
      const from = s.win.opacity
      if (from === to || fadeMs <= 0) {
        s.win.opacity = to
        onDone()
        return
      }
      const t0 = GLib.get_monotonic_time()
      const durUs = fadeMs * 1000
      s.fadeRef = runFrames(s.win, (nowUs) => {
        const t = Math.min(1, (nowUs - t0) / durUs)
        const e = easeCubicInOut(t)
        s.win.opacity = from + (to - from) * e
        if (t >= 1) {
          s.win.opacity = to
          s.fadeRef = null
          s.fadeDone = null
          onDone()
          return false
        }
        return true
      })
      s.fadeDone = onDone
    }

    // ── Close: fade out → click-through (empty input region) → run gnim
    //  cleanups. The window STAYS mapped (opacity 0) — never destroying it
    //  means no surface map/unmap at click time, so the compositor never
    //  re-evaluates the pointer over the dock windows and the next click is
    //  never missed (the "second Open menu click ignored" bug).
    const close = (): void => {
      if (closed) return
      closed = true
      fadeTo(0.01, () => {
        opts.onClose?.()
        // Only empty the shell's input region + release the hub if this menu
        // is STILL the active one — when superseded by a new open, the new
        // menu owns the shell (it already set its region + hub claim).
        if (activeClose === close) {
          shellOpen = false // stop painting the panel rect — invisible
          // Focus follows the open menu, never the mapped shell: leaving
          // ON_DEMAND here would hand the seat's keyboard to this invisible
          // surface for the rest of the session.
          s.win.keymode = Astal.Keymode.NONE
          setMenuRegion(s.win, 0, 0) // empty → click-through
          // Force a commit NOW: at opacity 0 GTK culls frames and the empty
          // region (and the suppressed paint) never reach the compositor — the
          // stale panel region would keep eating clicks. The closed baseline
          // opacity is 0.01 (non-zero → frames keep flowing; with the paint
          // suppressed the window renders nothing).
          s.win.opacity = 0.01
          s.bg.queue_draw()
          s.win.queue_draw()
          activeClose = null
          // Only the genuinely-closing menu clears its kind — a same-kind
          // supersede (e.g. `menu wifi` while the applet's own open is
          // mid-flight) must NOT null the new menu's kind, or menuKind()
          // lies while a menu is visibly open (breaks the keepOpen pin).
          if (activeKind === opts.kind) activeKind = null
          syncScrimRegion()
        }
        for (const cb of menuCloseCbs) cb(opts.kind)
        scopeDispose?.()
        // A menu-switch waiting on our fade-out may now build + fade in.
        if (pendingOpen) {
          const p = pendingOpen
          pendingOpen = null
          p()
        }
      })
    }

    ctl = {
      close,
      setRows(rows: Gtk.Widget[]) {
        if (closed || !built) return // late timer refresh after teardown — no-op
        paintRows(rows)
      },
    }

    activeClose = close

    if (displaced) {
      // Menu-switch: let the displaced menu's fade-OUT complete first (its
      // rows stay painted during the fade-out), then build + fade in — a
      // visible fade-out → fade-in instead of an instant wipe. Its completion
      // clears ITS hub claim only if still active; we already own the shell,
      // so the region stays for our rows. The deferred build runs in its own
      // gnim scope so the new menu's onCleanup timers are tracked.
      pendingOpen = () => {
        if (closed || activeClose !== close) return
        createRoot((dispose2) => {
          scopeDispose = dispose2
          buildContent()
          fadeTo(1, () => {})
          opts.onMount?.(ctl)
        })
      }
      displaced()
    } else {
      // Fade in.
      buildContent()
      fadeTo(1, () => {})
      opts.onMount?.(ctl)
    }
  })

  return ctl
}

// ──────────────────────────────────────────────────────────────────────────
// Persistent menu shell — one window for the whole app lifetime
// ──────────────────────────────────────────────────────────────────────────

interface MenuShell {
  win: Astal.Window
  bg: Gtk.DrawingArea
  listBox: Gtk.Box
  scrolled: Gtk.ScrolledWindow
  /** The in-flight window-opacity fade (shared — a new open supersedes the
   *  previous menu's close fade instead of fighting it). */
  fadeRef: FrameRunner | null
  /** The superseded fade's completion (invoked on supersede so the closed
   *  menu's hub cleanup + gnim dispose still run). */
  fadeDone: (() => void) | null
}

let shell: MenuShell | null = null

// Current painted panel rect (surface coords, vertically centred in the
// max-sized window). Updated per open/setRows; 0 = no panel (closed).
let panelH = 0
let panelY = 0
/** The shared shell paints its panel rect ONLY while a menu is open. Closed:
 *  the bg draws fully transparent (still producing frames at the 0.01
 *  baseline opacity, so the input-region/size commits actually reach the
 *  compositor — at opacity 0 GTK culls frames and the stale panel + region
 *  linger as a faint rectangle that also eats clicks). */
let shellOpen = false
/** Current painted panel rect (surface coords, centred in the max-sized
 *  window — horizontally too, since panels auto-size their width). Updated
 *  per open/setRows; 0 = no panel (closed). */
let panelW = 0
let panelX = 0

const contentHeight = (rowCount: number, config: AppletConfig) =>
  2 * MENU_PAD + listHeightFor(rowCount, config)

/** Attach the panelWidthFor width closure to a row: `measured`'s natural width
 *  plus the row's own horizontal insets. Rows build their content at natural
 *  size, so the builder is the only place that knows both — a generic measure
 *  cannot work here (GtkOverlay.measure measures only its MAIN child, and
 *  widget measure() excludes the widget's own margins). */
export function attachRowWidth(
  row: Gtk.Widget,
  measured: Gtk.Widget,
  insetStart: number,
  insetEnd = 0,
): void {
  ;(row as any)._rowWidth = (): number => {
    try {
      const [, nat] = measured.measure(Gtk.Orientation.HORIZONTAL, -1)
      return Number.isFinite(nat) ? Math.round(nat) + insetStart + insetEnd : 0
    } catch (_) {
      return 0
    }
  }
}

/** Natural width of one row. Rows attach a `_rowWidth` closure at build time
 *  (their builder knows the real content + margins); GtkOverlay.measure only
 *  measures the MAIN child (the highlight DA → 1), and widget measure()
 *  excludes the widget's own margins, so a generic measure can't work here. */
function rowNaturalWidth(r: Gtk.Widget): number {
  const fn = (r as any)._rowWidth
  if (typeof fn === "function") {
    try {
      return fn()
    } catch (_) {
      return 0
    }
  }
  try {
    const [, nat] = r.measure(Gtk.Orientation.HORIZONTAL, -1)
    return Number.isFinite(nat) ? nat : 0
  } catch (_) {
    return 0
  }
}

/** Panel width for a set of rows: the widest row's NATURAL width + the PAD
 *  margins, floored at menu.width (wifi/bt keep their current 320) and capped
 *  at menu.maxWidth (settings captions drive it to ~480–520), also clamped to
 *  the baked shell width (a live maxWidth raise beyond the window is harmless
 *  — it just can't widen the surface). Ellipsizable labels (SSIDs, device
 *  names) report their full natural width and ellipsize only when they exceed
 *  the cap. */
function panelWidthFor(rows: Gtk.Widget[], config: AppletConfig): number {
  let maxNat = 0
  for (const r of rows) {
    const nat = rowNaturalWidth(r)
    if (nat > maxNat) maxNat = nat
  }
  const floor = MENU(config).width
  const cap = Math.min(MENU(config).maxWidth ?? floor, SHELL_W(config))
  return Math.max(floor, Math.min(cap, Math.round(maxNat + 2 * MENU_PAD)))
}

/** Apply a per-open panel layout: sizes the scrolled list to the panel's
 *  inner width (centred), updates the panel rect state, and re-regions the
 *  surface. The WINDOW is never resized (see ensureMenuShell). The vscrollbar
 *  policy follows the panel depth: panels shorter than the scrollbar's own
 *  minimum height (140px — the "50% shorter" thumb's slider min-height, see
 *  style.css) use NEVER so the scrolled window's minimum stays at the panel
 *  inner height — with AUTOMATIC the scrollbar's 140px minimum forces the
 *  scrolled to 140px and the rows render above the centred panel (the
 *  "spinner above the menu" bug). Short lists never scroll, so NEVER is
 *  correct there; deeper panels get AUTOMATIC (scrollbar + min 140 < inner). */
function applyPanelLayout(s: MenuShell, w: number, h: number, config: AppletConfig): void {
  const contentW = Math.max(1, w - 2 * MENU_PAD)
  const innerH = Math.max(1, h - 2 * MENU_PAD)
  s.scrolled.set_policy(
    Gtk.PolicyType.NEVER,
    innerH >= 140 ? Gtk.PolicyType.AUTOMATIC : Gtk.PolicyType.NEVER,
  )
  s.scrolled.set_max_content_width(contentW)
  s.scrolled.set_min_content_height(innerH)
  s.scrolled.set_size_request(contentW, innerH)
  shellOpen = true
  // The open menu is the one state that needs the keyboard (Escape close, the
  // password entry); the closed shell below drops it again.
  s.win.keymode = Astal.Keymode.ON_DEMAND
  panelW = w
  panelX = Math.round((SHELL_W(config) - w) / 2)
  panelH = h
  panelY = Math.round((contentHeight(MAX_ROWS(config), config) - h) / 2)
  setMenuRegion(s.win, w, h, panelX, panelY)
}

/** Set the menu window's input region to the rect (w,h) at offset (x,y)
 *  (surface coords); (0,0) = empty. The window is max-sized, so the panel
 *  rect is centred within it (both axes — panels auto-size their width). */
function setMenuRegion(win: any, w: number, h: number, x = 0, y = 0): void {
  const surf = win?.get_surface?.()
  if (!surf || typeof surf.set_input_region !== "function") return
  try {
    const r: any = new (cairo as any).Region()
    if (w > 0 && h > 0) r.unionRectangle({ x, y, width: w, height: h })
    surf.set_input_region(r)
  } catch (e) {
    ignore("menu input region", e)
  }
}

// ── Click-off dismissal scrim ──
// A full-monitor transparent layer window that closes the open menu on any
// click outside it. Sits in the OVERLAY layer ABOVE the dock windows but
// BELOW the menu shell (Hyprland stacks same-layer surfaces in map order:
// the dock maps at build time, the scrim ~100ms later, the shell ~500ms).
// Its input region is EMPTY when no menu is open (fully click-through); when
// a menu opens it arms over the whole monitor EXCEPT the involved applet's
// window rect (the wifi/bt keepOpen exception — those applets' on/off/scan
// steps are meant to be used in tandem with their menu; the dock registers a
// hole provider that reports the applet window's monitor rect). Clicking the
// scrim closes the active menu, which fires onMenuClose → the keepOpen-pinned
// applet panel closes with it.
let scrimWin: Astal.Window | null = null

type ScrimHoleFn = (kind: string) => { x: number; y: number; w: number; h: number } | null
let scrimHoleProvider: ScrimHoleFn | null = null

/** Registered by the dock: the applet that must stay interactive while its
 *  menu is open ("wifi"/"bluetooth"), or null for kinds without an exception. */
export function setScrimHoleProvider(fn: ScrimHoleFn | null): void {
  scrimHoleProvider = fn
}

/** Arm (menu open) or disarm (menu closed) the scrim's input region. Armed:
 *  the full monitor minus the involved applet's rect. Disarmed: empty. A
 *  wl_surface input-region change only takes effect after a commit, so the
 *  set is followed by queue_draw (the scrim's paint keeps the frame pipeline
 *  alive). */
function syncScrimRegion(): void {
  if (!scrimWin) return // Map only while a menu is open: an always-mapped full-screen layer surface
  // is reconfigured by the compositor every frame (the 60fps ack/commit loop,
  // same one the notifications popup had).
  scrimWin.visible = !!activeClose
  const surf = scrimWin.get_surface?.()
  if (!surf || typeof surf.set_input_region !== "function") return
  try {
    const r: any = new (cairo as any).Region()
    if (activeClose) {
      const a = scrimWin.get_allocation?.()
      const w = a?.width ?? 0
      const h = a?.height ?? 0
      if (w > 0 && h > 0) {
        r.unionRectangle({ x: 0, y: 0, width: w, height: h })
        const hole = scrimHoleProvider?.(activeKind ?? "")
        if (hole) {
          try {
            r.subtractRectangle({ x: hole.x, y: hole.y, width: hole.w, height: hole.h })
          } catch (e) {
            ignore("scrim hole subtract", e)
          }
        }
        // The scrim maps above the shell (it re-maps on open), so hole the
        // painted panel rect too — clicks on the panel fall through to the
        // shell, clicks anywhere else still hit the scrim (dismiss).
        if (shell && shellOpen && panelW > 0 && panelH > 0) {
          const sa = shell.win.get_allocation?.()
          const sw = sa?.width ?? 0
          const sh = sa?.height ?? 0
          if (sw > 0 && sh > 0) {
            try {
              r.subtractRectangle({
                x: Math.round((w - sw) / 2) + panelX,
                y: Math.round((h - sh) / 2) + panelY,
                width: panelW,
                height: panelH,
              })
            } catch (e) {
              ignore("scrim panel subtract", e)
            }
          }
        }
      }
    }
    surf.set_input_region(r)
    scrimWin.queue_draw?.() // force the wl_surface commit
  } catch (e) {
    ignore("scrim input region", e)
  }
}

/** Scrim state assertion — the stuck-scrim hardening: on every menu open AND
 *  on app start, if no menu is active, force the scrim unmapped + empty
 *  region. syncScrimRegion already derives `visible` from activeClose, but a
 *  close path that never reached its sync left the scrim mapped (fullscreen
 *  OVERLAY + blur-rule match) — this re-asserts the idle state from scratch. */
function assertScrimIdle(): void {
  if (!scrimWin || activeClose) return
  scrimWin.visible = false
  setMenuRegion(scrimWin, 0, 0)
}

function ensureScrim(monitor: Gdk.Monitor): void {
  if (scrimWin) return
  const win = (
    <window
      namespace="dock-menu-scrim"
      class="dock-menu"
      gdkmonitor={monitor}
      exclusivity={Astal.Exclusivity.IGNORE}
      layer={Astal.Layer.OVERLAY}
      anchor={
        Astal.WindowAnchor.TOP |
        Astal.WindowAnchor.BOTTOM |
        Astal.WindowAnchor.LEFT |
        Astal.WindowAnchor.RIGHT
      }
      keymode={Astal.Keymode.NONE}
      resizable
      visible={false}
      $={(self: any) => {
        // A real paint (fully transparent) keeps the frame pipeline alive so
        // set_input_region changes actually commit — at pure-nothing GTK
        // culls frames and the scrim keeps its stale region (the same trick
        // as the menu shell's closed-state bg).
        const da = new Gtk.DrawingArea()
        da.set_draw_func((_d: any, cr: any, w: number, h: number) => {
          cr.setSourceRGBA(0, 0, 0, 0)
          cr.rectangle(0, 0, w, h)
          cr.fill()
        })
        self.set_child(da)
        // Tiny non-zero opacity keeps the frame pipeline alive (input-region
        // commits need frames; at 0 GTK culls them — same trick as the shell).
        self.opacity = 0.01
        self.connect("realize", () => {
          const surf = self.get_surface?.()
          if (!surf) return
          try {
            surf.set_opaque_region?.(null)
          } catch (e) {
            ignore("scrim opaque region clear", e)
          }
        })
        self.connect("map", () => {
          // Fresh surface: arm per the current state (empty when no menu is
          // open — the invisible surface must never eat clicks).
          syncScrimRegion()
          ;(self as any).queue_draw?.()
        })
      }}
    />
  ) as any
  const click = new Gtk.GestureClick()
  click.connect("pressed", () => {
    closeMenu()
  })
  win.add_controller(click)
  // Click-through until a menu opens (the pre-created window must not
  // intercept clicks while invisible).
  setMenuRegion(win, 0, 0)
  scrimWin = win
  // No always-map: syncScrimRegion() maps it on menu open and unmaps on close.
  // (An always-mapped full-screen layer surface gets reconfigured every frame.)
}

/** Create (once) and return the shared menu window. Mapped from birth but
 *  invisible (opacity 0) with an EMPTY input region — click-through until an
 *  open sets the panel region and fades it in. Pre-created by menuInit() at
 *  app startup so the first open never maps a fresh surface. */
function ensureMenuShell(monitor: Gdk.Monitor, config: AppletConfig): MenuShell {
  if (shell) return shell

  // The window is created at its MAXIMUM size and NEVER resized afterwards:
  // any resize (or map) of a layer surface makes the compositor re-evaluate
  // the pointer over every surface, which LEAVEs the dock window under the
  // cursor and swallows its next click (the "second Open menu click is
  // ignored" bug — resizing at open did exactly this). Opens only change the
  // opacity, the painted panel rect, and the input region.
  const maxH = contentHeight(MAX_ROWS(config), config)
  // The shell window is baked at max(width, maxWidth) wide — every panel
  // (even the widest settings menu) fits inside it, so the surface NEVER
  // resizes after this point (a resize at open time re-evaluates the pointer
  // and eats the next dock click). Individual menus paint their panel rect at
  // whatever width their content needs, centred horizontally inside it.
  const shellW = SHELL_W(config)
  // Paint a visible panel rect from birth (invisible at opacity 0, but a real
  // draw produces a frame — the layer surface's geometry follows the widget
  // size only on a committed frame; with nothing painted, GTK emits no frame
  // and the compositor keeps the stale 200x200 until the FIRST open commits
  // the resize at click time — the exact wifi-vs-bt click-eater).
  panelH = contentHeight(1, config)
  panelY = Math.round((maxH - panelH) / 2)
  panelW = MENU(config).width
  panelX = Math.round((shellW - panelW) / 2)
  const bg = new Gtk.DrawingArea()
  bg.set_size_request(shellW, maxH)
  // Paint only the current panel rect (centred) — the rest of the max-sized
  // surface stays transparent.
  bg.set_draw_func((_d: any, cr: any, w: number, h: number) => {
    if (panelH <= 0) return
    const c = MENU(config).bg
    // Closed: paint the rect at alpha 0 — a real paint keeps the frame
    // pipeline alive (the layer surface commits size/region changes) while
    // rendering nothing visible.
    cr.setSourceRGBA(c.rgb[0], c.rgb[1], c.rgb[2], shellOpen ? c.alpha : 0)
    roundedRect(cr, panelX, panelY, panelW, panelH, MENU(config).cornerRadius)
    cr.fill()
  })

  const listBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, halign: Gtk.Align.FILL })
  const scrolled = new Gtk.ScrolledWindow()
  scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
  // Overlay scrolling hides the scrollbar until the user scrolls (GTK4
  // default) — the user expects the thin pill visible on any overflowing
  // list, in every menu. Disable it so the scrollbar always shows.
  scrolled.set_overlay_scrolling(false)
  // The list fills the panel's inner width: the scrolled is re-sized per open
  // (applyPanelLayout) and CENTRED in the content box — which spans the full
  // baked window — so the list always aligns with the painted panel rect,
  // whatever width the panel auto-sized to. The width cap stops a row's
  // natural width from ever pushing the FIXED window wider (the old "stuff
  // off screen and cut off" bug).
  scrolled.set_halign(Gtk.Align.CENTER)
  scrolled.set_max_content_width(MENU(config).width - 2 * MENU_PAD)
  scrolled.set_min_content_height(listHeightFor(1, config))
  scrolled.set_max_content_height(MAX_ROWS(config) * ROW_H(config))
  scrolled.set_child(listBox)
  // 50%-shorter thumb: GTK4 sizes the thumb proportionally to the scroll
  // adjustment and CSS can't cap it (gtkrange.c: height = track × page/total
  // with only a minimum floor) — fix the slider size so the thumb is exactly
  // the CSS min-height (140px = half of the always-280px track: maxRows 7 ×
  // rowHeight 40 — the bar only shows when the list overflows).
  const vscroll = scrolled.get_vscrollbar()
  // Gtk.Scrollbar is a plain Widget — not a Gtk.Range — and carries no
  // `set_slider_size_fixed`: the method lives on the Range trough underneath
  // it, so the size-fixing call goes through that child. Called on the
  // scrollbar itself the optional call is a silent no-op.
  const trough = vscroll?.get_first_child()
  if (trough instanceof Gtk.Range) trough.set_slider_size_fixed(true)
  // Proximity widening: the pill grows when the cursor is NEAR the bar (a 2px
  // hover target is a precision test), not only directly over it. Distance
  // from the scrolled window's right edge (where the vscrollbar sits) toggles
  // a `near` CSS class — the same eased 2→7px widening as :hover, via
  // style.css. One controller on the SHARED shell covers every menu.
  const NEAR_PX = 24
  const proxMotion = new Gtk.EventControllerMotion()
  proxMotion.connect("motion", (_c: any, x: number) => {
    const alloc = scrolled.get_allocation()
    const near = alloc.width > 0 && alloc.width - x <= NEAR_PX
    // GTK 4.22 has add/remove_css_class but NO toggle_css_class (absent from
    // the GIR) — the pair below is the toggle.
    if (near) vscroll?.add_css_class("near")
    else vscroll?.remove_css_class("near")
  })
  proxMotion.connect("leave", () => vscroll?.remove_css_class("near"))
  scrolled.add_controller(proxMotion)

  // Content is CENTRED in the max-sized window so the panel appears at the
  // screen centre regardless of row count (the window itself never moves).
  const content = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    halign: Gtk.Align.FILL,
    valign: Gtk.Align.CENTER,
  })
  content.set_margin_start(MENU_PAD)
  content.set_margin_end(MENU_PAD)
  content.set_margin_top(MENU_PAD)
  content.set_margin_bottom(MENU_PAD)
  content.append(scrolled)

  const overlay = new Gtk.Overlay()
  overlay.set_child(bg)
  overlay.add_overlay(content)

  const win = (
    <window
      namespace="dock-menu"
      class="dock-menu"
      gdkmonitor={monitor}
      exclusivity={Astal.Exclusivity.IGNORE}
      layer={Astal.Layer.OVERLAY}
      anchor={Astal.WindowAnchor.NONE}
      // NONE at birth: a layer surface that is not NONE takes the seat's
      // keyboard focus when it maps and again on pointer motion over it. This
      // shell is created once and stays mapped for the process's life, so a
      // creation-time ON_DEMAND stole the keys at every dock spawn/restart.
      // The open menu raises it (applyPanelLayout) and the close drops it.
      keymode={Astal.Keymode.NONE}
      // Resizable: a non-resizable window ignores default-size changes after
      // its first map, so the post-map size settle (below) would be a no-op.
      // Layer-shell surfaces have no decorations, so users can't resize it.
      resizable
      visible={false}
      $={(self: any) => {
        self.set_child(overlay)
        // Tiny non-zero opacity: GTK culls frame production for fully
        // transparent windows, so the layer surface never commits the post-map
        // size and the compositor keeps the stale 200x200 until the FIRST open
        // — whose commit resizes it at click time (the click-eater). 0.01 is
        // imperceptible; the open/close fades take it to 0/1 anyway.
        self.opacity = 0.01
        // Map at the maximum size from birth — a resize at open time would
        // re-evaluate the pointer and eat the next dock click. The window is
        // kept unmapped during construction: the layer surface only picks up
        // the default size if it is set BEFORE the window is mapped.
        self.set_default_size(shellW, maxH)
        // GTK4 opaque-window gotcha: zero the surface's opaque region so the
        // compositor treats the whole window as translucent (the Cairo panel
        // is the only thing painted).
        self.connect("realize", () => {
          const surf = self.get_surface?.()
          if (!surf) return
          try {
            surf.set_opaque_region?.(null)
          } catch (e) {
            ignore("menu shell opaque region clear", e)
          }
        })
        self.connect("map", () => {
          // The shell maps invisible from birth (opacity 0.01). The
          // creation-time setMenuRegion(win, 0, 0) below is a NO-OP — the
          // surface does not exist before realize — so without this the
          // fresh surface keeps the DEFAULT full input region and the
          // invisible window eats every click in its centred 320x296 rect
          // until the first menu open (the "invisible menu blocks input at
          // boot" bug). Apply the empty region now that the surface exists
          // + force a frame so the wl_surface commits it. Guarded: a re-map
          // must never clobber an open menu's panel region.
          if (!shellOpen && !activeClose) {
            setMenuRegion(self, 0, 0)
            ;(self as any).queue_draw?.()
          }
        })
      }}
    />
  ) as any

  // Click-through until an open sets the panel region — the pre-created window
  // must not intercept clicks anywhere while invisible.
  setMenuRegion(win, 0, 0)

  // Persistent keyboard: Escape closes whatever menu is currently open.
  const key = new Gtk.EventControllerKey()
  key.connect("key-pressed", (_c: any, keyval: number) => {
    if (keyval === Gdk.KEY_Escape) {
      if (activeClose) activeClose()
      return true
    }
    return false
  })
  win.add_controller(key)

  shell = { win, bg, listBox, scrolled, fadeRef: null, fadeDone: null }
  // The layer surface maps at GTK's default 200x200 and only follows
  // set_default_size AFTER the map. Settle it at the max size now (two-step:
  // a same-size set is a no-op) while nothing is clickable; from here on the
  // window NEVER resizes (resizes at open time re-evaluate the pointer and
  // eat the next dock click under the cursor).
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
    const mh = contentHeight(MAX_ROWS(config), config)
    ;(win as any).set_default_size(shellW + 1, mh + 1)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
      ;(win as any).set_default_size(shellW, mh)
      // CRITICAL: force the layer surface to COMMIT a frame with the new
      // size NOW. With opacity 0 nothing draws, so without an explicit
      // redraw GTK never produces a frame and the compositor keeps the
      // surface at the stale 200x200 — the FIRST open's queue_draw then
      // commits the resize at click time, re-evaluating the pointer and
      // eating the next dock click (the exact wifi-vs-bt asymmetry).
      ;(win as any).queue_draw()
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
        ;(win as any).queue_draw()
        return GLib.SOURCE_REMOVE
      })
      return GLib.SOURCE_REMOVE
    })
    return GLib.SOURCE_REMOVE
  })
  // The layer surface only picks up the default size when it is set BEFORE
  // the window maps. Map it now (a moment after startup, nothing clickable)
  // so the first open — and every open after — never resizes or maps the
  // surface (either would re-evaluate the pointer and eat the next dock
  // click under the cursor).
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
    win.visible = true
    return GLib.SOURCE_REMOVE
  })
  return shell
}

/** Eager shell creation at app startup — call from app.ts main() so the menu
 *  window exists (mapped + invisible) before the first open, guaranteeing no
 *  surface map happens at click time. */
export function menuInit(monitor: Gdk.Monitor, config: AppletConfig): void {
  // Scrim first (maps ~100ms) so it stacks above the dock, below the shell
  // (which maps ~500ms) — Hyprland orders same-layer surfaces by map order.
  ensureScrim(monitor)
  ensureMenuShell(monitor, config)
  // Startup assertion: no menu can be active before the first open — the
  // scrim must be unmapped + click-through from birth.
  assertScrimIdle()
}

/** Live menu state for `ags -i shell request "dock debug menu"` — ground truth for layout
 *  bugs (row population, panel rect vs scrolled allocation). */
export function menuDebugInfo(): string {
  const lines: string[] = []
  lines.push(
    `kind=${activeKind ?? "null"} shellOpen=${shellOpen} panel=(${panelX},${panelY} ${panelW}x${panelH})`,
  )
  // Scrim observability (the stuck-scrim bug): mapped scrim + no active menu
  // = the stuck state this dump exists to catch.
  lines.push(
    `scrimVisible=${scrimWin ? !!scrimWin.visible : "none"}` +
      (scrimWin ? ` scrimAlloc=${JSON.stringify(scrimWin.get_allocation?.())}` : ""),
  )
  if (!shell) {
    lines.push("no shell")
    return lines.join("\n")
  }
  const a = shell.scrolled.get_allocation()
  lines.push(`scrolled=(${a.x},${a.y} ${a.width}x${a.height})`)
  const sr = shell.scrolled.get_size_request()
  lines.push(
    `scrolled request=(${sr[0]}x${sr[1]}) minC=${shell.scrolled.get_min_content_height()} maxC=${shell.scrolled.get_max_content_height()}`,
  )
  try {
    const [, nat] = shell.scrolled.measure(Gtk.Orientation.VERTICAL, -1)
    lines.push(`scrolled naturalH=${nat}`)
  } catch (e) {
    ignore("menu debug scrolled measure", e)
  }
  const parent = shell.scrolled.get_parent()
  if (parent) {
    const pa = parent.get_allocation()
    lines.push(`content=(${pa.x},${pa.y} ${pa.width}x${pa.height})`)
  }
  const la = shell.listBox.get_allocation()
  lines.push(`listbox=(${la.x},${la.y} ${la.width}x${la.height})`)
  try {
    const [lmin, lnat] = shell.listBox.measure(Gtk.Orientation.VERTICAL, -1)
    lines.push(`listbox minH=${lmin} natH=${lnat}`)
    const r0 = shell.listBox.get_first_child()
    if (r0) {
      const [rmin, rnat] = r0.measure(Gtk.Orientation.VERTICAL, -1)
      lines.push(`row0 minH=${rmin} natH=${rnat}`)
      const main = r0.get_first_child()
      if (main) {
        const [mmin, mnat] = main.measure(Gtk.Orientation.VERTICAL, -1)
        lines.push(`row0-main minH=${mmin} natH=${mnat}`)
      }
    }
  } catch (e) {
    ignore("menu debug measure", e)
  }
  const wa = shell.win.get_allocation?.()
  lines.push(`window=(${wa?.x ?? "?"},${wa?.y ?? "?"} ${wa?.width ?? "?"}x${wa?.height ?? "?"})`)
  let n = 0
  let first = "none"
  let child = shell.listBox.get_first_child()
  while (child) {
    n++
    if (n <= 7) {
      const labels: string[] = []
      collectLabelTexts(child, labels)
      first += `\nrow${n}: ${labels.join(" | ").slice(0, 120)}`
      // right-side glyph geometry: the last two drawing-area children of the
      // row's content box (status + action) — x centres must align across rows.
      const das: string[] = []
      collectBoxDa(child, das)
      first += das.length ? `  [${das.join(" ")}]` : ""
    }
    child = child.get_next_sibling()
  }
  lines.push(`rows=${n}${first}`)
  return lines.join("\n")
}

/** Collect the trailing DrawingArea + Label allocations (status/action glyphs). */
function collectBoxDa(row: Gtk.Widget, out: string[]): void {
  const walk = (w: Gtk.Widget): void => {
    if (w instanceof Gtk.DrawingArea) {
      const a = w.get_allocation()
      out.push(`da(${a.x},${a.width})`)
    }
    const t = (w as any).get_text
    if (typeof t === "function") {
      const a = w.get_allocation()
      const s = String(t.call(w)).slice(0, 2)
      if (s) out.push(`lb(${a.x},${a.width},${s})`)
    }
    let c = w.get_first_child()
    while (c) {
      walk(c)
      c = c.get_next_sibling()
    }
  }
  walk(row)
}

/** Walk a row's widget tree for GtkLabel texts (SSIDs/statuses) — ground
 *  truth for what the menu is actually rendering. */
function collectLabelTexts(w: Gtk.Widget, out: string[]): void {
  const t = (w as any).get_text
  if (typeof t === "function") {
    const s = String(t.call(w))
    if (s && s.trim()) out.push(s.trim())
  }
  let c = w.get_first_child()
  while (c) {
    collectLabelTexts(c, out)
    c = c.get_next_sibling()
  }
}
