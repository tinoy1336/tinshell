/**
 * Per-window Wayland app_id override for Hyprland window
 * rules in the merged shell instance.
 *
 * WHY: in the merged shell (io.Astal.shell) every plain XDG toplevel gets
 * app_id = the GtkApplication id (`io.Astal.shell`), so the per-app
 * Hyprland rules (`notes-float` matching class `io.Astal.notes`, etc.)
 * never match and windows tile instead of floating. Islands are unaffected
 * (their app id already equals the app name).
 *
 * GTK4: `win.get_native()` returns the GtkNative (a Widget) — the Wayland
 * surface is `native.get_surface()` (precedent: notifications/Popups.tsx).
 * The surface is null before realize, so the `map` signal is the safe
 * earliest hook (notes GOTCHA 9 pattern).
 */
import GdkWayland from "gi://GdkWayland?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import { ignore } from "@common/log/logger"

/** Apply `id` as the window's Wayland app_id (WM_CLASS in Hyprland). */
export function setAppId(win: Gtk.Window, id: string): void {
  const apply = (): void => {
    try {
      const surface = win.get_native()?.get_surface() as GdkWayland.WaylandToplevel | null
      if (!surface) return
      // SAFETY: the Wayland surface is a GdkWaylandToplevel at runtime (its
      // GType implements the interface), but gjs may not merge interface
      // methods onto the instance wrapper; the cast only widens the type to
      // probe/call set_application_id, which the prototype fallback also
      // guards with typeof checks.
      const s = surface as unknown as { set_application_id?: (id: string) => void }
      if (typeof s.set_application_id === "function") {
        s.set_application_id(id)
      } else {
        // gjs sometimes fails to merge interface methods onto the instance —
        // call through the interface prototype instead.
        const proto = (GdkWayland.WaylandToplevel as any)?.prototype
        if (proto && typeof proto.set_application_id === "function") {
          proto.set_application_id.call(surface, id)
        }
      }
    } catch (e) {
      // Non-Wayland backend or a pre-realize surface: the app id then comes
      // from the Gtk.Application instead.
      ignore("wayland app-id set", e)
    }
  }
  if (win.get_native()?.get_surface()) apply()
  else win.connect("map", () => apply())
}
