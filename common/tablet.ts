/**
 * common/tablet — tablet-mode state core shared by the keyboard and
 * the dock (apps/keyboard/tablet.ts, common/applets/domains/tablet.ts).
 *
 * The watchdog state comes from TWO sources:
 *
 *   1. MANUAL override — `setTabletOverride("on" | "off" | "auto")`
 *      (session-scoped; also the testing lever).
 *
 *   2. AUTO (default) — a LATCH over the SW_TABLET_MODE switch + the screen
 *      accelerometer. The switch alone is unreliable: it ALSO reads "flipped"
 *      when the laptop is merely ROTATED to portrait. Tablet mode is only
 *      ENTERED when the switch is flipped AND the screen is tilted
 *      off-vertical (the fold signature: folding tilts the screen; a portrait
 *      hold keeps it vertical), then LATCHED — the folded tablet can be held
 *      at any angle. It EXITS only when the switch clears AND the screen is
 *      back to landscape-upright (the unfold signature).
 *
 * When the accelerometer reads garbage (dead/frozen sensor — the magnitude
 * trust gate fails), behaviour is decided by `fallback`:
 *   - "switch-only": the latch follows the raw switch state, so EXIT is always
 *     possible once the switch clears. Never stuck.
 *   - "never-enter": tilt/latch inputs are treated as false — tablet mode can
 *     never be ENTERED from untrusted accel data.
 *
 * ALL watchdog state lives in the factory closure — the keyboard and the dock
 * run in ONE shell bundle, so module-scope state would collide across apps.
 *
 * Ingestion is shared per REQUEST instead: the machine-wide switch is the same
 * device for every app, so two identical helper requests in one process attach
 * to a single child (see spawnHelperStream) rather than forking the same poll
 * loop twice.
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { bytesToUtf8 } from "@common/fs/bytes"
import { ignore } from "@common/log/logger"

export type TabletOverride = "on" | "off" | "auto"

type TabletListener = (tablet: boolean) => void

type TabletFallback = "switch-only" | "never-enter"

/**
 * The tablet helper. Long-lived python, TWO modes:
 *
 *   - Opens argv[1] (the switch device), reads SW_TABLET_MODE via EVIOCGSW
 *     (0x8010451b, bit 0x2) — the start-time read, which seeds the first line
 *     and every EVENT-mode reading — then prints
 *     "SW:<0|1> TRUST:<0|1> TILT:<0|1> LU:<0|1>" where TILT/LU are the
 *     accelerometer fold-tilt / landscape-upright signatures and TRUST is the
 *     accel magnitude sanity gate (~0.4–2.6 g raw; garbage readings from a
 *     frozen sysfs / dead sensor are rejected so the latch can never depend
 *     on noise).
 *   - argv[2] starts with "poll" ("poll" or "poll:<interval-seconds>"):
 *     POLL-LOOP mode — for machines whose switch device holds EVIOCGSW state
 *     but declares NO EV_SW capability (it can never emit events, so the
 *     start-time switch read must be refreshed by the poll itself or it would
 *     freeze for the life of the child). The python process re-reads EVIOCGSW
 *     and the accelerometer every interval and prints one line ONLY when the
 *     state string changes. ONE permanent child instead of a fresh
 *     interpreter per tick — spawning a full python3 from the gjs main loop
 *     4x/second is the fork/exec churn this split avoids.
 *   - otherwise: EVENT mode — BLOCK on input_event reads and print one line
 *     per switch transition, each carrying the accel read at that moment.
 *     Only usable when argv[1] advertises EV_SW; dies on BrokenPipeError when
 *     the parent exits.
 */
