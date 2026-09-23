import Gio from "gi://Gio"
import GLib from "gi://GLib"
import type { TlpProfile } from "@common/applets/types"
import { createStateStore } from "@common/state"

const SERVICE = "org.freedesktop.UPower.PowerProfiles"
const PATH = "/org/freedesktop/UPower/PowerProfiles"
const IFACE = "org.freedesktop.UPower.PowerProfiles"
const PROPERTIES_IFACE = "org.freedesktop.DBus.Properties"

// ── Persisted Auto mode ──

/** The Performance applet's Auto mode (profile picked from AC state). The
 *  applet re-applies it at mount and keeps the daemon in sync while it is
 *  on. */
export const autoProfileStore = createStateStore<"autoProfile">({
  app: "power-profile",
  version: 1,
  keys: { autoProfile: (v: unknown) => typeof v === "boolean" },
})

/** Read the active power profile asynchronously via DBus (never blocks the main loop). */
export function readProfile(): Promise<TlpProfile> {
  return new Promise((resolve) => {
    Gio.DBus.system.call(
      SERVICE,
      PATH,
      PROPERTIES_IFACE,
      "Get",
      new GLib.Variant("(ss)", [IFACE, "ActiveProfile"]),
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_o: any, res: any) => {
        try {
          const result = Gio.DBus.system.call_finish(res)
          const variant = result.get_child_value(0).get_child_value(0)
          const [s] = variant.get_string()
          if (s === "performance") return resolve("performance")
          if (s === "balanced") return resolve("balanced")
          if (s === "power-saver") return resolve("power-saver")
          resolve("balanced")
        } catch (_) {
          resolve("balanced")
        }
      },
    )
  })
}

/** Write the active power profile asynchronously via DBus. A refused write
 *  (polkit: `org.freedesktop.UPower.PowerProfiles.switch-profile` is
 *  `allow_active=yes` only) is logged — without it the applet's panel looks
 *  like it switched the profile while the daemon kept the old one. */
export function writeProfile(profile: TlpProfile): void {
  if (profile === "unknown") return
  Gio.DBus.system.call(
    SERVICE,
    PATH,
    PROPERTIES_IFACE,
    "Set",
    new GLib.Variant("(ssv)", [IFACE, "ActiveProfile", new GLib.Variant("s", profile)]),
    null,
    Gio.DBusCallFlags.NONE,
    -1,
    null,
    (_o: any, res: any) => {
      try {
        Gio.DBus.system.call_finish(res)
      } catch (e) {
        print(`[power-profile] Set ActiveProfile '${profile}' failed: ${e}`)
      }
    },
  )
}

// ── PropertiesChanged (event primary) ──
// power-profiles-daemon emits PropertiesChanged on every ActiveProfile set —
// ours, external (CLI, other applets). Consumers subscribe here instead of
// polling readProfile() every 10s.

const profileListeners = new Set<() => void>()
let profileSubId: number | null = null

function ensureProfileSignal(): void {
  if (profileSubId !== null) return
  try {
    profileSubId = Gio.DBus.system.signal_subscribe(
      SERVICE,
      PROPERTIES_IFACE,
      "PropertiesChanged",
      PATH,
      null,
      Gio.DBusSignalFlags.NONE,
      (_conn, _sender, _path, _iface, _signal, _params) => {
        for (const fn of profileListeners) {
          try {
            fn()
          } catch (e) {
            print(`[power-profile] listener threw: ${e}`)
          }
        }
      },
    )
  } catch (e) {
    print(`[power-profile] signal_subscribe failed: ${e}`)
    profileSubId = null
  }
}

/** Subscribe to ActiveProfile changes (DBus PropertiesChanged). Returns an
 *  unsubscribe fn (gnim onCleanup-compatible). Client created lazily on the
 *  first subscriber. */
export function onProfileChanged(fn: () => void): () => void {
  ensureProfileSignal()
  profileListeners.add(fn)
  return () => {
    profileListeners.delete(fn)
  }
}
