/**
 * common/media/pane.tsx — `createMediaPane`, the shared media preview surface:
 * one selection-driven slot that renders a still image inline and NAMES the
 * kinds it will not render, with an explicit open action for them.
 *
 * SURFACE ONLY. The pane claims no MPRIS identity, starts no playback, opens no
 * audio device and holds no GStreamer pipeline. A pane that autoplayed the clip
 * a user merely arrowed past would take the media applet, the transport and the
 * speakers for a file nobody asked to play — so video and audio draw their kind
 * glyph plus an explicit open action, and a decoded still texture is the ONE
 * resource the pane ever owns. It is dropped on `setItem(null)`, on the next
 * `setItem()`, and on `dispose()`.
 *
 * THE NATURAL-SIZE DISCIPLINE is why this module exists at all: EVERY paintable
 * bound here is wrapped in `NullIntrinsicPaintable`. Gtk.Picture measures its
 * natural size from the paintable's intrinsic size even with can-shrink=true
 * (can-shrink only clears the minimum), so a raw texture bound onto the picture
 * would resize the toplevel after map and fight the size the host's window rule
 * pins.
 *
 * A still sits at the TOP of the slot: the aspect frame keeps the whole slot
 * but aligns its ratio box to the top (`yalign` 0), so the dead space below the
 * image carries the file's details (`details.ts`) and, for the kinds it will
 * not render, an explicit open action.
 *
 * Geometry and ink arrive as PARAMETERS (`mode`, `appearance`) — the pane reads no
 * config store and carries no stylesheet, so the host keeps owning both. Its slot
 * WIDTH is the host's divider position, so the pane states only its minimum
 * (`PREVIEW_MIN_WIDTH`, the floor the shared divider holds a drag to and folds a
 * narrower pane below) and never a width of its own.
 * Its caption is coloured with Pango attributes for that reason: a per-pane
 * `Gtk.CssProvider` would pile one provider per pane instance onto the display,
 * and an app's stylesheet is applied once per app and never removed.
 * The structure classes (`media-pane`, `media-pane-view`, `media-pane-caption`,
 * `media-pane-glyph`, `media-pane-note`) stay available to a host stylesheet.
 */
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import { log } from "@common/log/logger"
import { isStillImage, mediaKind } from "./classify"
import { loadStill } from "./decode"
import { type DetailRow, fileDetails } from "./details"
import { NullIntrinsicPaintable } from "./paintable"
import { PREVIEW_MIN_WIDTH } from "./preview"

/** MDI glyphs for the kinds the pane does not render, plus the undecodable
 *  case. Codepoints sit above the BMP — the escapes MUST carry braces. */
const GLYPH = {
  image: "\u{f021f}", // md-file_image
  video: "\u{f022b}", // md-file_video
  audio: "\u{f0223}", // md-file_music
  folder: "\u{f024b}", // md-folder
  file: "\u{f0214}", // md-file
} as const

/** "pane" = a fixed-width side slot beside the host's list; "full" = the pane
 *  fills the slot the host gives it (the host hides its list). */
export type MediaPaneMode = "pane" | "full"

/** The host's ink values, the way an applet mount receives its config. */
interface MediaPaneAppearance {
  /** The host's card ink (`appearance.textColour`); the glyph, the kind note
   *  and the caption take their alpha steps from it. */
  textColour: string
  /** Caption base size in px (`appearance.fontSize`). */
  fontSize: number
  /** Placeholder glyph size in px (`appearance.iconSize`); the glyph draws at
   *  twice this. */
  iconSize: number
}

interface MediaPaneOptions {
  appearance: MediaPaneAppearance
  mode: MediaPaneMode
  /** The explicit open action for the items the pane does not render (video,
   *  audio, folders, anything undecodable). */
  onOpen: (path: string) => void
}

export interface MediaPane {
  /** The pane itself — the host places it and sets its visibility. */
  widget: Gtk.Box
  /** Render `path`, or clear the pane when null. Always releases the previous
   *  item BEFORE the new one is decoded. */
  setItem(path: string | null): void
  /** Re-apply the host's live layout config. */
  setLayout(mode: MediaPaneMode): void
  /** Release the item and make the pane inert. Idempotent. The widget stays
   *  parented — placement belongs to the host. */
  dispose(): void
}

