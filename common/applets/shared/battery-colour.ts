/**
 * The battery colour policy — the ONE place that decides which entry of
 * `appearance.ringColours.battery` a battery reading renders in, and how one
 * reading divides into coloured SEGMENTS.
 *
 * Three surfaces render the same reading under the same thresholds: the battery
 * applet's percentage ring, its over-cap segment, and the overflow clock's
 * charge notches. Keeping both the level mapping and the segmentation here is
 * what stops them from drifting apart.
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
import type { AppletBackend } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import { batteryColour } from "@common/applets/domains/battery"
import { CHARGE_THRESHOLD_KEY } from "@common/applets/store-paths"

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
  const pct = clampPct(state.percentage)
  const level = batteryColour(pct, thresholds)
  const levelColour = level === "yellow" ? colours.warn : level === "red" ? colours.low : colours.ok
  // `plugged` is one key of an OPEN map, so a config written before the token
  // existed (a deployed greeter dock trio) has none: fall back to the level
  // colour rather than painting an undefined entry.
  if (isPluggedIdle(state.status)) return colours.plugged ?? levelColour
  return levelColour
}

/** One coloured span of a battery scale, 0-100 percent, in ascending order.
 *  `kind` says which part of the picture the span is, so a consumer that fades
 *  or re-colours only some of it (the battery applet's ring fades its level arc)
 *  can select without re-deriving the geometry. */
export interface BatteryBand {
  start: number
  end: number
  colour: ConfigColour
  /** `level` — the arc the level/charging/plugged policy colours; `cap` — the
   *  span the pack has still to fill to reach its charge limit; `overcharge` —
   *  the span the pack sits ABOVE its limit. */
  kind: "level" | "cap" | "overcharge"
}

/** A percentage of the pack. */
export function clampPct(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0
}

/** The spans a battery reading paints, split at the machine's charge limit.
 *
 *  `cap` is the limit in percent, or null when there is none to apply — a host
 *  the backend does not serve the intent store to, or a store that has not
 *  answered. An absent limit is UNKNOWN, never 100: the reading then paints one
 *  span, its level colour, with no reserved segment invented for it.
 *
 *  With a limit: below it the reading keeps its level colour and the span up to
 *  the limit is the reserved `cap` colour; ABOVE it — the pack charged past its
 *  own limit — that portion is the charging colour, the blue both surfaces have
 *  always painted there. The level colour is resolved at each span's own END, so
 *  a limit deep inside a level zone colours consistently with the zone. */
export function batteryRingBands(
  state: BatteryReading,
  thresholds: Record<string, number>,
  colours: BatteryRingColours,
  cap: number | null,
): BatteryBand[] {
  const pct = clampPct(state.percentage)
  const levelBand = (end: number): BatteryBand => ({
    start: 0,
    end,
    colour: batteryRingColour({ percentage: end, status: state.status }, thresholds, colours),
    kind: "level",
  })
  if (cap === null) return [levelBand(pct)]
  const capPct = clampPct(cap)
  if (capPct > pct) {
    const bands = [levelBand(pct)]
    // `cap` is an OPEN map key too: a config without it paints the level colour
    // alone rather than an undefined colour (`plugged`'s own fallback).
    if (colours.cap) bands.push({ start: pct, end: capPct, colour: colours.cap, kind: "cap" })
    return bands
  }
  if (pct > capPct) {
    return [
      levelBand(capPct),
      { start: capPct, end: pct, colour: colours.charging, kind: "overcharge" },
    ]
  }
  return [levelBand(pct)]
}

/** The machine's charge limit, in percent, or null while the intent store holds
 *  none. `get` is the read (never `ready`): a transport-read store only fetches
 *  on a get, so probing readiness alone can never answer. A store that has not
 *  answered is UNKNOWN, not a limit. */
export function configuredChargeCap(battery: AppletBackend["battery"]): number | null {
  const v = battery.chargeThresholdStore.get(CHARGE_THRESHOLD_KEY)
  return typeof v === "number" && Number.isFinite(v) ? clampPct(v) : null
}
