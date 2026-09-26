/**
 * common/applets/screengrab/menu.tsx — the screen grab applet's two menus, built on
 * the shared menu framework (same shell/hub as the wifi/bt GUIs).
 *
 *   openScreenGrabCaptureMenu  — the still/video mode picker: Fullscreen /
 *     Window / Select area / Cancel. Picking a mode closes the menu and runs
 *     the capture (geometry resolution → grim / wf-recorder).
 *   openScreenGrabSettingsMenu — the settings GUI: storage path, still format
 *     + jpeg quality, video codec + framerate + quality, naming template,
 *     cursor/audio/notify toggles, the show-dock toggle, and reset.
 *
 * All settings persist to the `screengrab` config section via the serialized
 * config write queue. The applet pins its pill open while either menu is up
 * (keepOpen on menuKind) and closes it when the menu closes (onMenuClose).
 */

import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { DOCK_MENU_NAMESPACE } from "@apps/dock/identity"
import { easeQuadInOut } from "@common/anim/easings"
import { runFrames } from "@common/anim/run-frames"
import type { AppletBackend, CaptureMode } from "@common/applets/backend"
import type { AppletConfig, AppletConfigSource } from "@common/applets/config"
import { ignore } from "@common/log/logger"
import type { MenuController } from "@common/menus/menu-framework"
import {
  attachRowWidth,
  hoverGlyph,
  hubAdopt,
  hubRelease,
  menuInfoRow,
  menuKind,
  menuRow,
  openMenu,
  pangoAttrs,
  ROW_L,
  ROW_R,
  roundedRect,
} from "@common/menus/menu-framework"
import { createPathAutofill } from "@common/path/autofill"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { createRoot } from "gnim"
import { runCapture } from "./capture-run"

export const CAPTURE_KIND = "screengrab-capture"
export const SETTINGS_KIND = "screengrab-settings"

/** The currently-open capture overlay's mode ("still" | "video" | null).
 *  Lets the applet distinguish a same-mode second click (toggle closed) from a
 *  still↔video SWITCH (the old overlay fades out as the new one fades in). */
let captureOverlayMode: "still" | "video" | null = null

export function captureOverlayOpen(): "still" | "video" | null {
  return menuKind() === CAPTURE_KIND ? captureOverlayMode : null
}

function saveScreengrab(
  config: AppletConfig,
  store: AppletConfigSource,
  patch: Record<string, unknown>,
): void {
  // Patch the LIVE config SYNCHRONOUSLY so the caller's rebuild()/re-render
  // immediately shows the new value (the old code applied live only after the
  // async disk write — every toggle/cycle/path commit rendered one step
  // behind or visibly reverted, and two quick changes raced on the clone).
  const clone = JSON.parse(JSON.stringify(config))
  Object.assign(clone.screengrab, patch)
  store.applyToLive?.(clone)
  void store.queueWrite?.(clone)
}

// ── Capture overlay (still/video mode picker) ──
// A small frosted panel of FOUR horizontal emoji buttons (fullscreen / window
// / select area / cancel), positioned at the top or bottom edge per
// screengrab.overlayPos, offset by screengrab.overlayOffset px. It is part of
// the dock UI — it does NOT appear when the "Show dock" setting is off (so a
// recording made with the dock hidden stays clean). Registers with the menu
// hub (hubAdopt) so single-open, menuKind()/closeMenu()/onMenuClose all work.

// Overlay pill dimensions — ~50% of the ORIGINAL area (142×40 vs 200×56;
// each dimension ~70.7% = sqrt(0.5), so the pill reads half as big rather
// than a quarter), with the glyphs rendering at their normal config size.
const OVERLAY_B = 32 // button size
const OVERLAY_GAP = 2
const OVERLAY_PAD = 4

function overlayButton(
  config: AppletConfig,
  choice: { glyph: string },
  onClick: () => void,
): Gtk.Widget {
  // The capture pill's buttons use the SAME hover treatment as every menu
  // emoji — brighten to the menu text colour + the accent radial glow, via the
  // shared hoverGlyph.
  return hoverGlyph({
    config,
    emoji: choice.glyph,
    box: OVERLAY_B,
    fontSize: config.fonts.iconSize,
    rest: config.appearance.glyphColour,
    ownHover: true,
    onClick,
  }).widget
}

