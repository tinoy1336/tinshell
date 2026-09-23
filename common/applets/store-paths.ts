/**
 * Where each applet store's durable file lives — ONE owner for the mapping.
 *
 * The applet domains WRITE these files and `common/applets/backend-client.ts`
 * READS them whenever it runs with the default `storeRead: "file"` (a
 * same-user host that does not host the backend; the greeter reads them over
 * the transport instead). Both sides must agree on the location: a client that
 * resolved a store to the per-user state dir instead of through this mapping
 * would disagree with the domain wherever the store is machine-level (the
 * charge cap), and a write-back of that stale per-user value would overwrite a
 * cap the greeter set.
 *
 * The client deliberately imports NO domain module (a surface bundle must carry
 * no OS-call implementation), so the mapping lives here, beside both.
 */
import { appStateFilePath } from "@common/state"

/** Charge-cap intent. MACHINE-level, not per-user: the pre-login greeter sets
 *  this cap as a different user and cannot read the session user's state dir.
 *  World-readable; written through the scoped `sudo -n tee` rules setup.sh
 *  installs (one per account that may set it). */
export const CHARGE_CAP_FILE = "/var/lib/ags/charge-cap"

/** The fully-charged counter's start time (epoch seconds; 0 = the count is not
 *  running). MACHINE-level for the same reason as the charge cap: the pre-login
 *  greeter paints the same counter and cannot read the session user's state
 *  dir, so a per-user stamp made the login screen count from the moment its
 *  strip mounted. World-readable; only the SESSION side writes it (setup.sh
 *  installs the scoped `sudo -n tee` rule for the session user and leaves it
 *  out of the greeter's rules), because the session host is the one that
 *  observes the pack become idle with a state dir on record. */
export const PLUGGED_SINCE_FILE = "/var/lib/ags/plugged-since"

/** Durable file behind `<domain> <store>`. Defaults to the per-user state file
 *  for the domain; stores that belong to the machine name their own path. */
export function storeFilePath(domain: string, store: string): string {
  if (domain === "battery" && store === "chargeThresholdStore") return CHARGE_CAP_FILE
  if (domain === "battery" && store === "pluggedSinceStore") return PLUGGED_SINCE_FILE
  return appStateFilePath(domain)
}
