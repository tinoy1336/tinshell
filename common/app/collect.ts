/**
 * common/app/collect — one deferred JavaScript collection, shared.
 *
 * gjs does not collect the wrapper objects behind widgets on its own: creating
 * widgets allocates C-side memory but very few JS bytes, so the engine sees no
 * pressure and the collector never runs. Measured on this machine, a window
 * with forty widgets costs ~100-130 kB per create/present/destroy cycle in a
 * standalone gjs process, and `imports.system.gc()` after each cycle returns
 * it to zero; the same loop under python-gi is flat, so the retention is the
 * gjs binding layer rather than GTK or the app. In the running shell a
 * collection after every card-window close recovers part of the same growth.
 *
 * The collection is DEFERRED to an idle callback and only ONE is ever armed, so
 * a burst of closing windows (an app unloading, a batch of dialogs) costs a
 * single collection rather than one per window. It is armed at PRIORITY_LOW
 * because a collection stops the process: it must run after the close it
 * follows has finished repainting, not in the middle of it.
 */
import GLib from "gi://GLib"

let armed = false

/** Ask for one collection at the next idle moment. Safe to call from a signal
 *  handler; never throws. */
export function scheduleCollect(): void {
  if (armed) return
  armed = true
  GLib.idle_add(GLib.PRIORITY_LOW, () => {
    armed = false
    imports.system.gc()
    return GLib.SOURCE_REMOVE
  })
}
