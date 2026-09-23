import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { CHARGE_CAP_FILE, PLUGGED_SINCE_FILE } from "@common/applets/store-paths"
import { mkReactive, type Reactive } from "@common/applets/utils/reactive"
import { bytesToUtf8 } from "@common/fs/bytes"
import type { StateStore } from "@common/state"
import { createPoll } from "ags/time"
import { readFileAsync, writeFileAsync } from "./fs"
import { onPowerSupplyEvent } from "./power-supply-events"

// ── Types ──

export interface BatteryState {
  percentage: number
  wattage: number | null // watts (0 = idle). null only for the pre-poll seed / failed read.
  status: string // sysfs status: "Charging", "Discharging", "Full", "Not charging", "Unknown"
}

export function batteryColour(percentage: number, thresholds: Record<string, number>): string {
  if (percentage <= thresholds.batteryLow) return "red"
  if (percentage <= thresholds.batteryWarn) return "yellow"
  return "green"
}

// ── reactive container ──

type BatteryReactive = Reactive<BatteryState>

let state: BatteryReactive | null = null

// ── Machine-level stores ──

/** A ONE-key store whose value lives in a MACHINE-level file (`/var/lib/tinshell/*`).
 *
 *  A value that both the session and the pre-login greeter read belongs to the
 *  MACHINE, not to one user account: the greeter runs as a different user and
 *  cannot read the session user's state dir, so a per-user store left the value
 *  unreadable there — a cap set before login was UNRECORDABLE (the session's
 *  drift-heal then re-applied its own stale value over it), and the
 *  fully-charged counter restarted at the moment the login screen's strip
 *  mounted. The file is world-readable and is written through the scoped
 *  `sudo -n tee` rule setup.sh installs per account that may write it: an
 *  account with no rule for that path (the pre-login greeter) reads the machine
 *  value but cannot persist one — its write is refused and logged, while the
 *  in-process mirror keeps serving that host's own surface.
 *
 *  The in-process mirror is what makes a set() stick immediately: the caller's
 *  authoritative echo re-reads the value right after writing it, and a read that
 *  had not answered there would look like drift and undo the user's own change.
 *  Fresh reads come from the file, so the mirror never outlives the process.
 *
 *  The file is OBSERVED (Gio.FileMonitor) for as long as the process lives: N
 *  hosts bind these stores at once (the greeter's strip, the dock's applets
 *  backend, the session shell during the lock screen), and the SAME value is set
 *  from any of them. Without the watch a host that loaded the store before
 *  another host's set kept its stale mirror for the rest of its life — the dock
 *  displayed (and drift-healed sysfs towards) the cap the lock screen had
 *  already replaced.
 *
 *  `valid` is the file's whole schema: a value it rejects is refused before any
 *  write, so an out-of-range set costs nothing — a host with no tee rule for
 *  this path never even spawns one. */
function createMachineNumberStore<K extends string>(opts: {
  file: string
  key: K
  valid: (v: unknown) => boolean
}): StateStore<K> {
  const { file, key: KEY, valid } = opts
  let value: number | undefined
  /** Writes THIS process started and has not seen finish. The file is written
   *  by an atomic replace (a sibling temp file renamed onto the path) or by
   *  `tee` (truncate, then fill), so an event landing mid-write can read a
   *  partial document — adopting it would drop the user's own set, and two sets
   *  back to back would surface the first value again between them. */
  let writesInFlight = 0

  /** The file's recorded value, or undefined when it is absent, unreadable,
   *  unparseable or holds no valid value. */
  function readDocument(): number | undefined {
    try {
      const [ok, contents] = GLib.file_get_contents(file)
      if (!ok || !contents) return undefined
      const parsed = JSON.parse(bytesToUtf8(contents)) as Record<string, unknown>
      const v = parsed?.[KEY]
      if (valid(v)) return v as number
    } catch {
      // Missing / unreadable / unparseable = NO recorded value. The caller then
      // treats the store as unset rather than acting on a guessed one.
    }
    return undefined
  }

  function load(): void {
    value = readDocument()
  }

  /** Adopt an EXTERNAL write (another host's set). This process's own set()
   *  stays authoritative: while one of its writes is in flight the file does
   *  not yet hold the value it just answered with. */
  function adoptExternal(): void {
    if (writesInFlight > 0) return
    value = readDocument()
  }

  /** Watch the file for the rest of the process's life — the only way a set
   *  made in ANOTHER host reaches this mirror. The settled events are the ones
   *  that carry a complete document: CHANGED fires while the writer is still
   *  filling the file, and an atomic replace arrives as CREATED/RENAMED (the
   *  temp file renamed onto the path). */
  function observe(): void {
    try {
      const monitor = Gio.File.new_for_path(file).monitor_file(Gio.FileMonitorFlags.NONE, null)
      machineMonitors.push(monitor)
      monitor.connect(
        "changed",
        (
          _m: Gio.FileMonitor,
          _file: Gio.File,
          _other: Gio.File | null,
          event: Gio.FileMonitorEvent,
        ) => {
          if (
            event === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
            event === Gio.FileMonitorEvent.CREATED ||
            event === Gio.FileMonitorEvent.RENAMED ||
            event === Gio.FileMonitorEvent.MOVED_IN ||
            event === Gio.FileMonitorEvent.DELETED
          )
            adoptExternal()
        },
      )
    } catch (e) {
      // A monitor can fail to attach (unwatchable directory): the mirror then
      // keeps mount-time freshness and the failure is reported, never silent.
      print(`[battery] ${file} is not observed: ${e}`)
    }
  }

  load()
  observe()

  return {
    path: () => file,
    get: (key) => (key === KEY ? value : undefined),
    // The file is read synchronously at construction, so the key is answered.
    ready: () => true,
    set(key, v): boolean {
      if (key !== KEY || !valid(v)) {
        print(`[battery] rejected ${KEY}=${JSON.stringify(v)}`)
        return false
      }
      value = v as number
      writesInFlight += 1
      void writeFileAsync(file, `${JSON.stringify({ version: 1, [KEY]: value }, null, 2)}\n`).then(
        (ok) => {
          writesInFlight -= 1
          if (!ok) print(`[battery] ${KEY} write refused — ${file} keeps the previous value`)
        },
      )
      return true
    },
    reload: load,
    dump: () => `${file}\n${KEY}=${value === undefined ? "(unset)" : value}`,
  }
}

