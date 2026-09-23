/**
 * tablet.ts — tablet-mode watchdog for the keyboard.
 *
 * The state machine, device discovery and the python helper live in
 * common/tablet (shared with the dock). This file is the keyboard's
 * ingestion: a long-lived helper child in poll mode — it re-reads the
 * EVIOCGSW switch (the switch device can never emit EV_SW, so a start-time
 * read alone would freeze) plus the accelerometer every 500ms and emits on
 * change, feeding the shared watchdog. The child is refcounted per request:
 * a shell that also hosts the dock runs ONE such loop.
 * fallback: "never-enter" — untrusted
 * accel data can never latch tablet mode on (the keyboard must not appear
 * from sensor noise; the dock uses "switch-only" instead).
 *
 * Subscribers get EDGE-triggered boolean changes (onTabletChange), seeded with
 * the current value at subscribe time; entering tablet mode is debounced
 * (500ms) so the hinge transition settles before the keyboard appears.
 */
import {
  createTabletWatchdog,
  findAccelDevice,
  parseHelperLine,
  probeSwitchDevice,
  spawnHelperStream,
  type TabletOverride,
} from "@common/tablet"

const wd = createTabletWatchdog({ fallback: "never-enter" })

const SWITCH_DEVICE = probeSwitchDevice()
const ACCEL_DEVICE = findAccelDevice()

let started = false

/** Start the tablet switch watcher (idempotent): one long-lived helper in
 *  poll mode — python-side 500ms EVIOCGSW + accel re-read loop, no per-tick
 *  spawning. */
export function startTabletWatchdog(): void {
  if (started) return
  started = true
  spawnHelperStream({
    device: SWITCH_DEVICE,
    accelDevice: ACCEL_DEVICE,
    mode: "poll",
    pollMs: 500,
    onLine: (line) => {
      const st = parseHelperLine(line)
      if (st) wd.applyState(st.sw, st.trusted, st.tilted, st.lu)
    },
  })
}

/** Effective tablet state: the manual override wins, else the latched state. */
export function effectiveTablet(): boolean {
  return wd.effectiveTablet()
}

/** Subscribe to effective tablet-state EDGES; seeds immediately with the
 *  current value. Returns an unsubscribe function. */
export function onTabletChange(cb: (tablet: boolean) => void): () => void {
  return wd.onTabletChange(cb)
}

/** `ags -i shell request "keyboard tablet set <on|off|auto>"` — session-scoped
 *  manual override (also the test lever). */
export function setTabletOverride(v: TabletOverride): void {
  wd.setTabletOverride(v)
}

/** `ags -i shell request "keyboard tablet get"` — introspection. */
export function tabletInfo(): string {
  const s = wd.state()
  return `override=${s.override} switch=${s.switch} tilted=${s.tilted} tablet=${wd.effectiveTablet() ? "yes" : "no"}`
}