export function openScreenGrabCaptureMenu(opts: {
  monitor: Gdk.Monitor
  mode: "still" | "video"
  config: AppletConfig
  store: AppletConfigSource
  backend: AppletBackend
}): void {
  const config = opts.config
  const backend = opts.backend
  // The overlay is part of the dock UI and the dock is visible at all times
  // except during a capture itself (the "Show dock" toggle only affects
  // whether the dock appears in the capture — see capture.ts) — so the
  // overlay always appears.

  const I = config.appearance.icons
  const choices: { glyph: string; mode: CaptureMode | "cancel" }[] = [
    { glyph: I.screengrabFullscreen, mode: "fullscreen" },
    { glyph: I.screengrabWindow, mode: "window" },
    { glyph: I.screengrabSelect, mode: "select" },
    { glyph: I.screengrabCancel, mode: "cancel" },
  ]

  const panelW = choices.length * OVERLAY_B + (choices.length - 1) * OVERLAY_GAP + 2 * OVERLAY_PAD
  const panelH = OVERLAY_B + 2 * OVERLAY_PAD
  const radius = panelH / 2 // pill-shaped: fully rounded ends

  const geom = opts.monitor.get_geometry?.() ?? { width: 1440, height: 900 }
  const screenW = geom.width
  const pos = config.screengrab.overlayPos
  const off = Math.max(0, config.screengrab.overlayOffset)
  const marginLeft = Math.round((screenW - panelW) / 2)
  const fadeMs = Math.max(0, config.timing.menuFade)

  let closed = false

  createRoot((dispose) => {
    const bg = new Gtk.DrawingArea()
    bg.set_size_request(panelW, panelH)
    bg.set_draw_func((_d: any, cr: any, w: number, h: number) => {
      const m = config.appearance.menu
      cr.setSourceRGBA(m.bg.rgb[0], m.bg.rgb[1], m.bg.rgb[2], m.bg.alpha)
      roundedRect(cr, 0, 0, w, h, radius)
      cr.fill()
    })

    const row = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      halign: Gtk.Align.CENTER,
      valign: Gtk.Align.CENTER,
    })
    row.set_margin_start(OVERLAY_PAD)
    row.set_margin_end(OVERLAY_PAD)
    row.set_margin_top(OVERLAY_PAD)
    row.set_margin_bottom(OVERLAY_PAD)
    row.set_spacing(OVERLAY_GAP)
    for (const c of choices) {
      row.append(
        overlayButton(config, c, () => {
          // Remember the chosen mode — the applet icon shows its glyph,
          // persisted via the serialized config write (shared still/video).
          if (c.mode !== "cancel" && config.screengrab.captureMode !== c.mode) {
            saveScreengrab(config, opts.store, { captureMode: c.mode })
          }
          close()
          if (c.mode !== "cancel")
            void runCapture(config, backend, opts.mode, c.mode).catch((e) =>
              print(`[screengrab] capture failed: ${e}`),
            )
        }),
      )
    }

    const overlay = new Gtk.Overlay()
    overlay.set_child(bg)
    overlay.add_overlay(row)

    const win = (
      <window
        namespace={DOCK_MENU_NAMESPACE}
        class="dock-menu"
        gdkmonitor={opts.monitor}
        exclusivity={Astal.Exclusivity.IGNORE}
        layer={Astal.Layer.OVERLAY}
        anchor={
          pos === "top"
            ? Astal.WindowAnchor.TOP | Astal.WindowAnchor.LEFT
            : Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT
        }
        marginTop={pos === "top" ? off : undefined}
        marginBottom={pos === "bottom" ? off : undefined}
        marginLeft={marginLeft}
        keymode={Astal.Keymode.ON_DEMAND}
        resizable={false}
        visible={false}
        $={(self: any) => {
          self.set_child(overlay)
          self.opacity = 0
          self.connect("realize", () => {
            const surf = self.get_surface?.()
            if (!surf) return
            try {
              surf.set_opaque_region?.(null)
            } catch (e) {
              ignore("screengrab menu opaque region clear", e)
            }
          })
        }}
      />
    ) as any

    const fadeTo = (to: number, onDone: () => void): void => {
      const from = (win as any).opacity
      if (from === to || fadeMs <= 0) {
        ;(win as any).opacity = to
        onDone()
        return
      }
      const t0 = GLib.get_monotonic_time()
      const durUs = fadeMs * 1000
      runFrames(
        win,
        () => {
          const t = Math.min(1, (GLib.get_monotonic_time() - t0) / durUs)
          const e = easeQuadInOut(t)
          ;(win as any).opacity = from + (to - from) * e
          if (t >= 1) {
            ;(win as any).opacity = to
            onDone()
            return false
          }
          return true
        },
        config.timing.framerate,
      )
    }

    const close = (): void => {
      if (closed) return
      closed = true
      fadeTo(0, () => {
        // Genuine close (this overlay is still the hub's owner) → clear the
        // mode. A still↔video switch already replaced the owner, so the new
        // overlay's mode stays put.
        if (hubRelease(CAPTURE_KIND, close)) captureOverlayMode = null
        win.destroy()
        dispose()
      })
    }

    // Escape closes (single-open + keepOpen behave like the other menus).
    const key = new Gtk.EventControllerKey()
    key.connect("key-pressed", (_c: any, keyval: number) => {
      if (keyval === Gdk.KEY_Escape) {
        close()
        return true
      }
      return false
    })
    win.add_controller(key)

    hubAdopt(CAPTURE_KIND, close)
    captureOverlayMode = opts.mode
    win.visible = true
    fadeTo(1, () => {})
  })
}

