/**
 * common/applets/shared/battery-status.ts — the battery's sysfs STATUS
 * vocabulary, and the ONE place a status is read as a charger state.
 *
 * A status string is a kernel fact (`Charging`, `Discharging`, `Full`,
 * `Not charging`, or anything else a firmware felt like saying), and several
 * surfaces act on it: the colour policy picks a ring colour by it, the battery
 * applet's fully-charged counter starts on it, the low-warning latch stays
 * silent while charging, and the overflow dial announces a change of it. They
 * all ask this module, so none of them can disagree about what a status MEANS.
 *
 * Pure: no gi, no GTK, no config — a plain-Node probe can drive it.
 */

/** The sysfs statuses that MEAN "AC present, neither charging nor
 *  discharging": `Full` is a topped-out pack, `Not charging` a pack sitting at
 *  (or under) its charge limit. There is no third spelling. */
export function isPluggedIdle(status: string): boolean {
  return status === "Full" || status === "Not charging"
}

/**
 * The charger state a status reports:
 *
 * - `charging` — AC present and the pack is filling (`Charging`);
 * - `plugged` — AC present with the pack going nowhere (`Full` /
 *   `Not charging`), i.e. the charge finished or reached its limit;
 * - `unplugged` — the pack is draining (`Discharging`);
 * - `null` — any other status (`Unknown`, the pre-poll seed, a firmware blip
 *   between reads). No position is taken, so a consumer watching for a
 *   TRANSITION never reads an unreadable status as one.
 */
export type BatteryAcState = "charging" | "plugged" | "unplugged"

export function batteryAcState(status: string): BatteryAcState | null {
  if (status === "Charging") return "charging"
  if (isPluggedIdle(status)) return "plugged"
  if (status === "Discharging") return "unplugged"
  return null
}
