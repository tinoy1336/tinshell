import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ignore } from "@common/log/logger"
import { shq } from "@common/subprocess/quote"
import { type RunResult, run, runCb, TimeoutError } from "@common/subprocess/run"

// ── NetworkManager D-Bus (event-driven status) ──
const NM = "org.freedesktop.NetworkManager"
const NM_PATH = "/org/freedesktop/NetworkManager"
const NM_IFACE = "org.freedesktop.NetworkManager"
const DEVICE_IFACE = "org.freedesktop.NetworkManager.Device"
const WIRELESS_IFACE = "org.freedesktop.NetworkManager.Device.Wireless"
const AP_IFACE = "org.freedesktop.NetworkManager.AccessPoint"

// NMConnectivityState (0 UNKNOWN, 1 NONE, 2 PORTAL, 3 LIMITED, 4 FULL) —
// maps straight onto the wifi icon's connectivity strings.
const CONNECTIVITY: string[] = ["unknown", "none", "portal", "limited", "full"]

function dbusGet(
  service: string,
  path: string,
  iface: string,
  prop: string,
): Promise<GLib.Variant> {
  return new Promise((resolve, reject) => {
    Gio.DBus.system.call(
      service,
      path,
      "org.freedesktop.DBus.Properties",
      "Get",
      new GLib.Variant("(ss)", [iface, prop]),
      new GLib.VariantType("(v)"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_o: any, res: any) => {
        try {
          resolve(Gio.DBus.system.call_finish(res).get_child_value(0).get_variant())
        } catch (e) {
          reject(e)
        }
      },
    )
  })
}

function dbusGetDevices(): Promise<string[]> {
  return new Promise((resolve) => {
    Gio.DBus.system.call(
      NM,
      NM_PATH,
      NM_IFACE,
      "GetDevices",
      null,
      new GLib.VariantType("(ao)"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_o: any, res: any) => {
        try {
          resolve((Gio.DBus.system.call_finish(res).deepUnpack() as [string[]])[0] ?? [])
        } catch {
          resolve([])
        }
      },
    )
  })
}

export interface WifiStatus {
  enabled: boolean
  connected: boolean
  signal: number // 0-100
  connectivity: string // "full" | "limited" | "portal" | "none" | "unknown"
}

/** Full status: enabled, connected, signal strength (0-100), connectivity.
 *  Event-driven source: read straight from NetworkManager's D-Bus properties
 *  (no subprocess) — WirelessEnabled + Connectivity on the manager, the wifi
 *  device's State (100 = ACTIVATED — the header's NMDeviceState enum; 110 is
 *  DEACTIVATING) + ActiveAccessPoint Strength. The safety
 *  poll and the applet's signal subscription both call this. */
export function wifiStatus(): Promise<WifiStatus> {
  return (async () => {
    let enabled = false
    try {
      enabled = await dbusGet(NM, NM_PATH, NM_IFACE, "WirelessEnabled").then(
        (v) => !!v.get_boolean(),
      )
    } catch {
      return { enabled: false, connected: false, signal: 0, connectivity: "none" }
    }
    if (!enabled) return { enabled: false, connected: false, signal: 0, connectivity: "none" }
    let connectivity = "unknown"
    try {
      connectivity =
        CONNECTIVITY[
          await dbusGet(NM, NM_PATH, NM_IFACE, "Connectivity").then((v) => v.get_uint32())
        ] ?? "unknown"
    } catch (e) {
      ignore("nm connectivity read", e)
    }
    let connected = false
    let signal = 0
    try {
      for (const devPath of await dbusGetDevices()) {
        let type = -1
        try {
          type = await dbusGet(NM, devPath, DEVICE_IFACE, "DeviceType").then((v) => v.get_uint32())
        } catch {
          continue
        }
        if (type !== 2) continue // NM_DEVICE_TYPE_WIFI
        try {
          const state = await dbusGet(NM, devPath, DEVICE_IFACE, "State").then((v) =>
            v.get_uint32(),
          )
          connected = state === 100 // NM_DEVICE_STATE_ACTIVATED (100 — see the enum comment above)
          const apPath = await dbusGet(NM, devPath, WIRELESS_IFACE, "ActiveAccessPoint").then(
            (v) => v.get_string()[0],
          )
          if (apPath && apPath !== "/") {
            signal =
              (await dbusGet(NM, apPath, AP_IFACE, "Strength").then((v) => v.get_byte())) || 0
          }
        } catch (e) {
          ignore("nm ap strength read", e)
        }
        break
      }
    } catch (e) {
      ignore("nm device status read", e)
    }
    return { enabled: true, connected, signal, connectivity }
  })()
}

