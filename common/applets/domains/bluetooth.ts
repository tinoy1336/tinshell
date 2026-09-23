import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ignore } from "@common/log/logger"
import { createStateStore } from "@common/state"

const BLUEZ = "org.bluez"
const BLUEZ_ROOT = "/org/bluez"
const ADAPTER_PATH = BLUEZ_ROOT + "/hci0"
const ADAPTER_IFACE = "org.bluez.Adapter1"
const DEVICE_IFACE = "org.bluez.Device1"

// ── Persisted adapter power ──

/** The user's adapter power choice. BlueZ does not remember Powered across
 *  reboots (AutoEnable powers every controller on at boot), so the choice
 *  lives here and the Bluetooth applet re-applies it once the adapter
 *  appears. */
export const bluetoothEnabledStore = createStateStore<"bluetoothEnabled">({
  app: "bluetooth",
  version: 1,
  keys: { bluetoothEnabled: (v: unknown) => typeof v === "boolean" },
})

/** Read Powered property on the default adapter. */
export function isBluetoothEnabled(): Promise<boolean> {
  return new Promise((resolve) => {
    Gio.DBus.system.call(
      BLUEZ,
      ADAPTER_PATH,
      "org.freedesktop.DBus.Properties",
      "Get",
      new GLib.Variant("(ss)", [ADAPTER_IFACE, "Powered"]),
      new GLib.VariantType("(v)"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_obj: any, res: any) => {
        try {
          const reply = Gio.DBus.system.call_finish(res)
          const value = reply.get_child_value(0).get_variant().unpack()
          resolve(!!value)
        } catch (e) {
          ignore("bluez powered read", e)
          resolve(false)
        }
      },
    )
  })
}

/** Set Powered on the default adapter. */
export function setBluetoothEnabled(on: boolean): Promise<void> {
  return new Promise((resolve) => {
    const variant = new GLib.Variant("(ssv)", [ADAPTER_IFACE, "Powered", new GLib.Variant("b", on)])
    Gio.DBus.system.call(
      BLUEZ,
      ADAPTER_PATH,
      "org.freedesktop.DBus.Properties",
      "Set",
      variant,
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_obj: any, res: any) => {
        try {
          Gio.DBus.system.call_finish(res)
        } catch (e) {
          ignore("bluez set-powered reply", e)
        }
        resolve()
      },
    )
  })
}

export interface BluetoothStatus {
  enabled: boolean
  connected: boolean
}

/** Check powered state + whether any device is connected. */
export function bluetoothStatus(): Promise<BluetoothStatus> {
  return new Promise((resolve) => {
    isBluetoothEnabled().then((enabled) => {
      if (!enabled) {
        resolve({ enabled: false, connected: false })
        return
      }
      anyConnectedDevice().then((connected) => {
        resolve({ enabled: true, connected })
      })
    })
  })
}

/** Enumerate /org/bluez/hci0/dev_* and check for any Connected=true property. */
function anyConnectedDevice(): Promise<boolean> {
  return new Promise((resolve) => {
    Gio.DBus.system.call(
      BLUEZ,
      "/",
      "org.freedesktop.DBus.ObjectManager",
      "GetManagedObjects",
      null,
      new GLib.VariantType("(a{oa{sa{sv}}})"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_obj: any, res: any) => {
        try {
          const [objects] = Gio.DBus.system.call_finish(res).deepUnpack() as [
            Record<string, Record<string, unknown>>,
          ]
          for (const [path, ifaces] of Object.entries(objects) as [string, any][]) {
            if (!path.startsWith(ADAPTER_PATH + "/dev_")) continue
            const device = ifaces[DEVICE_IFACE]
            if (device?.Connected?.unpack?.() ?? device?.Connected) {
              resolve(true)
              return
            }
          }
          resolve(false)
        } catch (e) {
          // The object-manager read failed: report it rather than let the
          // caller read "no device connected" out of a broken call.
          ignore("bluez object-manager read", e)
          resolve(false)
        }
      },
    )
  })
}