/** Module scope so the monitors outlive every call: a GFileMonitor dropped by
 *  the JS GC stops watching. One process, one watcher per store. */
const machineMonitors: Gio.FileMonitor[] = []

/** A charge limit is a percentage of the pack. */
function isPct(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100
}

/** A start time in epoch SECONDS; 0 records "the count is not running". */
function isStamp(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
}

/** The machine's charge limit (percent). The asus_wmi driver resets
 *  charge_control_end_threshold to 100 on every power cycle, so the chosen value
 *  lives HERE and the Battery applet re-applies it whenever sysfs drifts — the
 *  same limit is read and set from the session (dock, lock screen) AND from the
 *  pre-login greeter. */
export const chargeThresholdStore = createMachineNumberStore({
  file: CHARGE_CAP_FILE,
  key: "chargeThreshold",
  valid: isPct,
})

/** When the pack became plugged-and-idle, in epoch SECONDS (0 = the count is
 *  not running) — the start time of the fully-charged counter the battery glyph
 *  paints (`common/applets/battery/charge-counter.ts`). Machine-level because
 *  the pre-login greeter paints the SAME counter over its own strip: a per-user
 *  stamp is unreadable for that user, which made the login screen count from the
 *  moment its strip mounted instead of from the start of the state. The SESSION
 *  side is the writer (setup.sh gives the tee rule to the session user, not to
 *  `greeter`); the greeter reads. */
export const pluggedSinceStore = createMachineNumberStore({
  file: PLUGGED_SINCE_FILE,
  key: "pluggedSince",
  valid: isStamp,
})

// ── sysfs paths (single real battery — BAT0) ──

const BAT0 = "/sys/class/power_supply/BAT0"

/** Poll BAT0's capacity + power_now + status every `timing.poll.batteryPower` ms.
 *  Replaces UPower entirely: upowerd's EnergyRate/Percentage only refresh ~30s
 *  (hardcoded), while the firmware updates these sysfs files ~10s. (UPower's
 *  DisplayDevice PropertiesChanged fires as a payload-less
 *  ping every exactly 30s — 4 events / 2min vs 36 real sysfs changes — so
 *  UPower events are a regression; the sysfs poll stays the value source.)
 *  Idle
 *  (`status` = `Full` / `Not charging`) forces wattage 0 so the icon keeps its
 *  lightning-bolt idle state (Battery.tsx checks wattage === 0). Returns null on
 *  a failed read so the last good state is kept. */
async function pollBattery(): Promise<BatteryState | null> {
  const [cap, power, status] = await Promise.all([
    readFileAsync(`${BAT0}/capacity`),
    readFileAsync(`${BAT0}/power_now`),
    readFileAsync(`${BAT0}/status`),
  ])
  const pct = parseInt(cap)
  if (isNaN(pct)) return null
  const s = status.trim() || "Unknown"
  const uw = parseFloat(power)
  let wattage: number | null
  if (isNaN(uw)) wattage = null
  else if (s === "Full" || s === "Not charging") wattage = 0
  else wattage = uw / 1_000_000 // µW → W
  return {
    percentage: Math.max(0, Math.min(100, pct)),
    wattage,
    status: s,
  }
}

export function batteryState(pollIntervalMs?: number): BatteryReactive {
  if (!state) {
    const rs = mkReactive<BatteryState>({ percentage: 100, wattage: null, status: "Unknown" })
    state = rs
    const interval = pollIntervalMs ?? 2000
    const poll = createPoll<BatteryState | null>(null, interval, pollBattery)
    poll.subscribe(() => {
      const bs = poll.peek()
      if (bs === null || bs === undefined) return
      rs.set(bs)
    })
    // Kernel uevent = instant STATUS flips (AC plug/unplug, warning levels);
    // the kernel never uevents during steady discharge, so continuous
    // values stay on the 2s poll above. On uevent, do an immediate read so
    // Charging↔Discharging lands sub-100ms instead of ≤2s.
    onPowerSupplyEvent(() => {
      void pollBattery().then((bs) => {
        if (bs) rs.set(bs)
      })
    })
  }
  return state
}
