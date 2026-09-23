/**
 * GreeterDock — the bottom-centre applet strip on the greeter/lock screen.
 *
 * The strip MOUNTS THE SHARED APPLET RENDERER (`common/applets/surface` — the
 * same one the desktop dock mounts) on the greeter's embedded-widget substrate
 * (./host). Colours, geometry, panel placement, pointer routing, the
 * hidden/appear contract and the backdrop paint (base glass + the bar's lift,
 * a hole at every resting disc, a stadium behind every open panel) are the
 * renderer's; the config it renders is the DOCK'S OWN config (`../../config`
 * `dockConfigView()`), so the strip is not a copy of the dock — it is the
 * dock's renderer in another window. Nothing greeter-local paints an
 * appearance value, a backdrop or a panel.
 *
 * Applet data — TWO sources, picked per domain, because the greeter runs in two
 * very different places:
 *   - the greeter's OWN domains (./backend) are bound IN PROCESS: battery,
 *     brightness, cpu, system, power-profile, tlp read sysfs/proc and the
 *     system bus, which exist BEFORE login (brightness writes go out as
 *     logind `Session.SetBrightness` on the greeter's own session). These serve
 *     the LOGIN screen, where no backend process exists at all;
 *   - the SHARED client proxy over the applets backend's unix socket
 *     (common/applets/backend-socket-client) stays wired for the domains that
 *     describe the SESSION — `mpris` (media/volume) and `mediaWindow` — and is
 *     the same path the locked and preview surfaces use.
 * Either way a DATA cell is parked (out of the row and out of the pointer) until
 * ONE REAL sample exists for it: the socket answers `no-sample` while a push
 * member warms up, and the local probes read the source file, so an applet's
 * seed (or a client placeholder) is never painted as a reading. While a cell is
 * held, and whenever the transport drops, the reason is logged once (never a
 * silent zero). Volume carries no visibility of its own: its cell FOLLOWS the
 * media cell (see FOLLOWS), so the two appear and disappear on the one
 * transport-driven media condition — the media applet's own no-player despawn
 * path (row stub), exactly as in the dock.
 *
 * Visibility contract (config `dock.applets` picks the subset, ordered):
 *   battery → performance → media → volume → brightness → power. The POWER cell
 *   is always present — its actions are direct logind calls (./power-logind)
 *   and must work pre-login, so it ignores the dock's park-in-overflow default.
 *
 * Frost: the strip's glass is frosted by the COMPOSITOR's blur of what is
 * behind the greeter window (the greeter compositor's layer rule for namespace
 * `greeter` in login mode, the user session's global blur in lock/preview) —
 * never by a painted tint. That is why the greeter window stays transparent
 * behind the strip (see GreeterWindow / app.ts).
 */

import GLib from "gi://GLib"
import type { AppletRowLike, AppletWindow } from "@common/applets/applet-window"
import type { AppletBackend } from "@common/applets/backend"
import { createAppletBackendClient } from "@common/applets/backend-client"
import type { Envelope } from "@common/applets/backend-protocol"
import {
  createSocketBackendTransport,
  type SocketBackendTransport,
} from "@common/applets/backend-socket-client"
import mountBattery from "@common/applets/battery"
import mountBrightness from "@common/applets/brightness"
import type { AppletConfig } from "@common/applets/config"
import type { AppletHooks } from "@common/applets/hooks"
import { dockGeometry } from "@common/applets/layout"
import mountMedia from "@common/applets/media"
import mountPerformance from "@common/applets/performance"
import mountPower from "@common/applets/power"
import { createSurfaceApplet } from "@common/applets/surface/applet"
import { type AppletSurface, createAppletSurface } from "@common/applets/surface/surface"
import type { AppletMount } from "@common/applets/types"
import mountVolume from "@common/applets/volume"
import { log } from "@common/log/logger"
import { Gtk } from "ags/gtk4"
import { createRoot } from "gnim"
import { dockConfigView, get } from "../config"
import { greeterLocalDomains, greeterLocalSamples } from "./backend"
import { createGreeterStripHost } from "./host"
import { greeterPower } from "./power-logind"

/** The applets the strip can host, by config name. */
const MOUNTS: Record<string, AppletMount> = {
  battery: mountBattery,
  brightness: mountBrightness,
  media: mountMedia,
  performance: mountPerformance,
  power: mountPower,
  volume: mountVolume,
}

/** Cells with no presence of their own: the named cell decides for both. The
 *  volume control belongs to the playback the media cell already reports, so
 *  ONE condition governs the pair and neither has a second predicate. */
const FOLLOWS: Record<string, string> = { volume: "media" }

