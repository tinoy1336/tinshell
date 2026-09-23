/**
 * dock/commands/debug.ts — debugging and introspection subcommands.
 */

import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import { dockGeometry, POSITIONS } from "@common/applets/layout"
import { mapGuardHooksAll } from "@common/applets/shared/create-applet-core"
import { register } from "@common/commands/registry"
import { menuDebugInfo } from "@common/menus/menu-framework"
import { Gtk } from "ags/gtk4"
import { config } from "../config"
import { getDockRows, getDockSurfaces, getDockWindows } from "../Dock"
import { dockState } from "../dock-row"
import { overflowClockHooksAll } from "../Overflow"

// debug state — dump the dock state store (path, version, every key).
register(["dock", "debug", "state"], (_args, res) => {
  res(dockState.dump())
})

register(["dock", "debug", "geo"], handleGeo)

// debug gc — force a synchronous major GC and report RSS before/after.
// Distinguishes a GJS sawtooth (garbage collectable but never collected —
// RSS drops toward baseline) from a rooting leak (RSS stays high).
register(["dock", "debug", "gc"], (_args, res) => {
  const rss = (): string => {
    const ok = GLib.file_get_contents("/proc/self/status")
    if (!ok[0]) return "?"
    const m = imports.byteArray.toString(ok[1]).match(/VmRSS:\s+(\d+) kB/)
    return m ? `${Math.round(parseInt(m[1], 10) / 1024)}MB` : "?"
  }
  const before = rss()
  const t0 = GLib.get_monotonic_time()
  imports.system.gc()
  imports.system.gc()
  const ms = Math.round((GLib.get_monotonic_time() - t0) / 1000)
  const after = rss()
  res(`gc: ${before} -> ${after} (${ms}ms)`)
})

register(["dock", "debug", "windows"], (_args, res) => {
  res(
    getDockRows().length +
      " rows; " +
      getDockWindows()
        .map((aw) => aw.name)
        .join(","),
  )
})

register(["dock", "debug", "redraw"], (_args, res) => {
  for (const aw of getDockWindows()) aw.window.queue_draw()
  res("queued")
})

// Single-surface state dump: band extents + per-applet slot/hidden/panel
// state + the compiled capture region (rect count + extents + whether this
// substrate absorbs the bar band) — ground truth for the input-region +
// capture-lock + resize policy (cross-check against `hyprctl layers -j`, which
// must show ONE dock-pill surface per monitor of band size).
// `region capture <x> <y>` probes the capture lock at a surface position (is
// the point inside the region, and which applet does the router route it to).
register(["dock", "debug", "region"], (args, res) => {
  const surfaces = getDockSurfaces()
  if (surfaces.length === 0) {
    res("no dock surfaces (not built yet?)")
    return
  }
  if (args[0] === "capture") {
    const x = Number(args[1])
    const y = Number(args[2])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      res("usage: dock debug region capture <x> <y>")
      return
    }
    res(
      surfaces
        .map((s, i) => {
          const c = s.captureAt(x, y)
          return `[surface ${i}] capture(${x},${y}) captured=${c.captured} applet=${c.applet ?? "none"}`
        })
        .join("\n"),
    )
    return
  }
  res(surfaces.map((s, i) => `[surface ${i}] pos=${s.dg.position} ${s.debugInfo()}`).join("\n"))
})

register(["dock", "debug", "menu"], (_args, res) => {
  res(menuDebugInfo())
})

// debug focus — every dock layer window with its compositor keyboard-focus
// state and its keyboard-interactivity mode. A layer surface whose
// interactivity is not NONE takes the seat's keyboard focus the moment it
// maps (Hyprland CLayerSurface::onMap), so a dock surface that reports
// focused=true while the user is working elsewhere has stolen their keys.
// `active` is Gtk.Window.is_active (the Gdk.Toplevel FOCUSED state), i.e. the
// compositor's answer, not ours.
register(["dock", "debug", "focus"], (_args, res) => {
  const tops = (Gtk.Window as any).get_toplevels()
  const lines: string[] = []
  for (let i = 0; i < tops.get_n_items(); i++) {
    const win = tops.get_item(i) as any
    const ns = win?.namespace
    if (!ns) continue
    const surf = win.get_surface?.()
    const state = typeof surf?.get_state === "function" ? surf.get_state() : undefined
    const focused =
      state !== undefined && state !== null ? !!(state & Gdk.ToplevelState.FOCUSED) : null
    lines.push(
      `${ns} keymode=${win.keymode} focused=${focused} isActive=${!!win.is_active} mapped=${win.get_mapped?.()}`,
    )
  }
  res(lines.join("\n") || "no dock windows")
})

type Respond = (response: string) => void

function handleGeo(_args: string[], res: Respond): void {
  const lines: string[] = []
  for (const p of POSITIONS) {
    const g = dockGeometry(p, config)
    lines.push(
      `${p}: rot=${g.rotation} growDir=${g.growDir} rowAxis=${g.rowAxis} align=${g.rowAlign}`,
    )
  }
  res(lines.join("\n"))
}