// ── Settings menu ──

function toggleRow(
  config: AppletConfig,
  text: string,
  value: boolean,
  onFlip: (v: boolean) => void,
): Gtk.Widget {
  return menuRow({
    config,
    text,
    status: value ? "On" : "Off",
    active: value,
    onClick: () => onFlip(!value),
  })
}

function cycleRow(
  config: AppletConfig,
  text: string,
  value: string,
  options: string[],
  onPick: (v: string) => void,
): Gtk.Widget {
  return menuRow({
    config,
    text,
    status: value,
    onClick: () => {
      const i = options.indexOf(value)
      onPick(options[(i + 1) % options.length])
    },
  })
}

/** One labelled inline-editable row (the storage-path pattern, generalized): a
 *  leading emoji OR text label + the value as a borderless entry. The label
 *  keeps the standard row text colour AT ALL TIMES (no hover dim/glow); only
 *  the entry dims at rest (mutedText) and brightens on hover + while
 *  focused/typing, with its text RIGHT-ALIGNED (label left, value right).
 *  Enter commits, Escape cancels. The entry fills the row (hexpand) so the
 *  field never clips — GtkEntry has no ellipsize API, long values scroll
 *  inside. */
function inlineEntryRow(opts: {
  config: AppletConfig
  /** Leading emoji glyph (config icon key resolved by caller). */
  emoji?: string
  /** Leading text label (e.g. "Frame rate", "Filename"). */
  label?: string
  value: string
  placeholder: string
  /** Enable blind Tab-cycling path autofill (the storage-path row): Tab fills
   *  the entry with the next matching dir/file (Shift+Tab cycles back). Enter
   *  still commits — onSubmit unchanged. */
  pathAutofill?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}): Gtk.Widget {
  const config = opts.config
  const m = config.appearance.menu
  const ROW_H_ = m.rowHeight
  const capRadius = Math.min(10, ROW_H_ / 2)

  let hover = false
  let focused = false

  const leading = opts.emoji
    ? new Gtk.Label({ label: opts.emoji })
    : new Gtk.Label({ label: opts.label ?? "" })
  leading.set_halign(Gtk.Align.START)
  leading.set_valign(Gtk.Align.CENTER)
  leading.set_single_line_mode(true)
  leading.set_xalign(0)
  // Centre the leading's INK on the left cap's circle centre (menuRow's
  // pattern, replicated here since inkMarginStart isn't exported).
  const [ink] = leading.get_layout().get_extents() as [Pango.Rectangle, Pango.Rectangle]
  const inkX = ink.x / Pango.SCALE
  const inkW = ink.width / Pango.SCALE
  leading.set_margin_start(Math.max(0, Math.round(ROW_L + 2 + capRadius - ROW_L - inkX - inkW / 2)))
  leading.set_margin_end(12)

  const entry = new Gtk.Entry({ placeholderText: opts.placeholder, hexpand: true })
  entry.set_text(opts.value)
  // Blind Tab-cycling path autofill (pure logic, common/path/autofill).
  const af = opts.pathAutofill ? createPathAutofill({ extract: (t) => t }) : null
  entry.set_alignment(1) // value text right-aligned — label left, value right (GTK 4.22: xalign lives on the GtkEditable interface, exposed as set_alignment — set_xalign doesn't exist)
  entry.set_margin_end(0) // NO extra inset: the row box already carries ROW_R, so the field (and its right-aligned text) sits flush at the row's content edge — the old double inset left the value ~18px short of where the other rows' right-side content ends
  entry.set_has_frame(false) // no theme frame/blue box (code-side)
  entry.add_css_class("menu-entry") // transparent bg + caret/selection colours (style.css)

  // Colour split: the LABEL is pinned to the standard row text colour at all
  // times (never dims/glows — same as every other row's label); only the
  // ENTRY dims at rest and brightens on hover/focus.
  const applyColour = (): void => {
    const c = hover || focused ? m.text : m.mutedText
    entry.set_attributes(pangoAttrs(c, m.fontSize))
    leading.set_attributes(pangoAttrs(m.text, opts.emoji ? m.emojiSize : m.fontSize))
    entry.queue_draw()
    leading.queue_draw()
  }
  applyColour()

  const keyCtrl = new Gtk.EventControllerKey()
  keyCtrl.connect("key-pressed", (_c: any, keyval: number) => {
    if (af) {
      if (keyval === Gdk.KEY_Tab) {
        const r = af.onTab(entry.get_text(), false)
        if (r !== null) {
          entry.set_text(r.text)
          entry.select_region(r.committedLen, r.text.length)
          return true
        }
      } else if (keyval === Gdk.KEY_ISO_Left_Tab) {
        const r = af.onTab(entry.get_text(), true)
        if (r !== null) {
          entry.set_text(r.text)
          entry.select_region(r.committedLen, r.text.length)
          return true
        }
      } else if (keyval === Gdk.KEY_Right || keyval === Gdk.KEY_KP_Right) {
        // Right Arrow locks in the current completion; a dir descends (next
        // Tab scans its children).
        const r = af.onAccept(entry.get_text())
        if (r !== null) {
          entry.set_text(r.text)
          entry.set_position(-1)
          return true
        }
      }
    }
    if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
      opts.onSubmit(entry.get_text())
      return true
    }
    if (keyval === Gdk.KEY_Escape) {
      opts.onCancel()
      return true
    }
    return false
  })
  entry.add_controller(keyCtrl)

  ;(entry as any).connect("notify::has-focus", () => {
    focused = (entry as any).has_focus
    applyColour()
  })

  const box = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    halign: Gtk.Align.FILL,
    valign: Gtk.Align.CENTER,
  })
  // Natural width + hexpand: the row stretches to the panel's content width
  // (which grows to fit long values such as the storage path).
  box.set_size_request(1, ROW_H_)
  box.set_hexpand(true)
  box.set_margin_start(ROW_L)
  box.set_margin_end(ROW_R)
  box.append(leading)
  box.append(entry)
  // Width closure for the framework's panelWidthFor: box measure (includes
  // child margins) + the box's OWN ROW_L/ROW_R insets.
  attachRowWidth(box, box, ROW_L, ROW_R)

  const motion = new Gtk.EventControllerMotion()
  motion.connect("enter", () => {
    hover = true
    applyColour()
  })
  motion.connect("leave", () => {
    hover = false
    applyColour()
  })
  box.add_controller(motion)

  return box
}