/** One cell's first-sample probe. `viaTransport` marks the readings that come
 *  from the session backend — their cell is also gated on the transport being
 *  up, while the greeter's own domains (battery/brightness/performance) keep
 *  serving with the transport down. */
interface SampleProbe {
  /** Named in the hold/release log lines. */
  label: string
  viaTransport: boolean
  probe: () => Promise<Envelope>
}

/**
 * The probe whose FIRST REAL sample proves a DATA cell has a reading: the
 * socket's envelope answers `no-sample` while a push member warms up, and the
 * greeter's own samples read the source file itself, so `ok:true` IS "a sample
 * exists" on either path. Power needs no probe (direct logind), and volume none
 * either: its cell follows the media cell instead of gating on its own reading.
 */
const SAMPLE_PROBE: Record<string, SampleProbe> = {
  battery: { label: "BAT0/capacity", viaTransport: false, probe: greeterLocalSamples.battery },
  brightness: {
    label: "/sys/class/backlight/*/brightness",
    viaTransport: false,
    probe: greeterLocalSamples.brightness,
  },
  performance: {
    label: "/proc/stat + /proc/meminfo",
    viaTransport: false,
    probe: greeterLocalSamples.performance,
  },
  media: {
    label: "mpris mprisState",
    viaTransport: true,
    probe: () => socketTransport.invoke("mpris", "mprisState", []),
  },
}

/** How often a held cell re-asks for its first sample. */
const SAMPLE_RETRY_MS = 800

/** Availability listeners — one per mounted strip (login/lock/preview).
 *  Declared BEFORE the transport below: the transport's `onStateChange`
 *  closure reads it, so a synchronous state change during construction must
 *  not hit the temporal dead zone. */
const availabilityListeners = new Set<(up: boolean) => void>()

/** The applet data path: the backend's unix socket, through the shared client
 *  proxy. Module scope on purpose — the lock screen builds one GreeterDock per
 *  monitor and common/applets/backend-client is one client per host process,
 *  so every instance shares ONE connection. */
const socketTransport: SocketBackendTransport = createSocketBackendTransport({
  onStateChange: (up) => {
    for (const listener of [...availabilityListeners]) {
      // A strip's listener is decoration: a throw here must never break the
      // transport's state update, which every OTHER strip (and the gate that
      // hides the data cells) depends on.
      try {
        listener(up)
      } catch (e) {
        console.error(`[greeter-dock] availability listener failed: ${String(e)}`)
      }
    }
  },
})

/** The applet backend every greeter cell reads. The greeter's own domains
 *  (./backend: battery, brightness, cpu, system, power-profile, tlp plus
 *  the read-only fs) are bound IN PROCESS and override the socket client's
 *  versions — they must answer on the login screen, where no backend process
 *  exists. The socket client still serves the session domains (`mpris`,
 *  `mediaWindow`). `power` is REPLACED, not proxied: its actions are logind
 *  calls the greeter makes itself (see ./power-logind) — no applet data, and
 *  they must work pre-login. */
const greeterAppletBackend = {
  ...createAppletBackendClient({ transport: socketTransport, storeRead: "transport" }),
  ...greeterLocalDomains,
  power: greeterPower,
} as unknown as AppletBackend

/** Subscribe to transport availability. The current value is delivered on
 *  subscribe, so a strip gates its cells without racing the first connect. */
function onDataAvailability(cb: (up: boolean) => void): () => void {
  availabilityListeners.add(cb)
  cb(socketTransport.isUp())
  return () => {
    availabilityListeners.delete(cb)
  }
}

/** One hosted cell: the shared binding + the greeter's visibility inputs. */
interface Cell {
  name: string
  aw: AppletWindow<AppletRowLike>
  /** Dock policy reported through `aw.row` / the hooks (overflow parking,
   *  the media pause grace). Power ignores it — it is never parked here. */
  rowHidden: boolean
  /** The applet's hard kill switch (media with NO player despawns). */
  deactivated: boolean
  /** The greeter's own gate: the required sources are verified AND a real
   *  sample exists (the transport, for the session-bound cells). */
  gate: boolean
  /** True when this cell's reading comes from the session backend, so the
   *  transport going down must park it. The greeter's own readings keep
   *  serving with the backend absent. */
  viaTransport: boolean
  /** The cell whose visibility this one copies, when it has no presence of its
   *  own (volume follows media). A following cell's `gate`/`rowHidden`/
   *  `deactivated` are not consulted — its source's visibility IS its rule. */
  follows?: string
  visible: boolean
}

