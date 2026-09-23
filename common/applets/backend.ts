/**
 * Applet backend contract — the OS-call surface applet mounts use.
 *
 * A host supplies its implementations at mount time through the AppletContext,
 * so the frontends stay free of any app and the implementation can move behind
 * a transport without touching applet code again.
 *
 * The OS domains are the `common/applets/domains/*` modules; the type-only imports
 * below are the bridge to that implementation's signatures. The screengrab
 * domains are still owned by the dock app.
 *
 * Every host supplies every domain its applets call.
 */

import type * as Screengrab from "@apps/dock/screengrab/capture"
import type * as ScreengrabNaming from "@apps/dock/screengrab/naming"
import type * as Battery from "@common/applets/domains/battery"
import type * as Bluetooth from "@common/applets/domains/bluetooth"
import type * as Brightness from "@common/applets/domains/brightness"
import type * as Cpu from "@common/applets/domains/cpu"
import type * as Fs from "@common/applets/domains/fs"
import type * as MediaWindow from "@common/applets/domains/media-window"
import type * as Mpris from "@common/applets/domains/mpris"
import type * as Network from "@common/applets/domains/network"
import type * as Power from "@common/applets/domains/power"
import type * as PowerProfile from "@common/applets/domains/power-profile"
import type * as PowerSupplyEvents from "@common/applets/domains/power-supply-events"
import type * as System from "@common/applets/domains/system"
import type * as Tablet from "@common/applets/domains/tablet"
import type * as Tlp from "@common/applets/domains/tlp"
import type * as Volume from "@common/applets/domains/volume"
import type * as Wifi from "@common/applets/domains/wifi"
import type * as Workspaces from "@common/applets/domains/workspaces"

/** One property per OS domain; each is exactly the implementation module's
 *  exported surface, so a domain swap never changes an applet call site. */
export interface AppletBackend {
  battery: typeof Battery
  bluetooth: typeof Bluetooth
  brightness: typeof Brightness
  cpu: typeof Cpu
  /** Raw sysfs/proc read + write helpers. */
  fs: typeof Fs
  /** hyprctl client lookup for the media applet's window tracking. */
  mediaWindow: typeof MediaWindow
  mpris: typeof Mpris
  /** Interface counters (the wifi applet's throughput ring). */
  network: typeof Network
  power: typeof Power
  powerProfile: typeof PowerProfile
  powerSupplyEvents: typeof PowerSupplyEvents
  /** The capture driver (wf-recorder / still capture) the screengrab applet
   *  starts and stops. */
  screengrab: typeof Screengrab
  /** Capture output-path rendering (name template → file path). */
  screengrabNaming: typeof ScreengrabNaming
  system: typeof System
  tablet: typeof Tablet
  tlp: typeof Tlp
  /** The default sink's level, mute state and device class. OPTIONAL because
   *  it is session bound: a host with no session (the pre-login greeter binds
   *  no session audio) carries no volume domain, and a caller paints its own
   *  "no output device" surface instead of a reading nothing can supply. */
  volume?: typeof Volume
  wifi: typeof Wifi
  workspaces: typeof Workspaces
}

/** The adapter/device snapshot the bluetooth applet renders. */
export type BluetoothStatus = Awaited<ReturnType<AppletBackend["bluetooth"]["bluetoothStatus"]>>

/** One paired/discovered device row. */
export type BluetoothDevice = Awaited<
  ReturnType<AppletBackend["bluetooth"]["listBluetoothDevices"]>
>[number]

/** The player snapshot the mpris domain publishes. */
export type MprisState = Parameters<Parameters<AppletBackend["mpris"]["mprisState"]>[0]>[0]

/** The radio snapshot the wifi domain publishes. */
export type WifiStatus = Awaited<ReturnType<AppletBackend["wifi"]["wifiStatus"]>>

/** One visible access point. */
export type WifiNetwork = Awaited<ReturnType<AppletBackend["wifi"]["scanWifiNetworks"]>>[number]

/** The capture-mode union the capture overlay works in. */
export type CaptureMode = Parameters<AppletBackend["screengrab"]["resolveGeometry"]>[0]
