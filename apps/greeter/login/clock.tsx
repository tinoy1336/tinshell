/**
 * Clock — time (large) above date (small), centred at the card top.
 * Formats are strftime keys (appearance.timeFormat / dateFormat); glibc's
 * %-e strips the leading pad ("Sat, Aug 8", no zero).
 *
 * Tick discipline: the labels are filled at CONSTRUCTION
 * and on every MAP (correct at first paint, no blank gap), then refreshed by
 * a plain 1s timeout (GLib.timeout_add, NOT the grouped timeout_add_seconds
 * — its quantization can show a stale clock across suspend/resume).
 */

import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"
import { get } from "../config"

export default function Clock(): Gtk.Box {
  let box!: Gtk.Box
  let timeLabel!: Gtk.Label
  let dateLabel!: Gtk.Label
  const tick = (): boolean => {
    const now = GLib.DateTime.new_now_local()
    timeLabel.label = now.format(get<string>("appearance.timeFormat", "%H:%M")) ?? ""
    dateLabel.label = now.format(get<string>("appearance.dateFormat", "%a, %b %-e")) ?? ""
    return true
  }
  const el = (
    <box
      class="greeter-clock"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={4}
      $={(self) => {
        box = self
      }}
    >
      <label
        class="greeter-clock-time"
        label=""
        $={(l) => {
          timeLabel = l
        }}
      />
      <label
        class="greeter-clock-date"
        label=""
        $={(l) => {
          dateLabel = l
        }}
      />
    </box>
  )
  void el
  tick()
  el.connect("map", tick)
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, tick)
  return box
}
