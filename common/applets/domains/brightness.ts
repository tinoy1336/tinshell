import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GUdev from "gi://GUdev"
import { mkReactive, type Reactive } from "@common/applets/utils/reactive"
import { publishBrightnessRead } from "./brightness-publish"
import { listDir, readFile, readFileAsync } from "./fs"

interface BrightnessDevice {
  name: string
  sysfsPath: string
  maxBrightness: number
}

const devices: BrightnessDevice[] = []

// ── Throttled D-Bus write via logind ──
// Uses a pending-value pattern: always capture latest, write immediately if
// outside the throttle window, otherwise schedule a deferred flush so the
// final value is never lost.
// Uses Gio.DBus.system.call (async) — never blocks the UI.

let lastWrite = 0
const WRITE_THROTTLE_US = 50_000
let pendingSubsystem: string | null = null
let pendingDevice: string | null = null
let pendingRaw: number = 0
let flushId: number | null = null

function doDbusWrite(): void {
  if (!pendingSubsystem || !pendingDevice) return
  try {
    Gio.DBus.system.call(
      "org.freedesktop.login1",
      "/org/freedesktop/login1/session/auto",
      "org.freedesktop.login1.Session",
      "SetBrightness",
      new GLib.Variant("(ssu)", [pendingSubsystem, pendingDevice, pendingRaw]),
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_obj: any, res: any) => {
        try {
          Gio.DBus.system.call_finish(res)
        } catch (e) {
          print(`[brightness] SetBrightness FAILED: ${e}`)
        }
      },
    )
  } catch (e) {
    print(`[brightness] SetBrightness FAILED: ${e}`)
  }
}

function flushDeferred(): boolean {
  lastWrite = GLib.get_monotonic_time()
  doDbusWrite()
  flushId = null
  return GLib.SOURCE_REMOVE
}

function setBrightnessViaLogind(subsystem: string, deviceName: string, rawValue: number): void {
  pendingSubsystem = subsystem
  pendingDevice = deviceName
  pendingRaw = rawValue
  const now = GLib.get_monotonic_time()
  if (now - lastWrite >= WRITE_THROTTLE_US) {
    lastWrite = now
    doDbusWrite()
  } else if (flushId === null) {
    flushId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.ceil(WRITE_THROTTLE_US / 1000),
      flushDeferred,
    )
  }
}

// ── Device discovery ──

function discoverBrightness(): void {
  if (devices.length > 0) return

  const blRoot = "/sys/class/backlight"
  for (const d of listDir(blRoot)) {
    const max = parseInt(readFile(`${blRoot}/${d}/max_brightness`)) || 255
    devices.push({
      name: d,
      sysfsPath: `${blRoot}/${d}`,
      maxBrightness: max,
    })
  }
}

// ── Poll ──

/** The level a process with no readable backlight device answers. */
const PLACEHOLDER_SCREEN = 100

async function readBrightness(): Promise<{ screen: number }> {
  discoverBrightness()
  let screen = PLACEHOLDER_SCREEN
  // Read all device brightnesses concurrently; never block the main loop.
  const raws = await Promise.all(devices.map((dev) => readFileAsync(`${dev.sysfsPath}/brightness`)))
  devices.forEach((dev, i) => {
    const val = parseInt(raws[i])
    if (isNaN(val)) return
    screen = Math.round((val / dev.maxBrightness) * 100)
  })
  return { screen }
}

// ── State ──
// mkReactive instead of ags createPoll: createPoll exposes no setter and its
// timer is subscriber-gated — we need uevent-driven ticks injected between
// the safety-net poll ticks.
/** The screen level. The state a new reactive OPENS at is a placeholder: it is
 *  not a reading, and `./brightness-publish` never publishes it — every value a
 *  subscriber receives comes from a device read. */
type BrightnessState = { screen: number }

// ── Kernel uevent listener (backlight) ──
// Every brightness write — ours via logind, Fn keys, auto-brightness — lands
// in the backlight sysfs class and fires a `change` uevent, so external
// changes now land sub-100ms instead of on the next poll tick. The poll
// (timing.poll.brightness, now a 30s safety net) covers missed uevents.
let _blClient: GUdev.Client | null = null
function ensureBacklightClient(onChange: () => void): void {
  if (_blClient) return
  try {
    _blClient = new GUdev.Client({ subsystems: ["backlight"] })
    _blClient.connect("uevent", (_c: GUdev.Client, _action: string, _dev: GUdev.Device) => {
      onChange()
    })
  } catch (e) {
    print(`[brightness] GUdev init failed: ${e}`)
    _blClient = null
  }
}

let _brightnessState: ReturnType<typeof mkReactive<BrightnessState>> | null = null
export function brightnessState(pollIntervalMs: number): Reactive<BrightnessState> {
  if (!_brightnessState) {
    _brightnessState = mkReactive<BrightnessState>({ screen: PLACEHOLDER_SCREEN })
    let last = PLACEHOLDER_SCREEN
    // The first read publishes on its own account — see `./brightness-publish`.
    let firstRead = true
    const tick = async (): Promise<void> => {
      const bs = await readBrightness()
      if (!publishBrightnessRead(firstRead, devices.length > 0, last, bs.screen)) return
      firstRead = false
      last = bs.screen
      _brightnessState?.set(bs)
    }
    // Safety net (the caller's timing.poll.brightness, now 30s).
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, pollIntervalMs, () => {
      void tick()
      return GLib.SOURCE_CONTINUE
    })
    // Instant path: backlight uevent → immediate read.
    ensureBacklightClient(() => {
      void tick()
    })
    void tick()
  }
  return _brightnessState
}

// ── Public setters ──

export function setScreenBrightness(pct: number): void {
  discoverBrightness()
  for (const dev of devices) {
    const raw = Math.round((pct / 100) * dev.maxBrightness)
    setBrightnessViaLogind("backlight", dev.name, raw)
  }
}
