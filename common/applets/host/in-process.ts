/**
 * common/applets/host/in-process — the in-process binder for the OS domains.
 *
 * The dock hosts the applets backend (./mount), so its applets read the very
 * domains that process serves: the binder hands the applet mounts the domain
 * module namespaces themselves, with no request round trip, no proxy and no
 * poll on a caller's interval. It satisfies the same `AppletBackend` contract a
 * transported host builds, so no applet call site changes.
 *
 * The two capture domains (`screengrab`, `screengrabNaming`) are NOT part of
 * this binder: the capture driver owns the compositor session and lives in the
 * dock app (`apps/dock/screengrab`), which adds them to this set. The greeter
 * is the other in-process binder, and only for the domains that need no session
 * (apps/greeter/strip/backend.ts) — every other host reaches the domains
 * through a transport proxy.
 */
import type { AppletBackend } from "@common/applets/backend"
import * as battery from "@common/applets/domains/battery"
import * as bluetooth from "@common/applets/domains/bluetooth"
import * as brightness from "@common/applets/domains/brightness"
import * as cpu from "@common/applets/domains/cpu"
import * as fs from "@common/applets/domains/fs"
import * as mediaWindow from "@common/applets/domains/media-window"
import * as mpris from "@common/applets/domains/mpris"
import * as network from "@common/applets/domains/network"
import * as power from "@common/applets/domains/power"
import * as powerProfile from "@common/applets/domains/power-profile"
import * as powerSupplyEvents from "@common/applets/domains/power-supply-events"
import * as system from "@common/applets/domains/system"
import * as tablet from "@common/applets/domains/tablet"
import * as tlp from "@common/applets/domains/tlp"
import * as volume from "@common/applets/domains/volume"
import * as wifi from "@common/applets/domains/wifi"
import * as workspaces from "@common/applets/domains/workspaces"

/** Every domain the applets backend serves, each bound to its module
 *  namespace — the same object a transported host builds from the proxy. */
export function createInProcessBackend(): Omit<AppletBackend, "screengrab" | "screengrabNaming"> {
  return {
    battery,
    bluetooth,
    brightness,
    cpu,
    fs,
    mediaWindow,
    mpris,
    network,
    power,
    powerProfile,
    powerSupplyEvents,
    system,
    tablet,
    tlp,
    volume,
    wifi,
    workspaces,
  }
}