export function openScreenGrabSettingsMenu(opts: {
  monitor: Gdk.Monitor
  config: AppletConfig
  store: AppletConfigSource
  backend: AppletBackend
}): void {
  const config = opts.config
  const backend = opts.backend
  let ctl: MenuController = null as any
  const rebuild = (): void => ctl.setRows(buildRows())

  const buildRows = (): Gtk.Widget[] => {
    const sg = config.screengrab
    const rows: Gtk.Widget[] = []

    // Storage path — one inline-editable row (emoji + borderless path field).
    rows.push(
      inlineEntryRow({
        config,
        emoji:
          (config.appearance.icons as Record<string, string>).screengrabStorage ?? "Save folder",
        value: sg.dir,
        placeholder: "~/Pictures/ScreenCaptures",
        pathAutofill: true,
        onSubmit: (v) => {
          if (v.trim()) {
            saveScreengrab(config, opts.store, { dir: v.trim() })
            rebuild()
          }
        },
        onCancel: () => rebuild(),
      }),
    )

    // Still format + quality
    rows.push(
      cycleRow(
        config,
        "Still format",
        sg.format === "jpg" ? "JPEG" : "PNG",
        ["PNG", "JPEG"],
        (v) => {
          saveScreengrab(config, opts.store, { format: v === "JPEG" ? "jpg" : "png" })
          rebuild()
        },
      ),
    )
    if (sg.format === "jpg") {
      rows.push(
        inlineEntryRow({
          config,
          label: "JPEG quality",
          value: String(Math.round(sg.jpegQuality)),
          placeholder: "1-100",
          onSubmit: (v) => {
            const n = parseInt(v, 10)
            if (!Number.isNaN(n)) {
              saveScreengrab(config, opts.store, { jpegQuality: Math.max(1, Math.min(100, n)) })
              rebuild()
            }
          },
          onCancel: () => rebuild(),
        }),
      )
    }

    // Video codec + framerate + quality
    rows.push(
      cycleRow(
        config,
        "Video codec",
        sg.codec === "vp9" ? "VP9 (.webm)" : sg.codec === "av1" ? "AV1 (.mp4)" : "H.264 (.mp4)",
        ["H.264 (.mp4)", "VP9 (.webm)", "AV1 (.mp4)"],
        (v) => {
          saveScreengrab(config, opts.store, {
            codec: v.startsWith("VP9") ? "vp9" : v.startsWith("AV1") ? "av1" : "h264",
          })
          rebuild()
        },
      ),
    )
    rows.push(
      inlineEntryRow({
        config,
        label: "Frame rate",
        value: String(Math.round(sg.framerate)),
        placeholder: "fps",
        onSubmit: (v) => {
          const n = parseInt(v, 10)
          if (!Number.isNaN(n)) {
            saveScreengrab(config, opts.store, { framerate: Math.max(1, Math.min(240, n)) })
            rebuild()
          }
        },
        onCancel: () => rebuild(),
      }),
    )
    rows.push(
      cycleRow(
        config,
        "Video quality",
        sg.videoQuality.charAt(0).toUpperCase() + sg.videoQuality.slice(1),
        ["Low", "Medium", "High"],
        (v) => {
          saveScreengrab(config, opts.store, { videoQuality: v.toLowerCase() })
          rebuild()
        },
      ),
    )
    // Audio + hardware encode sit with the video settings so they are visible
    // without scrolling.
    rows.push(
      toggleRow(config, "Record audio", sg.audio, (v) => {
        saveScreengrab(config, opts.store, { audio: v })
        rebuild()
      }),
    )
    rows.push(
      toggleRow(config, "Hardware encode (VAAPI)", sg.hwEncode, (v) => {
        saveScreengrab(config, opts.store, { hwEncode: v })
        rebuild()
      }),
    )
    rows.push(
      menuInfoRow(
        "H.264/VP9/AV1 encode on the AMD iGPU; CPU fallback if the device fails",
        config,
        "mutedText",
      ),
    )

    // Naming template + live example — "Filename" with the template inline
    // (the storage-path pattern).
    rows.push(
      inlineEntryRow({
        config,
        label: "Filename",
        value: sg.nameTemplate,
        placeholder: "capture-%Y%m%d-%H%M%S",
        onSubmit: (v) => {
          if (v.trim()) {
            saveScreengrab(config, opts.store, { nameTemplate: v.trim() })
            rebuild()
          }
        },
        onCancel: () => rebuild(),
      }),
    )
    const dt = GLib.DateTime.new_now_local()
    const stem = (dt.format(sg.nameTemplate) ?? sg.nameTemplate) || "capture"
    const ext = sg.format === "jpg" ? "jpg" : "png"
    rows.push(
      menuInfoRow(
        `Example: ${stem}${stem.toLowerCase().endsWith("." + ext) ? "" : "." + ext}${/%[a-zA-Z]/.test(sg.nameTemplate) ? "" : " (fixed name — overwrites)"}`,
        config,
      ),
    )

    // Toggles
    rows.push(
      toggleRow(config, "Capture cursor (stills)", sg.cursor, (v) => {
        saveScreengrab(config, opts.store, { cursor: v })
        rebuild()
      }),
    )
    rows.push(
      menuInfoRow(
        "Cursor is stills-only — wf-recorder 0.6 has no cursor capture",
        config,
        "mutedText",
      ),
    )
    rows.push(
      toggleRow(config, "Notify on capture", sg.notify, (v) => {
        saveScreengrab(config, opts.store, { notify: v })
        rebuild()
      }),
    )
    rows.push(
      toggleRow(config, "Show dock", sg.showDock, (v) => {
        saveScreengrab(config, opts.store, { showDock: v })
        backend.screengrab.syncShowDock()
        rebuild()
      }),
    )

    // Reset
    rows.push(
      menuRow({
        config,
        text: "Reset to defaults",
        statusColour: "danger",
        onClick: () => {
          const defs = opts.store.getDefaults?.() as AppletConfig | undefined
          if (defs?.screengrab) {
            saveScreengrab(config, opts.store, defs.screengrab)
            backend.screengrab.syncShowDock()
            rebuild()
          }
        },
      }),
    )

    return rows
  }

  ctl = openMenu({
    config,
    kind: SETTINGS_KIND,
    monitor: opts.monitor,
    rows: buildRows(),
  })
}