/** SSID of the active wifi connection — the ActiveAccessPoint's Ssid byte
 *  array, UTF-8 decoded. A fast D-Bus read (a few property roundtrips, no
 *  subprocess) so the wifi menu can prime its CURRENT-network row before
 *  the window maps — the menu opens showing the connected network instead
 *  of a spinner. Null when there is no wifi device or no active AP. */
export function activeWifiSsid(): Promise<string | null> {
  return (async () => {
    try {
      for (const devPath of await dbusGetDevices()) {
        let type = -1
        try {
          type = await dbusGet(NM, devPath, DEVICE_IFACE, "DeviceType").then((v) => v.get_uint32())
        } catch {
          continue
        }
        if (type !== 2) continue // NM_DEVICE_TYPE_WIFI
        try {
          const apPath = await dbusGet(NM, devPath, WIRELESS_IFACE, "ActiveAccessPoint").then(
            (v) => v.get_string()[0],
          )
          if (!apPath || apPath === "/") return null
          const v = await dbusGet(NM, apPath, AP_IFACE, "Ssid")
          // 'ay' → gjs Uint8Array (NM sends no NUL terminator; trailing NULs
          // would decode as control chars — strip them).
          const bytes = v.deepUnpack() as Uint8Array
          let end = bytes.length
          while (end > 0 && bytes[end - 1] === 0) end--
          return new TextDecoder().decode(bytes.subarray(0, end)) || null
        } catch (e) {
          // Malformed SSID bytes (NM occasionally reports a partial array).
          ignore("nm ssid decode", e)
          return null
        }
      }
    } catch (e) {
      ignore("nm active-ap ssid read", e)
    }
    return null
  })()
}

/** Subscribe to NetworkManager changes that affect the applet's status:
 *  manager PropertiesChanged (WirelessEnabled, Connectivity), device
 *  State/ActiveAccessPoint changes, AP Strength changes, device add/remove,
 *  and the manager StateChanged signal. Returns an unsubscribe function. */
export function subscribeWifiStatus(onChange: () => void): () => void {
  const subs: number[] = []
  subs.push(
    Gio.DBus.system.signal_subscribe(
      NM,
      "org.freedesktop.DBus.Properties",
      "PropertiesChanged",
      null,
      null,
      Gio.DBusSignalFlags.NONE,
      (_c: any, _s: any, path: any, _i: any, _sig: any, _params: GLib.Variant) => {
        const p = path ?? ""
        if (
          p !== NM_PATH &&
          !p.startsWith("/org/freedesktop/NetworkManager/Devices/") &&
          !p.startsWith("/org/freedesktop/NetworkManager/AccessPoints/")
        )
          return
        onChange()
      },
    ),
  )
  subs.push(
    Gio.DBus.system.signal_subscribe(
      NM,
      NM_IFACE,
      "DeviceAdded",
      NM_PATH,
      null,
      Gio.DBusSignalFlags.NONE,
      () => onChange(),
    ),
  )
  subs.push(
    Gio.DBus.system.signal_subscribe(
      NM,
      NM_IFACE,
      "DeviceRemoved",
      NM_PATH,
      null,
      Gio.DBusSignalFlags.NONE,
      () => onChange(),
    ),
  )
  subs.push(
    Gio.DBus.system.signal_subscribe(
      NM,
      NM_IFACE,
      "StateChanged",
      NM_PATH,
      null,
      Gio.DBusSignalFlags.NONE,
      () => onChange(),
    ),
  )
  return () => {
    for (const id of subs) Gio.DBus.system.signal_unsubscribe(id)
  }
}

