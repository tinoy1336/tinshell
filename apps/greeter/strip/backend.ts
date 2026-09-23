/**
 * backend — the greeter's OWN applet domains: the readings that exist
 * before a session does.
 *
 * The applets backend is hosted by the dock, a USER-SESSION process. On the
 * login screen it does not exist at all — a fresh boot hands the greeter
 * session to the user session before the dock starts — so the socket transport
 * (`./Strip`, `common/applets/backend-socket-client`)
 * covers the LOCKED case only. Everything the greeter hosts that does not need
 * a session is therefore bound IN PROCESS here: each of these domains reads a
 * world-readable sysfs/proc file or calls a SYSTEM bus service that is up
 * before login.
 *
 *   battery        /sys/class/power_supply/BAT0/{capacity,status,power_now}
 *   battery cap    /sys/class/power_supply/BAT0/charge_control_end_threshold
 *   brightness     /sys/class/backlight/<dev>/brightness — and the WRITE through
 *                  logind `Session.SetBrightness` on `session/auto`, which
 *                  resolves to THIS process's own session: the greeter's
 *                  session pre-login, the session user's while locked
 *   cpu / system   /proc/stat, /proc/meminfo, /sys/class/hwmon/…, PCI runtime_status
 *   power-profile  `org.freedesktop.UPower.PowerProfiles` (system bus, tlp-pd)
 *   volume         the default sink (AstalWp → the session's WirePlumber), for the
 *                  LOCK screen: lock mode runs this same bundle as the session
 *                  user (`hypridle` lock_cmd), so the sink it reads is the one
 *                  the user hears. Pre-login there is no session audio, so the
 *                  read answers `available: false` and the volume CELL stays
 *                  hidden with the media cell it follows (no player over the
 *                  transport) rather than painting a reading it cannot make
 *
 * Only `mpris` and `mediaWindow` stay on the socket: a player and the user's
 * compositor are session facts and cannot exist before login.
 *
 * The charge cap IS mutable from here (login AND lock). A set needs TWO writes
 * and both escalate through scoped `sudo -n tee` rules: the sysfs attribute
 * itself, and the machine-level intent file the applet heals towards
 * (`/var/lib/tinshell/charge-cap`, owned by the battery domain). setup.sh installs
 * one rule per account and path, so the generic `writeFileAsync` cannot
 * escalate anywhere else. The greeter binds the SAME store the dock does
 * (`chargeThresholdStore`); that is what makes a cap set here stick — a
 * greeter-only sysfs reading left the intent unrecorded, so the session's
 * drift-heal re-applied its own stale value over the user's change.
 *
 * The USER-FILE half of the fs domain stays denied — `readUserFileAsync` and
 * `writeUserFileAsync` answer false — because those read and write the owner's
 * HOME, which is the cross-user boundary this host must never cross. Sysfs/proc
 * reads are world-readable, so `available: true` is truthful: the applet's one
 * mutation here really does apply.
 */

import type { AppletBackend } from "@common/applets/backend"
import type { Envelope } from "@common/applets/backend-protocol"
import * as batteryDomain from "@common/applets/domains/battery"
import * as brightnessDomain from "@common/applets/domains/brightness"
import * as cpuDomain from "@common/applets/domains/cpu"
import * as fsDomain from "@common/applets/domains/fs"
import * as powerProfileDomain from "@common/applets/domains/power-profile"
import * as powerSupplyEventsDomain from "@common/applets/domains/power-supply-events"
import * as systemDomain from "@common/applets/domains/system"
import * as tlpDomain from "@common/applets/domains/tlp"
import * as volumeDomain from "@common/applets/domains/volume"

/** The single battery (ASUS naming), shared by the cap store and the samples. */
const BAT0 = "/sys/class/power_supply/BAT0"

// ── fs: real reads + the cap writes, never the owner's home ──

/** The greeter's `fs` domain: real sysfs/proc reads AND the cap write (through
 *  the scoped sudo tee rule — see the module doc). The user-file members stay
 *  refused: they address the owner's home, not a world-readable device
 *  attribute. */
function greeterFs(): AppletBackend["fs"] {
  return {
    available: true,
    readFile: fsDomain.readFile,
    listDir: fsDomain.listDir,
    readFileAsync: fsDomain.readFileAsync,
    writeFileAsync: fsDomain.writeFileAsync,
    readUserFileAsync: async () => ({ ok: false, contents: "" }),
    writeUserFileAsync: async () => false,
  }
}

// ── Domains ──

/** The domains the greeter binds in process (see the module doc). Everything
 *  else comes from the socket client. */
export const greeterLocalDomains: Pick<
  AppletBackend,
  | "battery"
  | "brightness"
  | "cpu"
  | "system"
  | "powerProfile"
  | "tlp"
  | "powerSupplyEvents"
  | "volume"
  | "fs"
> = {
  battery: batteryDomain,
  brightness: brightnessDomain,
  cpu: cpuDomain,
  system: systemDomain,
  powerProfile: powerProfileDomain,
  tlp: tlpDomain,
  powerSupplyEvents: powerSupplyEventsDomain,
  // The lock screen's own sink read: the strip's volume cell must keep working
  // there, and lock mode IS the session user (see the module doc). This is the
  // contract's one OPTIONAL domain, and the greeter is the host that shows why:
  // it is bound here for the locked case and reports no sink pre-login.
  volume: volumeDomain,
  fs: greeterFs(),
}

// ── First-sample probes ──

function noSample(label: string, raw: string): Envelope {
  return {
    ok: false,
    error: {
      kind: "no-sample",
      message: raw === "" ? `${label} is unreadable` : `${label} is not a number ('${raw}')`,
    },
  }
}

/** A probe that found a reading. The value is the probe's own payload — the
 *  cell gate only reads `ok`. */
function sample(value: unknown): Envelope {
  return { ok: true, value }
}

/** The first-sample probes the strip's cell gate uses (see `SAMPLE_PROBE` in
 *  ./Strip): each answers an envelope shaped like the backend's, so
 *  `ok:true` keeps meaning "a real reading exists" whichever side produced it.
 *  A probe reads the SOURCE (the file), not the applet's reactive, whose
 *  resting value is a seed. */
export const greeterLocalSamples = {
  /** BAT0 capacity — the battery cell's reading. */
  async battery(): Promise<Envelope> {
    const raw = await fsDomain.readFileAsync(`${BAT0}/capacity`)
    const pct = parseInt(raw, 10)
    return Number.isNaN(pct) ? noSample(`${BAT0}/capacity`, raw) : sample({ percentage: pct })
  },

  /** The first backlight device's raw level. */
  async brightness(): Promise<Envelope> {
    for (const dev of fsDomain.listDir("/sys/class/backlight")) {
      const path = `/sys/class/backlight/${dev}/brightness`
      const raw = await fsDomain.readFileAsync(path)
      if (raw !== "") return sample({ screen: raw })
    }
    return noSample("/sys/class/backlight/<dev>/brightness", "")
  },

  /** The CPU + memory counters the Performance rings are computed from. */
  async performance(): Promise<Envelope> {
    const [stat, meminfo] = await Promise.all([
      fsDomain.readFileAsync("/proc/stat"),
      fsDomain.readFileAsync("/proc/meminfo"),
    ])
    if (!stat.includes("cpu ") || meminfo === "")
      return noSample(
        "/proc/stat + /proc/meminfo",
        stat === "" || meminfo === "" ? "" : "incomplete",
      )
    return sample({ cpu: true, ram: true })
  },
}