export function helperPy(accelDevice: string): string {
  return `import fcntl, os, struct, sys, math, time
fd = None
sw = 0
try:
    fd = os.open(sys.argv[1], os.O_RDONLY)
    buf = fcntl.ioctl(fd, 0x8010451b, b"\\0"*16)
    sw = 1 if struct.unpack("I", buf[:4])[0] & 0x2 else 0
except OSError:
    pass
def rd(a):
    try:
        return int(open("/sys/bus/iio/devices/${accelDevice}/in_accel_%s_raw" % a).read())
    except (OSError, ValueError):
        return 0
def read_sw():
    global sw
    if fd is None:
        return
    try:
        b = fcntl.ioctl(fd, 0x8010451b, b"\\0"*16)
        sw = 1 if struct.unpack("I", b[:4])[0] & 0x2 else 0
    except OSError:
        pass
def state():
    x, y, z = rd("x"), rd("y"), rd("z")
    mag = math.sqrt(x*x + y*y + z*z)
    trust = 1 if 40 < mag < 260 else 0
    tilted = 1 if (trust and abs(z)/mag > 0.5) else 0
    lu = 1 if (trust and abs(y)/mag > 0.7 and abs(z)/mag < 0.5) else 0
    return "SW:%d TRUST:%d TILT:%d LU:%d" % (sw, trust, tilted, lu)
def emit():
    try:
        print(state(), flush=True)
    except (BrokenPipeError, OSError):
        raise SystemExit
if len(sys.argv) > 2 and sys.argv[2].startswith("poll"):
    interval = 0.5
    if ":" in sys.argv[2]:
        try:
            interval = float(sys.argv[2].split(":", 1)[1])
        except ValueError:
            pass
    if fd is None:
        # Switch device not openable (late boot / udev timing) — exit so the
        # parent's 1s respawner retries the open.
        raise SystemExit
    interval = max(interval, 0.05)
    last = None
    while True:
        read_sw()  # the device can never emit EV_SW — refresh the switch each tick
        s = state()
        if s != last:
            last = s
            emit()
        time.sleep(interval)
emit()
while fd is not None:
    data = os.read(fd, 24)
    if len(data) < 24:
        break
    etype, ecode, evalue = struct.unpack_from("HHi", data, 16)
    if etype == 0x03 and ecode == 0x05:  # EV_SW / SW_TABLET_MODE
        sw = evalue
        emit()
`
}

type HelperStreamMode = "events" | "poll"

export interface HelperStream {
  /** Kill the child and disarm respawn. */
  stop(): void
}

/** Spawn ONE long-lived helper child and stream its "SW:… TRUST:…" lines to
 *  onLine. mode "events": python blocks on evdev reads (device must advertise
 *  EV_SW). mode "poll": python re-reads EVIOCGSW + accelerometer every pollMs
 *  and emits on change — for switch devices that can never emit events.
 *  Respawns once per second if the child dies (device gone, python missing);
 *  stop() ends the cycle. A failed spawn is reported through the same path
 *  and retried on the same 1s timer.
 *
 *  SHARED PER REQUEST: two calls with the same mode + devices + pollMs in ONE
 *  process get ONE child and each line reaches every listener — a shell hosts
 *  both the dock and the keyboard, and both watch the same machine switch, so
 *  the second request attaches to the running poll loop instead of forking an
 *  identical python. The child is refcounted: it is stopped when the last
 *  handle releases it, and `onEnd` belongs to the request that started it. */
export function spawnHelperStream(opts: {
  device: string
  accelDevice: string
  mode: HelperStreamMode
  pollMs?: number
  onLine: (line: string) => void
  onEnd?: () => void
}): HelperStream {
  const pollMs = opts.pollMs ?? 500
  const key = `${opts.mode}|${opts.device}|${opts.accelDevice}|${opts.mode === "poll" ? pollMs : 0}`
  let share = helperShares.get(key)
  if (!share) {
    const listeners = new Set<(line: string) => void>()
    share = {
      listeners,
      refs: 0,
      stream: spawnHelperChild({
        device: opts.device,
        accelDevice: opts.accelDevice,
        mode: opts.mode,
        pollMs,
        onLine: (line) => {
          for (const cb of [...listeners]) cb(line)
        },
        onEnd: opts.onEnd,
      }),
    }
    helperShares.set(key, share)
  }
  const entry = share
  entry.listeners.add(opts.onLine)
  entry.refs++
  return {
    stop(): void {
      entry.listeners.delete(opts.onLine)
      entry.refs--
      if (entry.refs > 0) return
      if (helperShares.get(key) === entry) helperShares.delete(key)
      entry.stream.stop()
    },
  }
}

/** Live helper children keyed by the full request. This is the ONE piece of
 *  module-scope state in this file, and it is deliberate: the ingest it guards
 *  is process-wide (one machine switch), while every WATCHDOG keeps its state
 *  in its own factory closure. */
interface HelperShare {
  listeners: Set<(line: string) => void>
  refs: number
  stream: HelperStream
}
const helperShares = new Map<string, HelperShare>()

/** The child manager behind one shared helper request (see
 *  `spawnHelperStream`): owns the subprocess, the line reader and the 1s
 *  respawn timer. */