/** Subscribe to BlueZ adapter/device property changes (Powered, Discovering,
 *  Connected). The callback fires whenever the applet's status inputs change
 *  — the event-driven replacement for the 2s status poll. Returns unsubscribe. */
export function subscribeBluetoothStatus(onChange: () => void): () => void {
  const subId = Gio.DBus.system.signal_subscribe(
    BLUEZ,
    "org.freedesktop.DBus.Properties",
    "PropertiesChanged",
    null,
    null,
    Gio.DBusSignalFlags.NONE,
    (_c: any, _s: any, path: any, _i: any, _sig: any, params: GLib.Variant) => {
      try {
        const p = path ?? ""
        if (!p.startsWith(BLUEZ_ROOT + "/")) return
        const iface = params.get_child_value(0).get_string()[0]
        if (iface !== ADAPTER_IFACE && iface !== DEVICE_IFACE) return
        onChange()
      } catch (e) {
        ignore("bluez properties-changed", e)
      }
    },
  )
  return () => Gio.DBus.system.signal_unsubscribe(subId)
}

// ──────────────────────────────────────────────────────────────────────────
// Menu backend — device list, discovery, connect/disconnect/pair/remove
// ──────────────────────────────────────────────────────────────────────────

/** A single BlueZ device as reported by GetManagedObjects. */
export interface BluetoothDevice {
  path: string
  name: string
  address: string
  connected: boolean
  paired: boolean
  trusted: boolean
  icon: string
}

/** Fetch all /org/bluez objects (devices + adapter properties). */
function getManagedObjects(): Promise<Record<string, Record<string, unknown>>> {
  return new Promise((resolve) => {
    Gio.DBus.system.call(
      BLUEZ,
      "/",
      "org.freedesktop.DBus.ObjectManager",
      "GetManagedObjects",
      null,
      new GLib.VariantType("(a{oa{sa{sv}}})"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_obj: any, res: any) => {
        try {
          const [objects] = Gio.DBus.system.call_finish(res).deepUnpack() as [
            Record<string, Record<string, unknown>>,
          ]
          resolve(objects)
        } catch (_) {
          resolve({})
        }
      },
    )
  })
}

/** Whether the default adapter object is registered (bluetoothd is up AND
 *  the controller exists). Callers await it before touching an adapter — the
 *  user session can start before bluetooth.service at boot. */
export function adapterExists(): Promise<boolean> {
  return getManagedObjects().then((objects) => !!objects[ADAPTER_PATH]?.[ADAPTER_IFACE])
}

/** Enumerate all known devices (paired, remembered, and discovered). */
export async function listBluetoothDevices(): Promise<BluetoothDevice[]> {
  const objects = await getManagedObjects()
  const devices: BluetoothDevice[] = []
  for (const [path, ifaces] of Object.entries(objects) as [string, any][]) {
    if (!path.startsWith(ADAPTER_PATH + "/dev_")) continue
    const d = ifaces[DEVICE_IFACE]
    if (!d) continue
    const str = (k: string): string => {
      try {
        const v = d[k]
        const val = typeof v?.unpack === "function" ? v.unpack() : v
        return typeof val === "string" ? val : ""
      } catch (_) {
        return ""
      }
    }
    const bool = (k: string): boolean => {
      try {
        const v = d[k]
        const val = typeof v?.unpack === "function" ? v.unpack() : v
        return !!val
      } catch (e) {
        ignore("bluez device boolean property", e)
        return false
      }
    }
    devices.push({
      path,
      name: str("Alias") || str("Name") || str("Address"),
      address: str("Address"),
      connected: bool("Connected"),
      paired: bool("Paired"),
      trusted: bool("Trusted"),
      icon: str("Icon"),
    })
  }
  // NAMED devices sort to the TOP, ID-only devices sort to the BOTTOM.
  // BlueZ reports the address AS the alias for unnamed devices — in BOTH
  // separator forms (colon MACs and the dash form bluetoothctl shows, e.g.
  // "7C-4A-68-32-F0-15"; missing the dash form classified real discovery
  // remnants as named and sank every unpaired named device to the bottom
  // of the alphabetical pile). A bare hex blob counts as ID-only too.
  // Within each group the previous ordering intent is preserved:
  // connected, then paired, then alphabetical.
  const macOnlyName = (s: string): number => {
    const t = s.trim()
    if (!t) return 1
    return /^[0-9A-Fa-f]{2}([:.-][0-9A-Fa-f]{2}){5}$/.test(t) || /^[0-9A-Fa-f]{6,}$/.test(t) ? 1 : 0
  }
  devices.sort(
    (a, b) =>
      macOnlyName(a.name) - macOnlyName(b.name) ||
      (b.connected ? 2 : b.paired ? 1 : 0) - (a.connected ? 2 : a.paired ? 1 : 0) ||
      a.name.localeCompare(b.name),
  )
  return devices
}

