/**
 * The brightness publish rule — whether a reading from the backlight device
 * reaches the state's subscribers.
 *
 * It lives beside the domain instead of inside it because the domain's exported
 * surface IS the applets backend contract: `AppletBackend.brightness` is
 * `typeof import("./brightness")`, so every value export of that module becomes
 * a member the transport serves and every host — the greeter included — must
 * provide. This rule is a predicate no transport serves, and a probe pins it
 * here directly.
 *
 * Two things publish: the FIRST read of a machine that has a backlight device,
 * and any later read whose level CHANGED.
 *
 * - The first read publishes even when it lands on the placeholder value, because
 *   a consumer's first reading is the baseline it measures the user's adjustments
 *   against. A screen already sitting at 100 % would otherwise publish nothing, so
 *   the consumer would adopt the user's first adjustment AS its baseline and never
 *   paint it.
 * - A machine with no backlight device has no reading to publish: its placeholder
 *   is never published, so a published value always means a device was read — the
 *   distinction the volume domain draws with `available`, drawn here by
 *   publication because the placeholder and a genuine 100 % carry the same number.
 */
export function publishBrightnessRead(
  firstRead: boolean,
  hasDevice: boolean,
  last: number,
  screen: number,
): boolean {
  return (firstRead && hasDevice) || screen !== last
}