function spawnHelperChild(opts: {
  device: string
  accelDevice: string
  mode: HelperStreamMode
  pollMs?: number
  onLine: (line: string) => void
  onEnd?: () => void
}): HelperStream {
  const { device, accelDevice, mode, pollMs = 500, onLine, onEnd } = opts
  let child: Gio.Subprocess | null = null
  let stopped = false
  let respawn = 0

  const argv =
    mode === "poll"
      ? ["python3", "-u", "-c", helperPy(accelDevice), device, `poll:${(pollMs / 1000).toFixed(2)}`]
      : ["python3", "-u", "-c", helperPy(accelDevice), device]

  function readLines(dis: Gio.DataInputStream): void {
    dis.read_line_async(
      GLib.PRIORITY_DEFAULT,
      null,
      // @ts-expect-error runtime-correct; TS TS2769 is a @girs typing gap
      (_src: Gio.DataInputStream, res: Gio.AsyncResult) => {
        try {
          // SAFETY: gjs read_line_finish returns a [bytes|null, length] tuple —
          // TS can't express it, the cast is the known gjs ABI.
          const [line] = dis.read_line_finish(res) as unknown as [Uint8Array, number]
          if (line === null) {
            handleEnd()
            return
          }
          if (!stopped) onLine(new TextDecoder().decode(line).trim())
          readLines(dis)
        } catch {
          handleEnd()
        }
      },
    )
  }

  function handleEnd(): void {
    child = null
    if (stopped) {
      onEnd?.()
      return
    }
    // Child died unexpectedly — respawn after a short delay.
    if (respawn) return
    respawn = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      respawn = 0
      spawn()
      return GLib.SOURCE_REMOVE
    })
  }

  function spawn(): void {
    if (stopped || child) return
    try {
      child = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE)
      const pipe = child.get_stdout_pipe()
      if (!pipe) throw new Error("no stdout pipe")
      readLines(Gio.DataInputStream.new(pipe))
    } catch (e) {
      print("[tablet] helper spawn failed:", String(e))
      child = null
      handleEnd()
    }
  }

  spawn()
  return {
    stop(): void {
      stopped = true
      if (respawn) {
        GLib.source_remove(respawn)
        respawn = 0
      }
      if (child) {
        try {
          child.force_exit()
        } catch (e) {
          // The helper already exited — nothing to reap.
          ignore("tablet helper kill", e)
        }
        child = null
      }
    },
  }
}

/** Parse one "SW:x TRUST:x TILT:x LU:x" helper line. Null when malformed. */
export function parseHelperLine(
  line: string,
): { sw: boolean; trusted: boolean; tilted: boolean; lu: boolean } | null {
  const m = line.trim().match(/^SW:(\d) TRUST:(\d) TILT:(\d) LU:(\d)$/)
  if (!m) return null
  return { sw: m[1] === "1", trusted: m[2] === "1", tilted: m[3] === "1", lu: m[4] === "1" }
}

/** The SW_TABLET_MODE switch device ("Asus WMI hotkeys", asus_nb_wmi). Holds
 *  the switch STATE (EVIOCGSW) but declares NO EV_SW capability, so it can
 *  never emit events — used for EVIOCGSW reads only. */
export function probeSwitchDevice(): string {
  try {
    const [ok, contents] = GLib.file_get_contents("/proc/bus/input/devices")
    if (ok && contents) {
      const text = bytesToUtf8(contents)
      for (const block of text.split("\n\n")) {
        if (block.includes('Name="Asus WMI hotkeys"')) {
          const m = block.match(/Handlers=([^\n]+)/)
          if (m) {
            const ev = m[1].match(/event\d+/)
            if (ev) return "/dev/input/" + ev[0]
          }
        }
      }
    }
  } catch (e) {
    ignore("tablet switch-device probe", e)
  }
  return "/dev/input/event15"
}

/** The screen accelerometer ("accel_3d") under /sys/bus/iio. Discovered by
 *  name; falls back to a device exposing in_accel_x_raw, then iio:device2. */
export function findAccelDevice(): string {
  try {
    const dir = GLib.Dir.open("/sys/bus/iio/devices", 0)
    const names: string[] = []
    for (let name = dir.read_name(); name !== null; name = dir.read_name()) names.push(name)
    for (const name of names) {
      const [ok, contents] = GLib.file_get_contents(`/sys/bus/iio/devices/${name}/name`)
      if (ok && contents && bytesToUtf8(contents).trim() === "accel_3d") {
        return name
      }
    }
    for (const name of names) {
      const [ok] = GLib.file_get_contents(`/sys/bus/iio/devices/${name}/in_accel_x_raw`)
      if (ok) return name
    }
  } catch (e) {
    ignore("tablet accel-device probe", e)
  }
  return "iio:device2"
}

interface TabletWatchdogState {
  override: TabletOverride
  switch: boolean
  trusted: boolean
  tilted: boolean
  lu: boolean
  tablet: boolean
}

interface TabletWatchdog {
  /** Effective tablet state: the manual override wins, else the latched state. */
  effectiveTablet(): boolean
  /** Subscribe to effective tablet-state EDGES; seeds immediately with the
   *  current value. Returns an unsubscribe function. */
  onTabletChange(cb: TabletListener): () => void
  /** Session-scoped manual override (also the test lever). */
  setTabletOverride(v: TabletOverride): void
  /** Feed one helper reading (switch / trust gate / tilt / landscape-upright). */
  applyState(sw: boolean, trusted: boolean, tilted: boolean, lu: boolean): void
  /** Introspection snapshot. */
  state(): TabletWatchdogState
}