//
//   debug overflow                 → per-monitor state dump
//   debug overflow reveal          → force the reveal session open
//   debug overflow mode <auto|show|hide> → switch the overflow mode
//   debug overflow move            → toggle move mode
//   debug overflow move-drag <dx> <dy> → simulate a drag (icon follows, stays)
//   debug overflow move-commit     → simulate the double-click commit (snap)
//   debug overflow snap-info       → dump the per-position snap geometry
//   debug overflow auto <name> <0|1> → set an applet's auto rule (simulates a
//                                      status change, e.g. bluetooth enabled)
//
// Driving the session is otherwise impossible without injecting pointer events
// into the layer surface, so these double as manual test hooks.

register(["dock", "debug", "overflow"], handleOverflow)

function handleOverflow(args: string[], res: Respond): void {
  const rows = getDockRows()
  if (rows.length === 0) {
    res("no dock rows (not built yet?)")
    return
  }
  const [cmd, name] = args
  if (!cmd) {
    res(rows.map((r, i) => `[monitor ${i}] ${r.debugInfo()}`).join("\n"))
    return
  }
  for (const r of rows) {
    switch (cmd) {
      case "reveal":
        r.beginReveal()
        break
      case "mode": {
        const m = name
        if (m !== "auto" && m !== "show" && m !== "hide") {
          res("usage: debug overflow mode <auto|show|hide>")
          return
        }
        r.setMode(m)
        break
      }
      case "move": {
        if (r.isMoveMode()) r.exitMoveMode()
        else r.enterMoveMode()
        break
      }
      case "snap-info":
        res(r.debugSnapInfo())
        return
      case "panel":
        r.forceOpenPanel()
        break
      case "guard": {
        // Map-enter-guard regression probe: `guard` dumps per-window guard
        // state + path counters; `guard repro` replays the synthetic post-map
        // condition (suppressed enter → real motion) through the REAL handler
        // chain. openedByMotion=true means the first-motion hole is live.
        if (name === "repro") {
          res(
            mapGuardHooksAll()
              .map((h) => h.repro())
              .join("\n"),
          )
        } else {
          res(
            mapGuardHooksAll()
              .map((h) => h.snapshot())
              .join("\n"),
          )
        }
        return
      }
      case "move-commit":
        r.commitMove()
        break
      case "dock": {
        const v = name
        if (v !== "0" && v !== "1") {
          res("usage: debug overflow dock <0|1>")
          return
        }
        r.setDockVisible(v === "1")
        break
      }
      case "move-drag": {
        const dx = parseInt(args[1] ?? "", 10)
        const dy = parseInt(args[2] ?? "", 10)
        if (Number.isNaN(dx) || Number.isNaN(dy)) {
          res("usage: debug overflow move-drag <dx> <dy>")
          return
        }
        r.beginMoveDrag()
        r.updateMoveDrag(dx, dy)
        r.endMoveDrag()
        break
      }
      case "auto": {
        const hidden = args[2]
        if (!name || (hidden !== "0" && hidden !== "1")) {
          res("usage: debug overflow auto <name> <0|1>")
          return
        }
        r.setAppletHidden(name, hidden === "1")
        break
      }
      case "route": {
        // Synthetic pointer-route replay through the REAL surface routing
        // (no compositor pointer injection). `route <enter|motion|leave> <x>
        // <y>` — the surface router is per monitor, so a plain `route` dumps
        // the per-surface state snapshots and an event replays on every
        // surface.
        const evt = args[1]
        const surfaces = getDockSurfaces()
        if (!evt) {
          const clock = overflowClockHooksAll()
            .map((h) => {
              const s = h.snapshot()
              return `clk active=${s.active} move=${s.moveMode} rev=${s.revealed} pill=${s.panelToggled} cur=${s.cursorInOverflow} fade=${s.fade.toFixed(2)} reap=${s.reappearPending}`
            })
            .join("\n")
          res(
            (surfaces
              .map((s) => {
                const st = s.routeState()
                return `${st.name} active=${st.active} hover=${st.hoverTarget} bd=[${st.bd}] bandLen=${st.bandLen} bandApplied=[${st.bandApplied}] panels=${JSON.stringify(st.panels)}`
              })
              .join("\n") || "no surfaces") + (clock ? `\n${clock}` : ""),
          )
          return
        }
        if (evt !== "enter" && evt !== "motion" && evt !== "leave") {
          res("usage: debug overflow route <enter|motion|leave> <x> <y>")
          return
        }
        const x = parseFloat(args[2] ?? "")
        const y = parseFloat(args[3] ?? "")
        if (Number.isNaN(x) || Number.isNaN(y)) {
          res("usage: debug overflow route <enter|motion|leave> <x> <y>")
          return
        }
        for (const s of surfaces) s.route(evt, x, y)
        res(surfaces.length > 0 ? `routed ${evt}(${x},${y})` : "no surfaces")
        return
      }
      default:
        res(
          "usage: debug overflow [reveal|mode <auto|show|hide>|move|panel|guard [repro]|move-commit|move-drag <dx> <dy>|dock <0|1>|snap-info|auto <name> <0|1>]",
        )
        return
    }
  }
  res("ok")
}
