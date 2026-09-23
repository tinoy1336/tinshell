/**
 * common/applets/domains/tablet.ts — tablet-mode watchdog (the MACHINE-WIDE ingest).
 *
 * The state machine, device discovery and the python helper live in
 * common/tablet (shared with the keyboard). The helper child is refcounted per
 * request, so when the keyboard is hosted in the same process the two apps feed
 * one python poll loop. This file is the
 * backend's ingestion and its tablet-specific behaviour:
 *
 *   - MANUAL override — `ags -i shell request "dock tablet set on|off|auto"`
 *     (session-scoped, dock/commands/tablet.ts).
 *   - AUTO — HYBRID ingestion: a long-lived python helper watches the switch
 *     device's EV_SW events (instant) WHEN the kernel advertises
 *     SW_TABLET_MODE; otherwise the SAME single helper runs in poll mode —
 *     python re-reads EVIOCGSW every 500ms and emits on change (one permanent
 *     child, zero fork churn — never a fresh interpreter per tick).
 *     fallback: "switch-only" — when the accel trust gate fails (dead/frozen
 *     sensor), the latch follows the raw switch state, so EXIT is always
 *     possible once the switch clears. Never stuck.
 *
 * Hosts consume the effective state through `onTabletChange` (transported as a
 * polled snapshot of the backend's subscriber). The HOST owns the policy that
 * depends on host state — the tablet-mode auto-close of an open applet panel
 * needs the panel-open state and the per-core leave evaluations, both of which
 * live in the host process: common/applets/tablet-panel-close.ts.
 */

import GLib from "gi://GLib"
import { bytesToUtf8 } from "@common/fs/bytes"
import { ignore } from "@common/log/logger"
import {
  createTabletWatchdog,
  findAccelDevice,
  type HelperStream,
  parseHelperLine,
  probeSwitchDevice,
  spawnHelperStream,
} from "@common/tablet"

let started = false

/** The machine-wide latch: the manual override plus the switch/accel latch. */
const wd = createTabletWatchdog({ fallback: "switch-only" })

const IOCTL_DEVICE = probeSwitchDevice()
const ACCEL_DEVICE = findAccelDevice()

/** First input device that ACTUALLY advertises SW_TABLET_MODE (EV_SW
 *  capability), or null — events are only possible on such a device.
 *  Probe: EVIOCGBIT masks (0x80404520 = EV types, +0x03 = switch codes). */
function findEventDevice(): string | null {
  const probe = `import fcntl, os, re
text = open("/proc/bus/input/devices").read()
for block in text.split("\n\n"):
    h = "".join(l for l in block.split("\n") if l.startswith("H:"))
    m = re.search(r"event\\d+", h)
    if not m:
        continue
    d = "/dev/input/" + m.group(0)
    try:
        fd = os.open(d, os.O_RDONLY)
    except OSError:
        continue
    try:
        types = fcntl.ioctl(fd, 0x80404520, b"\\0"*64)
        if not (types[0] & 0x08):  # EV_SW bit
            os.close(fd)
            continue
        sw = fcntl.ioctl(fd, 0x80404520 + 3, b"\\0"*64)
        if sw[0] & 0x20:  # SW_TABLET_MODE bit
            print(d)
            os.close(fd)
            break
    except OSError:
        pass
    os.close(fd)`
  try {
    const [ok, stdout] = GLib.spawn_command_line_sync(`python3 -c ${JSON.stringify(probe)}`)
    if (ok && stdout) {
      const out = bytesToUtf8(stdout).trim()
      return out || null
    }
  } catch (e) {
    ignore("tablet switch probe", e)
  }
  return null
}

const EVENT_DEVICE = findEventDevice()

// ── helper ingestion (long-lived python; NO per-tick spawning) ──

let helper: HelperStream | null = null

function startHelper(device: string, mode: "events" | "poll"): void {
  helper?.stop()
  helper = spawnHelperStream({
    device,
    accelDevice: ACCEL_DEVICE,
    mode,
    pollMs: 500,
    onLine: onStateLine,
  })
}

/** One "SW:0 TRUST:1 TILT:0 LU:0" line → shared watchdog state + latch. */
function onStateLine(line: string): void {
  const st = parseHelperLine(line)
  if (!st) return
  wd.applyState(st.sw, st.trusted, st.tilted, st.lu)
}

/** Subscribe to effective tablet-state changes; seeds immediately with the
 *  current value. Returns an unsubscribe function. */
export function onTabletChange(cb: (tablet: boolean) => void): () => void {
  return wd.onTabletChange(cb)
}

/** Start the tablet switch watcher (idempotent): the helper + the latch. Armed
 *  by this backend's own mount (mount.ts) so a restarted backend resumes the
 *  machine-wide ingest without a host remount; a host's request re-send is a
 *  no-op. The panel auto-close policy lives in the host
 *  (tablet-panel-close.ts) because its inputs and effects are host state. */
export function startTabletWatchdog(): void {
  if (started) return
  started = true
  if (EVENT_DEVICE) {
    startHelper(EVENT_DEVICE, "events")
  } else {
    print("[tablet] no SW_TABLET_MODE-capable device — helper poll mode (EVIOCGSW, emit-on-change)")
    startHelper(IOCTL_DEVICE, "poll")
  }
}

/** `ags -i shell request "dock tablet set <on|off|auto>"` — session-scoped manual override. */
export function setTabletOverride(v: "on" | "off" | "auto"): void {
  wd.setTabletOverride(v)
}

/** `ags -i shell request "dock tablet get"` — introspection for debugging.
 *  The host appends its own panel-close policy state (tablet-panel-close.ts). */
export function tabletInfo(): string {
  const s = wd.state()
  return `override=${s.override} switch=${s.switch} trusted=${s.trusted} tilted=${s.tilted} tablet=${wd.effectiveTablet() ? "yes" : "no"}`
}