export function createTabletWatchdog(opts?: {
  fallback?: TabletFallback
  onEffectiveChange?: () => void
}): TabletWatchdog {
  const fallback: TabletFallback = opts?.fallback ?? "switch-only"
  const onEffectiveChange = opts?.onEffectiveChange

  // Manual override (session-scoped).
  let manual: TabletOverride = "auto"
  // Last known SW_TABLET_MODE switch state. NOTE: unreliable alone — it ALSO
  // flips in portrait orientation; it is only a latch input.
  let tabletSwitch = false
  // Accel magnitude sanity gate (set per helper line): false = dead/frozen sensor.
  let accelTrusted = false
  // Screen accelerometer flags (accel_3d): the fold-tilt signature and the
  // landscape-upright signature.
  let tilted = false
  let landscapeUpright = false
  // Latched tablet state (auto mode). Only entered on the fold-tilt signature
  // (switch flipped AND screen tilted off-vertical), only exited on the unfold
  // signature (switch cleared AND landscape-upright). Suppresses the EC's
  // portrait false positive while letting the folded tablet be held at any angle.
  let tablet = false

  type Listener = TabletListener
  const listeners: Listener[] = []
  let lastNotified: boolean | null = null
  let tabletDebounce: number = 0
  const TABLET_DEBOUNCE_MS = 500

  function effectiveTablet(): boolean {
    if (manual === "on") return true
    if (manual === "off") return false
    return tablet
  }

  function latch(): void {
    if (manual !== "auto") return
    if (accelTrusted) {
      // Latch on the accel signatures: enter only on fold-tilt (switch flipped +
      // screen tilted off-vertical), exit only on unfold (switch cleared + screen
      // landscape-upright). Holds at any holding angle in between.
      if (!tablet && tabletSwitch && tilted) tablet = true
      else if (tablet && !tabletSwitch && landscapeUpright) tablet = false
    } else if (fallback === "switch-only") {
      // Accel untrusted (dead/frozen sensor) — switch-only fallback: exit is
      // ALWAYS possible once the switch clears. Never stuck.
      tablet = tabletSwitch
    }
    // fallback "never-enter": untrusted accel can never latch tablet mode on.
  }

  /** Notify subscribers when the effective state value changes. The internal
   *  lastNotified guard makes repeated calls no-ops (edge-triggered). */
  function notifyIfChanged(): void {
    const t = effectiveTablet()
    if (t === lastNotified) {
      // Reverted to the last-notified state before a pending debounce committed
      // — a brief flap. Cancel it.
      if (tabletDebounce) {
        GLib.source_remove(tabletDebounce)
        tabletDebounce = 0
      }
      return
    }
    if (t) {
      // Entering tablet mode — short debounce so the hinge transition settles
      // before consumers react.
      if (tabletDebounce) return
      tabletDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TABLET_DEBOUNCE_MS, () => {
        tabletDebounce = 0
        if (effectiveTablet()) {
          lastNotified = true
          for (const cb of listeners) cb(true)
        }
        return GLib.SOURCE_REMOVE
      })
    } else {
      // Leaving tablet mode — immediate.
      if (tabletDebounce) {
        GLib.source_remove(tabletDebounce)
        tabletDebounce = 0
      }
      lastNotified = false
      for (const cb of listeners) cb(false)
    }
  }

  return {
    effectiveTablet,

    onTabletChange(cb: TabletListener): () => void {
      listeners.push(cb)
      cb(effectiveTablet())
      return () => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
      }
    },

    setTabletOverride(v: TabletOverride): void {
      manual = v
      // Re-evaluate consumers immediately — don't wait for the next reading.
      onEffectiveChange?.()
      notifyIfChanged()
    },

    applyState(sw: boolean, trusted: boolean, tiltedIn: boolean, lu: boolean): void {
      tabletSwitch = sw
      accelTrusted = trusted
      tilted = tiltedIn
      landscapeUpright = lu
      latch()
      // Fires on EVERY reading (consumers re-evaluate timers even when the
      // latched state didn't change); the notification itself stays
      // edge-triggered via the lastNotified guard.
      onEffectiveChange?.()
      notifyIfChanged()
    },

    state(): TabletWatchdogState {
      return {
        override: manual,
        switch: tabletSwitch,
        trusted: accelTrusted,
        tilted,
        lu: landscapeUpright,
        tablet,
      }
    },
  }
}