/** Enable or disable WiFi radio. */
export function setWifiEnabled(on: boolean): Promise<void> {
  return new Promise((resolve) => {
    runCb(`nmcli radio wifi ${on ? "on" : "off"}`, () => resolve())
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Menu backend — network list + connect/disconnect for the wifi menu
// ──────────────────────────────────────────────────────────────────────────

/** A single visible network as reported by `nmcli dev wifi list`. */
export interface WifiNetwork {
  ssid: string
  signal: number // 0-100
  security: string // "" = open, otherwise "WPA1/WPA2/..."
  inUse: boolean // currently connected
}

/** Split one nmcli -t (terse) output line on unescaped colons. Terse mode
 *  escapes field-separator colons and backslashes inside values (\: and \\),
 *  so a naive split(':') mangles SSIDs that contain colons/backslashes. */
function splitTerse(line: string): string[] {
  const parts: string[] = []
  let cur = ""
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "\\" && i + 1 < line.length) {
      const next = line[++i]
      if (next === ":") cur += ":"
      else if (next === "\\") cur += "\\"
      else cur += ch + next
      continue
    }
    if (ch === ":") {
      parts.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts
}

/** Scan the visible network list, deduped by SSID (nmcli lists each BSSID;
 *  same-SSID APs merge into one row keeping the best signal + in-use flag).
 *  Empty when the radio is off. */
export function scanWifiNetworks(): Promise<WifiNetwork[]> {
  return new Promise((resolve) => {
    runCb("nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY dev wifi list", (stdout) => {
      const bySsid = new Map<string, WifiNetwork>()
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue
        const [inUse, ssid, signalStr, security = ""] = splitTerse(line)
        if (!ssid) continue
        const sig = parseInt(signalStr, 10) || 0
        const existing = bySsid.get(ssid)
        if (!existing) {
          bySsid.set(ssid, { inUse: inUse === "*", ssid, signal: sig, security })
          continue
        }
        // Same SSID via another AP: prefer the in-use BSSID, else the strongest
        // signal; fill in security if the first entry lacked it.
        if (inUse === "*" || (sig > existing.signal && !existing.inUse)) {
          existing.inUse = existing.inUse || inUse === "*"
          existing.signal = sig
          if (!existing.security) existing.security = security
        }
      }
      resolve([...bySsid.values()])
    })
  })
}

/** Result of a connect/disconnect attempt. */
export interface WifiActionResult {
  ok: boolean
  error?: string
}

/** nmcli's own explanation of a failed call, as one row-sized line.
 *
 *  nmcli writes the reason to STDERR (`Error: …`) and its friendly wording to
 *  stdout; a runner that silences stderr can only report the exit code, which
 *  tells a user nothing. stderr's `Error:` line wins (it names the cause); the
 *  first non-empty line of either stream is the fallback, the exit code the
 *  last resort. */
function nmcliDetail(r: RunResult): string {
  const lines = `${r.stderr}\n${r.stdout}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
  const text = (lines.find((l) => l.startsWith("Error:")) ?? lines[0] ?? "")
    .replace(/^Error:\s*/, "")
    .replace(/\s+/g, " ")
  if (!text) return `nmcli exit ${r.exit}`
  const MAX = 120
  return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text
}

/** Connect to a network. Works without a password for open networks and for
 *  saved secured networks (NetworkManager reuses the stored profile); a
 *  password is only required for an unsaved secured network — nmcli fails in
 *  non-interactive mode and the caller then prompts for one.
 *  Resolves { ok } — the menu shows the password entry or an error on failure.
 *  Both attempts are bounded (15s with a password: a WPA3/SAE connect can stall
 *  on the AP's handshake; 30s without one, where nmcli can block on a prompt it
 *  cannot answer) — a hung subprocess must not leave the menu spinning forever,
 *  and a legit SAE connect finishes in ~5s.
 *
 *  argv (never a shell string) + captured stderr: the password reaches nmcli as
 *  ONE argument whatever characters it holds, and a failure carries nmcli's own
 *  reason instead of a bare exit code.
 *
 *  Stale-profile retry: nmcli SILENTLY IGNORES the `password` argument when a
 *  profile for the SSID already exists (it reuses the old profile → "Secrets
 *  were required, but not provided" — the profile left behind by a previous
 *  failed attempt has no stored psk). On a password-connect failure the stale
 *  profile(s) are deleted and the connect is retried once — the fresh profile
 *  picks up the password. */
export function connectWifi(ssid: string, password?: string): Promise<WifiActionResult> {
  return new Promise((resolve) => {
    const attempt = (pw: string | undefined, retried: boolean): void => {
      const argv = ["nmcli", "dev", "wifi", "connect", ssid]
      if (pw) argv.push("password", pw)
      run(argv, { captureStderr: true, timeoutMs: pw ? 15000 : 30000 })
        .then((r) => {
          if (r.exit === 0) {
            resolve({ ok: true })
            return
          }
          const detail = nmcliDetail(r)
          if (pw && !retried) {
            profilesForSsid(ssid).then((names) => {
              if (names.length === 0) {
                resolve({ ok: false, error: detail })
                return
              }
              let i = 0
              const delNext = (): void => {
                if (i >= names.length) {
                  attempt(pw, true)
                  return
                }
                const name = names[i++]
                runCb(`nmcli connection delete ${shq(name)}`, () => delNext())
              }
              delNext()
            })
            return
          }
          resolve({ ok: false, error: detail })
        })
        .catch((e) => {
          resolve({
            ok: false,
            error:
              e instanceof TimeoutError
                ? "Connection timed out"
                : `nmcli could not run: ${(e as Error).message}`,
          })
        })
    }
    attempt(password, false)
  })
}

/** Ask NetworkManager to rescan, then resolve (the scan itself is async on NM's
 *  side — the menu re-lists after a short delay). */
export function rescanWifi(): Promise<void> {
  return new Promise((resolve) => {
    runCb("nmcli dev wifi rescan", () => resolve())
  })
}

/** Unescape a single nmcli terse value — same escape rules as splitTerse (a
 *  single value carries no unescaped colons, so splitting and rejoining
 *  unescapes it). */
function unescapeTerse(v: string): string {
  return splitTerse(v).join(":")
}

/** Resolve the saved profile NAMEs that carry `ssid`. `nmcli connection show`
 *  exposes no SSID column on this NM version (nmcli rejects SSID and
 *  802-11-wireless.ssid fields for it), so list the wifi profiles once, then
 *  read each one's `802-11-wireless.ssid` value from its full terse output. */
function profilesForSsid(ssid: string): Promise<string[]> {
  return new Promise((resolve) => {
    runCb("nmcli -t -f NAME,TYPE connection show", (stdout) => {
      const wifiNames: string[] = []
      for (const line of stdout.split("\n")) {
        const parts = splitTerse(line)
        if (parts.length >= 2 && parts[1] === "802-11-wireless") wifiNames.push(parts[0])
      }
      const matches: string[] = []
      let i = 0
      const next = (): void => {
        if (i >= wifiNames.length) {
          resolve(matches)
          return
        }
        const name = wifiNames[i++]
        runCb(`nmcli -t connection show ${shq(name)}`, (out) => {
          const prefix = "802-11-wireless.ssid:"
          for (const line of out.split("\n")) {
            if (line.startsWith(prefix)) {
              if (unescapeTerse(line.slice(prefix.length)) === ssid) matches.push(name)
              break
            }
          }
          next()
        })
      }
      next()
    })
  })
}

/** Distinct SSIDs that have a saved NetworkManager profile (the wifi menu's
 *  "known network" indicator). Same per-profile SSID read as profilesForSsid. */
export function savedSsidList(): Promise<string[]> {
  return new Promise((resolve) => {
    runCb("nmcli -t -f NAME,TYPE connection show", (stdout) => {
      const wifiNames: string[] = []
      for (const line of stdout.split("\n")) {
        const parts = splitTerse(line)
        if (parts.length >= 2 && parts[1] === "802-11-wireless") wifiNames.push(parts[0])
      }
      const ssids = new Set<string>()
      let i = 0
      const next = (): void => {
        if (i >= wifiNames.length) {
          resolve([...ssids])
          return
        }
        const name = wifiNames[i++]
        runCb(`nmcli -t connection show ${shq(name)}`, (out) => {
          const prefix = "802-11-wireless.ssid:"
          for (const line of out.split("\n")) {
            if (line.startsWith(prefix)) {
              const s = unescapeTerse(line.slice(prefix.length))
              if (s) ssids.add(s)
              break
            }
          }
          next()
        })
      }
      next()
    })
  })
}

/** Delete every saved NetworkManager profile for `ssid` (the wifi menu's
 *  trash/forget action). Resolves { ok:false } + a human error on failure. */
export function forgetWifiNetwork(ssid: string): Promise<WifiActionResult> {
  return new Promise((resolve) => {
    profilesForSsid(ssid).then((names) => {
      if (names.length === 0) {
        resolve({ ok: false, error: "no saved network with that SSID" })
        return
      }
      let i = 0
      const deleteNext = (): void => {
        if (i >= names.length) {
          resolve({ ok: true })
          return
        }
        const name = names[i++]
        runCb(`nmcli connection delete ${shq(name)}`, (_o, status) => {
          if (status !== 0) {
            resolve({ ok: false, error: `failed to delete ${name}` })
            return
          }
          deleteNext()
        })
      }
      deleteNext()
    })
  })
}

/** Disconnect the active wifi device. No-op if not connected. */
export function disconnectWifi(): Promise<WifiActionResult> {
  return new Promise((resolve) => {
    runCb("nmcli -t -f DEVICE,TYPE connection show --active", (stdout) => {
      const wifiDev = stdout
        .split("\n")
        .map((l) => splitTerse(l))
        .find(([dev, type]) => dev && type === "802-11-wireless")
      if (!wifiDev) {
        resolve({ ok: true })
        return
      }
      runCb(`nmcli dev disconnect ${wifiDev[0]}`, (_o, status) => {
        resolve(status === 0 ? { ok: true } : { ok: false, error: `disconnect failed (${status})` })
      })
    })
  })
}
