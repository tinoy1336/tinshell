/**
 * applet.ts — the ONE per-applet binding factory for the shared applet
 * surface (common/applets/surface/surface.ts).
 *
 * A host creates one binding per applet it hosts:
 *
 *   const aw = createSurfaceApplet<DockRow>(surface, name)
 *   aw.row = row            // the host's own row policy object
 *   mountApplet(aw)
 *
 * The binding is substrate-free: the icon widget, its closed-state alignment,
 * the surface entry, the panel attach/detach, the hidden/parked visuals and
 * the birth intro are all surface operations. Everything a host does
 * differently lives in its substrate port (`AppletSurfaceHost`), not here —
 * which is what makes the dock's layer-shell band and the greeter's embedded
 * strip the SAME renderer.
 *
 * Hidden semantics (shared): a parked entry drops `render.intro` to 0, cancels
 * its appear run and leaves the row (setEntryHidden → out of the band and the
 * input region). UNPARKING only restores the entry; the caller replays the
 * appear (`aw.playAppear(false)`) exactly like the dock row's reveal/unhide
 * paths — a host that wants a different hidden visual belongs in the port,
 * not in a second factory.
 *
 * The binding state machine itself (open/teardown flags, the appear channel,
 * can-target seeding, attach/detach orchestration) is the shared
 * `createAppletBinding` in common/applets/applet-window.ts.
 */

import {
  type AppletBindingPort,
  type AppletRowLike,
  createAppletBinding,
  type AppletWindow as SharedAppletWindow,
} from "@common/applets/applet-window"
import { cancelAppear, startAppear } from "@common/applets/utils/appear"
import { geo } from "@common/applets/utils/geo-log"
import { Gtk } from "ags/gtk4"
import type { AppletSurface } from "./surface"

/** Closed icon [halign, valign]: centre on the row axis; pin to the grow edge
 *  on the grow axis (END for bottom/right, START for top/left). */
function iconAlign(surface: AppletSurface): [Gtk.Align, Gtk.Align] {
  const g = surface.dg
  const centre = Gtk.Align.CENTER
  if (g.growAxis === "y") {
    return [centre, g.growDir < 0 ? Gtk.Align.END : Gtk.Align.START]
  }
  return [g.growDir < 0 ? Gtk.Align.END : Gtk.Align.START, centre]
}

/** Build the shared AppletWindow state machine bound to a surface entry.
 *  Generic over the ROW type so each host keeps the row it hands its applets
 *  (the dock its full DockRow; a host with a minimal row the common shape). */
export function createSurfaceApplet<TRow extends AppletRowLike = AppletRowLike>(
  surface: AppletSurface,
  name: string,
): SharedAppletWindow<TRow> {
  const config = surface.config
  const iconSize = config.layout.iconSize
  const [ha, va] = iconAlign(surface)

  geo("applet-binding", {
    pos: surface.dg.position,
    growAxis: surface.dg.growAxis,
    growDir: surface.dg.growDir,
    ha,
    va,
  })

  // The applet icon. The applet assigns its own draw_func. Inside the row the
  // icon is positioned explicitly (fixed coords), so the align only matters
  // while it rides INSIDE a panel overlay.
  const icon = new Gtk.DrawingArea()
  icon.set_size_request(iconSize, iconSize)
  icon.set_content_width(iconSize)
  icon.set_content_height(iconSize)
  icon.set_halign(ha)
  icon.set_valign(va)

  // Birth-intro bookkeeping (per binding): the intro plays once per surface
  // lifetime via the entry's map hook; a park suppresses it so a re-shown
  // entry never flashes.
  let introPlayed = false
  let suppressIntro = false

  const port: AppletBindingPort = {
    name,
    geometry: surface.dg,
    icon,
    getWindow: () => surface.window,
    registerEntry(aw: SharedAppletWindow) {
      // The surface owns the icon's placement + fires the entry's map hook
      // once per surface map. maybePlayIntro plays the birth intro exactly
      // once.
      const maybePlayIntro = (): void => {
        if (!introPlayed && !suppressIntro) {
          introPlayed = true
          void aw.playAppear(false)
        }
      }
      surface.addEntry(name, icon, maybePlayIntro)
    },
    attachOverlay(overlay: unknown) {
      surface.attachPanel(name, overlay as Gtk.Overlay)
      // During open the panel drives the icon via margin along the grow axis,
      // so the icon aligns START on that axis. (Row axis stays centred.)
      if (surface.dg.growAxis === "y") icon.set_valign(Gtk.Align.START)
      else icon.set_halign(Gtk.Align.START)
      ;(overlay as any).add_overlay(icon)
    },
    detachOverlay() {
      const parent = icon.get_parent()
      if (parent && typeof (parent as any).remove_overlay === "function") {
        ;(parent as any).remove_overlay(icon)
      }
      // Restore the closed-state align. No margin cleanup is needed: the
      // icon's position inside the row is explicit (fixed coords), so stale
      // grow-axis margins have nothing to displace — but clear them anyway so
      // no leftover animation value shifts the icon inside any future
      // overlay.
      icon.set_margin_top(0)
      icon.set_margin_start(0)
      const [ha2, va2] = iconAlign(surface)
      icon.set_halign(ha2)
      icon.set_valign(va2)
      surface.detachPanel(name)
    },
    setHidden(hidden: boolean, render) {
      if (hidden) {
        suppressIntro = true
        cancelAppear(icon)
        render.intro = 0
        icon.queue_draw()
        surface.setEntryHidden(name, true)
      } else {
        suppressIntro = false
        surface.setEntryHidden(name, false)
      }
    },
    setInputEmpty: () => {
      surface.setEntrySuppressed(name, true)
    },
    setPointerHandlers: (handlers) => surface.setPointerHandlers(name, handlers),
    addHoverListener: (handlers) => surface.addHoverListener(name, handlers),
    setPanelOh: (oh) => surface.setPanelOh(name, oh),
  }

  // initialIntro: 0 when the appear animation plays the birth intro, 1 when
  // the animation is disabled — the first paint must never be a full-icon
  // flash frame.
  const initialIntro = config.timing.appearAnim > 0 ? 0 : 1

  return createAppletBinding({
    port,
    appear: { startAppear, cancelAppear },
    config,
    initialIntro,
  }) as unknown as SharedAppletWindow<TRow>
}