/** Whether the adapter is currently scanning. */
export async function adapterDiscovering(): Promise<boolean> {
  const objects = await getManagedObjects()
  const adapter = objects[ADAPTER_PATH]?.[ADAPTER_IFACE] as
    | { Discovering?: { unpack?: () => unknown } }
    | undefined
  try {
    return !!(adapter?.Discovering?.unpack?.() ?? false)
  } catch (e) {
    ignore("bluez discovering property", e)
    return false
  }
}

/** Result of a device/agent action. */
export interface BluetoothActionResult {
  ok: boolean
  error?: string
}

/** Call a no-reply method on the adapter or a device, reporting success. */
function callNoReply(
  _dest: string,
  path: string,
  iface: string,
  method: string,
  params?: GLib.Variant,
): Promise<BluetoothActionResult> {
  return new Promise((resolve) => {
    Gio.DBus.system.call(
      BLUEZ,
      path,
      iface,
      method,
      params ?? null,
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_obj: any, res: any) => {
        try {
          Gio.DBus.system.call_finish(res)
          resolve({ ok: true })
        } catch (e: any) {
          resolve({
            ok: false,
            error: String(e?.message ?? e).replace(/^GDBus\.Error:[^:]*: ?/, ""),
          })
        }
      },
    )
  })
}

export function startDiscovery(): Promise<BluetoothActionResult> {
  return callNoReply(BLUEZ, ADAPTER_PATH, ADAPTER_IFACE, "StartDiscovery")
}

export function stopDiscovery(): Promise<BluetoothActionResult> {
  return callNoReply(BLUEZ, ADAPTER_PATH, ADAPTER_IFACE, "StopDiscovery")
}

export function connectDevice(path: string): Promise<BluetoothActionResult> {
  return callNoReply(BLUEZ, path, DEVICE_IFACE, "Connect")
}

export function disconnectDevice(path: string): Promise<BluetoothActionResult> {
  return callNoReply(BLUEZ, path, DEVICE_IFACE, "Disconnect")
}

export function removeDevice(path: string): Promise<BluetoothActionResult> {
  // RemoveDevice takes the device object path.
  return callNoReply(
    BLUEZ,
    ADAPTER_PATH,
    ADAPTER_IFACE,
    "RemoveDevice",
    new GLib.Variant("(o)", [path]),
  )
}

export function pairDevice(path: string): Promise<BluetoothActionResult> {
  return callNoReply(BLUEZ, path, DEVICE_IFACE, "Pair")
}

// ──────────────────────────────────────────────────────────────────────────
// BlueZ agent — minimal NoInputNoOutput agent so pairing/connecting to
// discovered (unpaired) devices works without user interaction for the
// common JustWorks / numeric-comparison flows. PIN/passkey entry flows
// (KeyboardDisplay devices) are NOT supported by this capability.
// ──────────────────────────────────────────────────────────────────────────

const AGENT_PATH = BLUEZ_ROOT + "/ags_agent"
const AGENT_MANAGER = "org.bluez.AgentManager1"
const AGENT_CAPABILITY = "NoInputNoOutput"

