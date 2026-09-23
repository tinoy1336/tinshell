/**
 * The battery colour policy — the ONE place that decides which entry of
 * `appearance.ringColours.battery` a battery reading renders in.
 *
 * Two surfaces show the same reading under the same thresholds: the battery
 * applet's percentage ring and the overflow clock's charge notches. Keeping the
 * mapping here is what stops them from drifting apart.
 *
 * The LEVEL comes from the battery domain's own classifier
 * (`thresholds.batteryWarn` / `batteryLow`). A battery whose sysfs status reads
 * `Charging` takes the charging colour at every level. A PLUGGED battery that is
 * going nowhere — AC present with the pack neither filling nor draining, which
 * sysfs reports as `Full` when topped out and `Not charging` under a charge cap
 * — takes the plugged colour. Every other status keeps its level colour, so a
 * reading the machine does not report as one of those two never claims to be
 * "plugged and idle" (the pre-poll seed's `Unknown` included).
 */
import type { AppletConfig } from "@common/applets/config"
import { batteryColour } from "@common/applets/domains/battery"

/** One `appearance.*` colour entry: RGB channels 0..1 plus alpha. */
export interface ConfigColour {
  rgb: number[]
  alpha: number
}

/** The `appearance.ringColours.battery` entry. Its keys are an open record in
 *  the schema (`charging` / `plugged` / `ok` / `warn` / `low` / `cap`), so the
 *  type comes from the config rather than being restated here. `cap` is the
 *  charge-limit segment, which no level policy selects. */
type BatteryRingColours = AppletConfig["appearance"]["ringColours"]["battery"]

/** The sysfs statuses that MEAN "AC present, neither charging nor discharging".
 *  `Full` is a topped-out pack, `Not charging` a pack sitting under its charge
 *  cap. There is no third spelling: any other status keeps its level colour.
 *
 *  Exported because more than the COLOUR depends on this state — the battery
 *  applet's fully-charged counter runs while it holds — so the rule lives here
 *  instead of being spelt a second time at that call site. */
export function isPluggedIdle(status: string): boolean {
  return status === "Full" || status === "Not charging"
}

/** The reading the policy needs (a full BatteryState carries more). */
interface BatteryReading {
  percentage: number
  status: string
}

/** The colour for a reading: charging, plugged-and-idle, else the level's
 *  warn / low / ok. */
export function batteryRingColour(
  state: BatteryReading,
  thresholds: Record<string, number>,
  colours: BatteryRingColours,
): ConfigColour {
  if (state.status === "Charging") return colours.charging
  const pct = Math.max(0, Math.min(100, state.percentage))
  const level = batteryColour(pct, thresholds)
  const levelColour = level === "yellow" ? colours.warn : level === "red" ? colours.low : colours.ok
  // `plugged` is one key of an OPEN map, so a config written before the token
  // existed (a deployed greeter dock trio) has none: fall back to the level
  // colour rather than painting an undefined entry.
  if (isPluggedIdle(state.status)) return colours.plugged ?? levelColour
  return levelColour
}
