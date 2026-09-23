/**
 * common/applets/domains/power-supply-events.ts — kernel uevent listener for
 * /sys/class/power_supply, shared by the Battery applet (instant status
 * flips) and the charge-threshold healer (instant drift detection).
 *
 * The kernel emits a `change` uevent on a power_supply device on the
 * transitions that matter visually — AC plug/unplug (Charging ↔ Discharging
 * ↔ Full), warning-level crossings, and charge_control_* threshold writes —
 * but NEVER during steady discharge (0 uevents in
 * 60s while BAT0 discharged at 12-20W; continuous energy_now/power_now
 * updates carry no uevent). Consumers therefore keep their existing value
 * polls and use this signal purely as the instant-transition path.
 *
 * One GUdev.Client for the whole process (the shell aggregates every applet) —
 * subscribers multiplex on a single set. GUdev is gi-loaded, no deps.
 */

import GUdev from "gi://GUdev"

export type PowerSupplyListener = (action: string, deviceName: string) => void

const listeners = new Set<PowerSupplyListener>()
let client: GUdev.Client | null = null

function ensureClient(): GUdev.Client | null {
  if (client) return client
  try {
    client = new GUdev.Client({ subsystems: ["power_supply"] })
    client.connect("uevent", (_c: GUdev.Client, action: string, dev: GUdev.Device) => {
      const name = dev.get_name()
      if (!/BAT|AC/.test(name)) return
      for (const fn of listeners) {
        try {
          fn(action, name)
        } catch (e) {
          print(`[power-supply-events] listener threw: ${e}`)
        }
      }
    })
  } catch (e) {
    print(`[power-supply-events] GUdev client init failed: ${e}`)
    client = null
    return null
  }
  return client
}

/** Subscribe to power_supply uevents. Returns an unsubscribe fn (gnim
 *  onCleanup-compatible). Safe to call before the client exists — the
 *  client is created lazily on first subscriber. */
export function onPowerSupplyEvent(fn: PowerSupplyListener): () => void {
  if (!ensureClient()) return () => {}
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