const AGENT_XML = `<node>
  <interface name="org.bluez.Agent1">
    <method name="Release"/>
    <method name="Cancel"/>
    <method name="RequestPinCode"><arg type="o" direction="in" name="device"/><arg type="s" direction="out"/></method>
    <method name="DisplayPinCode"><arg type="o" direction="in" name="device"/><arg type="s" direction="in" name="pincode"/></method>
    <method name="RequestPasskey"><arg type="o" direction="in" name="device"/><arg type="u" direction="out"/></method>
    <method name="DisplayPasskey"><arg type="o" direction="in" name="device"/><arg type="u" direction="in" name="passkey"/><arg type="q" direction="in" name="entered"/></method>
    <method name="RequestConfirmation"><arg type="o" direction="in" name="device"/><arg type="u" direction="in" name="passkey"/></method>
    <method name="RequestAuthorization"><arg type="o" direction="in" name="device"/></method>
    <method name="AuthorizeService"><arg type="o" direction="in" name="device"/><arg type="s" direction="in" name="uuid"/></method>
  </interface>
</node>`

let agentRegistered = false
let agentObjectId: number | null = null

/** Register the agent object + RegisterAgent/RequestDefaultAgent. Idempotent. */
export function registerAgent(): void {
  if (agentRegistered) return
  agentRegistered = true
  try {
    const node = Gio.DBusNodeInfo.new_for_xml(AGENT_XML)
    agentObjectId = Gio.DBus.system.register_object(
      AGENT_PATH,
      node.interfaces[0],
      (
        _conn: any,
        _sender: any,
        _path: string,
        _iface: string,
        method: string,
        _params: any,
        invocation: any,
      ) => {
        // NoInputNoOutput capability: every interaction is auto-accepted or
        // answered with a zero/default reply. Rejections would call
        // invocation.return_dbus_error("org.bluez.Error.Rejected", ...).
        switch (method) {
          case "RequestPinCode":
            invocation.return_value(new GLib.Variant("(s)", ["0000"]))
            break
          case "RequestPasskey":
            invocation.return_value(new GLib.Variant("(u)", [0]))
            break
          default:
            invocation.return_value(null)
            break // Release/Cancel/Display*/RequestConfirmation/Authorization → accept
        }
      },
      null,
      null,
    )
    const register = (method: string, params: GLib.Variant) => {
      Gio.DBus.system.call(
        BLUEZ,
        BLUEZ_ROOT,
        AGENT_MANAGER,
        method,
        params,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_obj: any, res: any) => {
          try {
            Gio.DBus.system.call_finish(res)
          } catch (e) {
            ignore("bluez agent register reply", e)
          }
        },
      )
    }
    register("RegisterAgent", new GLib.Variant("(os)", [AGENT_PATH, AGENT_CAPABILITY]))
    register("RequestDefaultAgent", new GLib.Variant("(o)", [AGENT_PATH]))
  } catch (e) {
    print(`[bluetooth] agent registration failed: ${e}`)
  }
}

/** Unregister the agent with BlueZ AND drop the exported object — without the
 *  unregister_object the next open's register_object throws "An object is
 *  already exported" and the agent leaks. */
export function unregisterAgent(): void {
  if (!agentRegistered) return
  agentRegistered = false
  if (agentObjectId !== null) {
    try {
      Gio.DBus.system.unregister_object(agentObjectId)
    } catch (e) {
      ignore("bluez agent object unregister", e)
    }
    agentObjectId = null
  }
  Gio.DBus.system.call(
    BLUEZ,
    BLUEZ_ROOT,
    AGENT_MANAGER,
    "UnregisterAgent",
    new GLib.Variant("(o)", [AGENT_PATH]),
    null,
    Gio.DBusCallFlags.NONE,
    -1,
    null,
    (_obj: any, res: any) => {
      try {
        Gio.DBus.system.call_finish(res)
      } catch (e) {
        ignore("bluez agent unregister reply", e)
      }
    },
  )
}
