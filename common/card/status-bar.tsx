/**
 * common/card/status-bar.tsx — the `card-statusbar` row of the card family:
 * one left-aligned `card-status` line for the window's own reporting (item
 * counts, free space, zoom, unsaved state) and for its error line.
 */
import Gtk from "gi://Gtk?version=4.0"

export interface CardStatusBar {
  /** The status row — appended to the frame's root, below the body. */
  widget: Gtk.Box
  /** Replace the status line's text. */
  setText: (text: string) => void
}

export function createCardStatusBar(): CardStatusBar {
  let label!: Gtk.Label
  // gnim types an intrinsic element as GObject.Object; the factory builds the
  // real widget, so the JSX result is narrowed to its GTK type.
  const widget = (
    <box class="card-statusbar" hexpand orientation={Gtk.Orientation.HORIZONTAL}>
      <label
        class="card-status"
        halign={Gtk.Align.START}
        xalign={0}
        hexpand
        $={(ref) => {
          label = ref
        }}
      />
    </box>
  ) as Gtk.Box

  return {
    widget,
    setText: (text: string) => {
      label.label = text
    },
  }
}