export default function GreeterDock(
  opts: { getWindow?: () => Gtk.Window | null } = {},
): Gtk.Widget {
  const getWindow = opts.getWindow ?? (() => null)
  const view = dockConfigView()
  if (!view) {
    // No dock config to render: the alarm is logged by dockConfigView(). The
    // card is decoration-independent — the caller keeps it.
    return new Gtk.Box()
  }
  const config: AppletConfig = view.config

  // The strip is ALWAYS a bottom-centre dock (the greeter layout, not the
  // desktop dock's configured position — panels grow upward from it).
  const geometry = dockGeometry("bottom-middle", config)
  const iconSize = config.layout.iconSize
  const spacing = config.layout.spacing
  const appletNames: string[] = get("dock.applets", [
    "battery",
    "performance",
    "media",
    "volume",
    "brightness",
    "power",
  ])

  const host = createGreeterStripHost({
    getWindow,
    marginBottom: get("dock.marginBottom", 8),
  })
  const container = host.container
  const surface: AppletSurface = createAppletSurface({ geometry, config, host })

  const stops: (() => void)[] = []
  let disposeScope: (() => void) | null = null

  createRoot((dispose) => {
    disposeScope = dispose
    const cells = new Map<string, Cell>()

    /** Repack the VISIBLE cells contiguously (the dock row's slot model): a
     *  hidden cell keeps no slot in the row — otherwise the pill would span
     *  the gaps its parked cells leave (a wide stadium with an empty middle)
     *  instead of the dock's compact visible-only strip. Visibility changes
     *  are rare (a player appearing, a despawn), so one placement + settle per
     *  change is enough; this substrate has no slot animations. */
    const repack = (): void => {
      let slot = 0
      for (const name of appletNames) {
        const cell = cells.get(name)
        if (!cell?.visible) continue
        surface.setSlot(name, slot)
        slot += iconSize + spacing
      }
      surface.settle()
    }

    /** The one visibility state machine: dock policy (row hidden /
     *  deactivated) AND the greeter gate, applied as the renderer's park /
     *  reveal contract (unpark + replay the appear, exactly like the dock
     *  row's unhide paths). */
    const applyVisibility = (cell: Cell): void => {
      const visible = cell.follows
        ? (cells.get(cell.follows)?.visible ?? false)
        : !cell.rowHidden && !cell.deactivated && cell.gate
      if (visible !== cell.visible) {
        cell.visible = visible
        if (visible) {
          cell.aw.setHiddenState(false)
          repack()
          void cell.aw.playAppear(false)
        } else {
          cell.aw.setHiddenState(true)
          repack()
        }
      }
      // A following cell copies this one in the SAME step — that is what keeps
      // the pair on one condition with no second trigger to drift from it.
      for (const other of cells.values()) {
        if (other.follows === cell.name) applyVisibility(other)
      }
    }

    // Row stub: the shared applet core pokes the host's row for overflow /
    // despawn policy. The greeter has no overflow; parking and deactivation
    // map onto the same cell state the hooks write.
    const row = {
      setAppletHidden: (name: string, hidden: boolean) => setRowHidden(name, hidden),
      setAppletDeactivated: (name: string, v: boolean) => setDeactivated(name, v),
      isMoveMode: () => false,
      cursorEnter: (_name: string) => {},
      cursorLeave: (_name: string) => {},
      noteInteraction: (_name: string) => {},
      setPanelOpen: (_name: string, _open: boolean) => {},
    } as unknown as AppletRowLike

    function setRowHidden(name: string, hidden: boolean): void {
      const cell = cells.get(name)
      if (!cell) return
      // The greeter's power cell is not parkable: its actions are direct
      // logind calls and must stay reachable with no backend at all.
      cell.rowHidden = name === "power" ? false : hidden
      applyVisibility(cell)
    }

    function setDeactivated(name: string, v: boolean): void {
      const cell = cells.get(name)
      if (!cell) return
      cell.deactivated = v
      applyVisibility(cell)
    }

    /** Applet policies: the hook surface and the row stub are the same cell
     *  state (parking / deactivation); attention and dock visibility have no
     *  greeter counterpart. */
    const hooksFor = (): AppletHooks => ({
      setAppletHidden: (n, hidden) => setRowHidden(n, hidden),
      setAppletDeactivated: (n, v) => setDeactivated(n, v),
      setAppletAttention: () => {},
      setDockVisible: () => {},
    })

    const mount = (name: string, cell: Cell): void => {
      const mountApplet = MOUNTS[name]
      if (!mountApplet) {
        console.error(`[greeter-dock] unknown applet "${name}" — skipped`)
        return
      }
      mountApplet({
        port: cell.aw,
        hooks: hooksFor(),
        config,
        store: view.source,
        backend: greeterAppletBackend,
      })
    }

    /** One sample probe per cell: idempotent (a re-arm after a transport drop
     *  re-verifies freshness) and always cleanable on teardown. */
    interface ProbeState {
      timer: number | null
      running: boolean
      alarmSent: boolean
      stopped: boolean
    }
    const probes = new Map<string, ProbeState>()

    /** Hold a DATA cell out of the row until a REAL sample exists for it (the
     *  source file read on the greeter's own domains, the backend's envelope on
     *  the session ones); retries while the source is worth re-asking, logs the
     *  reason once. */
    const awaitSample = (name: string, cell: Cell): void => {
      const probe = SAMPLE_PROBE[name]
      if (!probe) return
      let state = probes.get(name)
      if (state?.running) return
      state = { timer: null, running: false, alarmSent: state?.alarmSent ?? false, stopped: false }
      probes.set(name, state)
      const s: ProbeState = state
      const attempt = (): void => {
        if (s.running || s.stopped) return
        s.running = true
        void probe
          .probe()
          .then((env) => {
            s.running = false
            if (s.stopped) return
            if (env.ok) {
              const wasReady = cell.gate
              cell.gate = true
              if (s.alarmSent && !wasReady)
                log(`[greeter-dock] ${name}: first real sample arrived — cell released`)
              applyVisibility(cell)
              return
            }
            if (!s.alarmSent) {
              s.alarmSent = true
              log(
                `[greeter-dock] ${name} held out of the strip: no real sample yet` +
                  ` (${probe.label} → ${env.error.kind}: ${env.error.message})` +
                  ` — a placeholder is never painted as data`,
              )
            }
            s.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAMPLE_RETRY_MS, () => {
              s.timer = null
              attempt()
              return GLib.SOURCE_REMOVE
            })
          })
          .catch((e) => {
            s.running = false
            if (s.stopped) return
            if (!s.alarmSent) {
              s.alarmSent = true
              log(
                `[greeter-dock] ${name} held out of the strip: sample probe failed (${String(e)})`,
              )
            }
            s.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAMPLE_RETRY_MS, () => {
              s.timer = null
              attempt()
              return GLib.SOURCE_REMOVE
            })
          })
      }
      attempt()
    }

    stops.push(() => {
      for (const s of probes.values()) {
        s.stopped = true
        if (s.timer !== null) GLib.source_remove(s.timer)
      }
    })

    /** The strip's availability gate: a cell carries no reading until its
     *  sources are verified AND a real sample exists for it. Only the
     *  SESSION-BOUND cells (media, volume) depend on the transport — the
     *  greeter's own readings keep serving on the login screen, where no
     *  backend exists at all. */
    const applyAvailability = (up: boolean): void => {
      if (!up)
        log(
          "[greeter-dock] applet transport is DOWN — session-bound cells hidden" +
            " (media/volume); the greeter's own readings keep serving",
        )
      for (const cell of cells.values()) {
        if (cell.name === "power") continue
        if (!cell.viaTransport) {
          // Fed by the greeter's own domains: the transport state is not its
          // business, and its first-sample probe is already running.
          applyVisibility(cell)
          continue
        }
        if (!up) cell.gate = false
        applyVisibility(cell)
        if (up && cell.name in SAMPLE_PROBE) awaitSample(cell.name, cell)
      }
    }

    stops.push(onDataAvailability(applyAvailability))

    for (const name of appletNames) {
      if (!MOUNTS[name]) {
        console.error(`[greeter-dock] unknown applet "${name}" — skipped`)
        continue
      }
      const aw = createSurfaceApplet(surface, name)
      aw.row = row
      const cell: Cell = {
        name,
        aw,
        rowHidden: false,
        deactivated: false,
        // Power is always present; every other cell waits for its gate. A
        // FOLLOWING cell ignores gate/rowHidden/deactivated (see Cell.follows).
        gate: name === "power",
        viaTransport: SAMPLE_PROBE[name]?.viaTransport ?? true,
        follows: FOLLOWS[name],
        visible: false,
      }
      cells.set(name, cell)
      // Park first: no cell paints before its gate opens; the repack inside
      // applyVisibility then gives every visible cell its slot.
      aw.setHiddenState(true)
      applyVisibility(cell)

      mount(name, cell)
      if (name !== "power") awaitSample(name, cell)
    }
  })

  // The renderer's map leg: birth intros for the cells already visible + the
  // input-region bookkeeping (a no-op on this substrate).
  const noteMapped = (): void => surface.notifyMapped()
  container.connect("map", noteMapped)
  if (container.get_mapped()) noteMapped()

  container.connect("destroy", () => {
    for (const stop of stops) stop()
    disposeScope?.()
  })

  return container
}