export function createMediaPane(opts: MediaPaneOptions): MediaPane {
  const { appearance, onOpen } = opts
  let dead = false
  let current: string | null = null

  const picture = new Gtk.Picture({ hexpand: true, vexpand: true, can_shrink: true })
  picture.set_content_fit(Gtk.ContentFit.CONTAIN)
  picture.add_css_class("media-pane-view")
  picture.set_visible(false)

  // CONTAIN scales against the paintable's INTRINSIC size, and every paintable
  // bound here is wrapped in NullIntrinsicPaintable, which reports zero — so
  // left to itself the picture stretches the texture into whatever box it is
  // given. The aspect frame supplies the ratio from the still's own pixel size,
  // so the wrapper's zero stops mattering and the window-sizing discipline it
  // exists for is preserved.
  const aspect = new Gtk.AspectFrame({ ratio: 1, obey_child: false, hexpand: true, vexpand: true })
  aspect.add_css_class("media-pane-frame")
  // Top-align the ratio box inside the slot. Without this the frame centres it
  // and the image floats mid-pane with a band above and below.
  aspect.set_yalign(0)
  aspect.set_visible(false)
  aspect.set_child(picture)

  const glyph = new Gtk.Label({ halign: Gtk.Align.CENTER })
  glyph.add_css_class("media-pane-glyph")
  glyph.set_attributes(inkAttrs(appearance.textColour, 0.4, Math.round(appearance.iconSize * 2)))

  const note = new Gtk.Label({ halign: Gtk.Align.CENTER })
  note.add_css_class("media-pane-note")
  note.set_attributes(inkAttrs(appearance.textColour, 0.5, noteSize(appearance.fontSize)))

  const placeholder = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 8,
    hexpand: true,
    vexpand: true,
    valign: Gtk.Align.CENTER,
  })
  placeholder.append(glyph)
  placeholder.append(note)

  const view = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true })
  view.append(aspect)
  view.append(placeholder)

  const caption = new Gtk.Label({
    xalign: 0,
    hexpand: true,
    single_line_mode: true,
    ellipsize: Pango.EllipsizeMode.END,
  })
  // A long file name must not set the pane's width: the label's natural width
  // is capped, and hexpand hands it the slot's real width to ellipsize into.
  caption.set_max_width_chars(8)
  caption.add_css_class("media-pane-caption")
  caption.set_attributes(inkAttrs(appearance.textColour, 0.65, noteSize(appearance.fontSize)))

  // The detail rows below the preview. Both columns are ellipsized AND width-
  // capped: a label's minimum is its full text otherwise, so an uncapped label
  // column would set the pane's width and drag the host's toplevel with it.
  const details = new Gtk.Grid({ column_spacing: 10, row_spacing: 2, hexpand: true })
  details.add_css_class("media-pane-details")
  details.set_visible(false)

  function setDetails(rows: DetailRow[]): void {
    let child = details.get_first_child()
    while (child) {
      const next = child.get_next_sibling()
      details.remove(child)
      child = next
    }
    rows.forEach((row, index) => {
      const label = new Gtk.Label({
        xalign: 0,
        single_line_mode: true,
        ellipsize: Pango.EllipsizeMode.END,
      })
      label.set_max_width_chars(6)
      label.add_css_class("media-pane-detail-label")
      label.set_attributes(inkAttrs(appearance.textColour, 0.45, noteSize(appearance.fontSize)))
      label.label = row.label
      const value = new Gtk.Label({
        xalign: 0,
        hexpand: true,
        single_line_mode: true,
        ellipsize: Pango.EllipsizeMode.END,
      })
      value.set_max_width_chars(10)
      value.add_css_class("media-pane-detail-value")
      value.set_attributes(inkAttrs(appearance.textColour, 0.75, noteSize(appearance.fontSize)))
      value.label = row.value
      details.attach(label, 0, index, 1, 1)
      details.attach(value, 1, index, 1, 1)
    })
    details.set_visible(rows.length > 0)
  }

  const openBtn = new Gtk.Button({ label: "open" })
  openBtn.add_css_class("card-action")
  openBtn.add_css_class("card-primary")
  openBtn.set_tooltip_text("open this item")
  openBtn.connect("clicked", () => {
    if (current) onOpen(current)
  })

  const actionRow = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 6,
    halign: Gtk.Align.CENTER,
    hexpand: true,
  })
  actionRow.append(openBtn)
  actionRow.set_visible(false)

  const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, vexpand: true })
  root.add_css_class("media-pane")
  root.append(view)
  root.append(caption)
  root.append(details)
  root.append(actionRow)

  /** Unbind the picture: the texture reference goes with the wrapper, so no
   *  decoded pixel data outlives the item that named it. */
  function release(): void {
    picture.set_paintable(null)
    picture.set_visible(false)
    aspect.set_visible(false)
    setDetails([])
  }

  function showPlaceholder(glyphChar: string, noteText: string): void {
    glyph.label = glyphChar
    note.label = noteText
    placeholder.set_visible(true)
  }

  function setItem(path: string | null): void {
    if (dead) return
    release() // always before the new item: one decoded still at a time
    if (!path) {
      current = null
      showPlaceholder(GLYPH.file, "nothing selected")
      caption.label = ""
      setDetails([])
      actionRow.set_visible(false)
      return
    }
    current = path
    const name = GLib.path_get_basename(path)
    const kind = mediaKind(path)
    // The name is the one fact every kind has, so it is the caption in all
    // cases; the pixel size and everything else reads as a detail row.
    caption.label = name
    if (isStillImage(path)) {
      try {
        const img = loadStill(path)
        picture.set_paintable(new NullIntrinsicPaintable(img.texture))
        aspect.set_ratio(img.width / img.height)
        aspect.set_visible(true)
        picture.set_visible(true)
        placeholder.set_visible(false)
        // The browser already names the file twice (the selected row and the
        // status bar), so the detail rows carry what it cannot: the pixel size.
        setDetails(fileDetails(path, kind, { width: img.width, height: img.height }))
        actionRow.set_visible(false)
        log(`[preview] ${name} ${img.width}x${img.height}`)
        return
      } catch (e) {
        // A file the media-kind table accepts but Gdk cannot decode (a broken
        // or truncated still) is a preview failure, not an app error.
        log(`[preview] ${name}: ${(e as Error).message}`)
        showPlaceholder(GLYPH.image, "cannot preview")
        caption.label = name
        setDetails(fileDetails(path, kind))
        actionRow.set_visible(true)
        return
      }
    }
    if (GLib.file_test(path, GLib.FileTest.IS_DIR)) showPlaceholder(GLYPH.folder, "folder")
    else if (kind === "video") showPlaceholder(GLYPH.video, "video")
    else if (kind === "audio") showPlaceholder(GLYPH.audio, "audio")
    else showPlaceholder(GLYPH.file, "no preview")
    setDetails(fileDetails(path, kind))
    actionRow.set_visible(true)
  }

  function setLayout(mode: MediaPaneMode): void {
    const full = mode === "full"
    root.set_hexpand(full)
    // The pane's MINIMUM SIZE (`PREVIEW_MIN_WIDTH`), not its width: the slot
    // width is the host's divider position, and a size request above the floor
    // would pin the divider and make a fold impossible. The floor is what the
    // shared divider holds a drag to, so both read the same constant.
    // Nothing inside may report a larger natural size either, or the pane drives
    // the toplevel past the size the host's window rule pinned (see the
    // null-intrinsic note above).
    root.set_size_request(full ? -1 : PREVIEW_MIN_WIDTH, -1)
  }

  function dispose(): void {
    if (dead) return
    dead = true
    current = null
    release()
  }

  setLayout(opts.mode)
  setItem(null)
  return { widget: root, setItem, setLayout, dispose }
}

/** Caption / kind-note size: one step below the host's body font, floored so a
 *  small config cannot render the line illegible. */
function noteSize(fontSize: number): number {
  return Math.max(fontSize - 3, 10)
}

/** Pango attributes for one line of the pane's ink — the same foreground +
 *  alpha + absolute-size shape the menu labels use. A colour the host states
 *  wrong falls back to the card scrim instead of throwing. */
function inkAttrs(colour: string, alpha: number, sizePx: number): Pango.AttrList {
  const rgba = new Gdk.RGBA()
  if (!rgba.parse(colour)) rgba.parse("#0a0c11")
  const attrs = new Pango.AttrList()
  attrs.insert(
    Pango.attr_foreground_new(
      Math.round(rgba.red * 65535),
      Math.round(rgba.green * 65535),
      Math.round(rgba.blue * 65535),
    ),
  )
  attrs.insert(Pango.attr_foreground_alpha_new(Math.round(alpha * 65535)))
  attrs.insert(Pango.attr_size_new_absolute(Math.round(sizePx * Pango.SCALE)))
  return attrs
}
