/**
 * files preview pane — the browser's selection-following preview: the shared
 * media pane (`common/media/pane`) wired to the ColumnView's selection and to
 * the shared preview preference (`common/media/preview` — the same switch the
 * portal chooser reads, so the two hosts never disagree).
 *
 * This controller owns what the shared pane deliberately does not: whether the
 * pane is on screen at all, where the pane's explicit open action lands, and
 * the item identity that keeps a selection-preserving re-render (every reload
 * rebuilds the row models) from re-decoding a file whose bytes did not change.
 *
 * WHETHER THE PANE IS ON IS THE WINDOW'S OWN SWITCH (`PreviewSession`,
 * `common/media/preview`): the window creates it and hands it in, so two open
 * browsers never move each other's pane and a new window starts from the last
 * applied setting. Only `mode` and `width` are shared state.
 *
 * THE PINNED-SIZE DISCIPLINE: the `files-float` window rule pins the toplevel to
 * `window.width`x`window.height` at map. The listing and the pane share a
 * `Gtk.Paned`, so the DIVIDER owns the actual width — the pane keeps only
 * `PREVIEW_MIN_WIDTH` as a minimum and never reports an intrinsic size of its
 * own (see `common/media/pane`). Dragging the divider persists the measured
 * width into the shared preference. With the shipped 620x390 pin a side pane
 * leaves the listing narrow; pairing it with a larger `window.width` is the
 * intended use.
 */
import Gtk from "gi://Gtk?version=4.0"
import { log } from "@common/log/logger"
import { createMediaPane, type MediaPane } from "@common/media/pane"
import { type PreviewSession, previewSettings } from "@common/media/preview"
import { get as getConfig } from "./config"
import type { DirEntry } from "./fs"

interface FilesPreview {
  /** The pane — the browser's body row places it after the list area. */
  widget: Gtk.Box
  /** Follow the browser selection; null clears the pane. */
  follow(entry: DirEntry | null): void
  /** Re-apply the pane layout: this window's switch for visibility, the shared
   *  preference for the mode. */
  sync(): void
  /** Release the decoded item — the window is going away. */
  dispose(): void
  /** True while the pane owns the body: the list is hidden and its own keynav
   *  is unreachable, so the window's key table covers the selection keys. */
  isFull(): boolean
}

interface PreviewOptions {
  /** The list area the pane sits beside (hidden in `full` mode). */
  list: Gtk.Widget
  /** THIS window's preview switch (the window owns it — it also drives the
   *  header glyph and the shared divider). */
  session: PreviewSession
  /** The explicit open action — files' row open (viewer for a still, the mime
   *  default otherwise, navigate for a folder). */
  onOpen: (entry: DirEntry) => void
}

export function createPreview(opts: PreviewOptions): FilesPreview {
  const a = getConfig("appearance") as {
    textColour: string
    fontSize: number
    iconSize: number
  }
  let current: DirEntry | null = null
  let identity = ""
  let full = false

  const pane: MediaPane = createMediaPane({
    appearance: { textColour: a.textColour, fontSize: a.fontSize, iconSize: a.iconSize },
    mode: previewSettings().mode,
    onOpen: (path) => {
      // The action fires on the item the pane holds; a selection that moved
      // between the paint and the click would open the wrong file.
      if (current && current.path === path) opts.onOpen(current)
      else log(`[preview] open ignored: selection moved off ${path}`)
    },
  })

  function follow(entry: DirEntry | null): void {
    if (!entry) {
      current = null
      identity = ""
      pane.setItem(null)
      return
    }
    // Identity carries size + mtime: a file overwritten in place must re-decode,
    // while the selection-preserving re-render every reload performs must not.
    const next = `${entry.path}\u0000${entry.size}\u0000${entry.modifiedMs}`
    if (next === identity) return
    identity = next
    current = entry
    pane.setItem(entry.path)
  }

  function sync(): void {
    const cfg = previewSettings()
    const active = opts.session.enabled()
    const wasFull = full
    full = active && cfg.mode === "full"
    pane.widget.set_visible(active)
    opts.list.set_visible(!full)
    // The pane's width comes from the host's paned divider; the pane keeps only
    // its own minimum here so the divider can travel and a fold stays possible.
    pane.setLayout(full ? "full" : "pane")
    // The hairline belongs to the side-slot shape only: in full mode the pane
    // IS the body, so a left edge would be a stray line.
    if (full) pane.widget.remove_css_class("media-pane-split")
    else pane.widget.add_css_class("media-pane-split")
    if (!active) {
      // No pane on screen holds no decoded item. `follow` reloads it when the
      // feature is switched back on (the switch re-renders the listing, which
      // re-fires the selection).
      current = null
      identity = ""
      pane.setItem(null)
    }
    if (wasFull && !full) opts.list.child_focus(Gtk.DirectionType.TAB_FORWARD)
  }

  function dispose(): void {
    current = null
    identity = ""
    pane.dispose()
  }

  sync()
  return {
    widget: pane.widget,
    follow,
    sync,
    dispose,
    isFull: () => full,
  }
}
