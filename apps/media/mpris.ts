/**
 * mpris.ts — MPRIS D-Bus SERVER for the media app.
 *
 * Registers `org.mpris.MediaPlayer2.player` on the session bus so system
 * multimedia controls / media keys / playerctl can drive the app. AstalMpris
 * is client-only (it CONTROLS other players) — the app must serve MPRIS
 * itself, so this module owns the bus name and exports both MPRIS interfaces
 * (`org.mpris.MediaPlayer2` + `org.mpris.MediaPlayer2.Player`) at
 * `/org/mpris/MediaPlayer2` via raw Gio.DBus (GJS has no native MPRIS server
 * wrapper). GJS 1.88 binds Gio.DBusConnection.register_object with THREE
 * closures (method_call, get_property, set_property) rather than a
 * GDBusInterfaceVTable struct, and takes ONE Gio.DBusInterfaceInfo per call —
 * so the object is registered once per interface, same path, shared handlers
 * (verified against Gio-2.0.gir + a headless probe).
 *
 * All state flows through the active pipeline's getStatus()/events — the
 * playbin3 pipeline stays the single source of truth. Every DBus callback is
 * wrapped in try/catch + log: a throwing handler breaks bus dispatch for the
 * whole connection.
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ignore, log } from "@common/log/logger"
import type { MediaEvent, MediaPipeline, MediaStatus, PlaylistEntry } from "@common/media/types"
import { getActiveInstance, onActiveChange } from "./active"
import { openPath } from "./window"

const BUS_NAME = "org.mpris.MediaPlayer2.player"
const PATH = "/org/mpris/MediaPlayer2"
const PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"
const ROOT_IFACE = "org.mpris.MediaPlayer2"

const XML = `<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek">
      <arg type="x" direction="in" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <method name="OpenUri">
      <arg type="s" direction="in" name="Uri"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Shuffle" type="b" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
  </interface>
</node>`

let nodeInfo: Gio.DBusNodeInfo | null = null
let conn: Gio.DBusConnection | null = null
let nameId = 0
let regIds: number[] = []
let unsub: (() => void) | null = null
let mediaUnsub: (() => void) | null = null

// ── active-instance routing ──
// MPRIS represents the ACTIVE TRANSPORT window (most-recently-playing else
// last-focused — selected by window.tsx via media.setActiveInstance). All
// state reads + method calls route through it; with no transport window open
// the app reports Stopped/empty and methods no-op.

const EMPTY_STATUS: MediaStatus = {
  timePos: null,
  duration: null,
  title: "",
  artist: "",
  album: "",
  pause: true,
  volume: 100,
  mute: false,
  speed: 1,
  playlist: [],
}

function mediaStatus(): MediaStatus {
  return getActiveInstance()?.getStatus() ?? EMPTY_STATUS
}

/** Run `fn` against the active instance (no-op when none is open). */
function act(fn: (m: MediaPipeline) => void): void {
  const m = getActiveInstance()
  if (m) fn(m)
}

// ── property derivation (single source of truth = media.getStatus()) ──

function playbackStatus(s: MediaStatus): string {
  if (s.pause) return s.duration === null ? "Stopped" : "Paused"
  return "Playing"
}

function currentIndex(pl: PlaylistEntry[]): number {
  return pl.findIndex((e) => e.current)
}

function metadataVariant(s: MediaStatus): GLib.Variant {
  const meta: Record<string, GLib.Variant> = {
    "mpris:trackid": new GLib.Variant("o", "/org/mpris/MediaPlayer2/TrackList/NoTrack"),
    "mpris:length": new GLib.Variant("x", Math.max(0, Math.round((s.duration ?? 0) * 1e6))),
    "xesam:title": new GLib.Variant("s", s.title || ""),
    "xesam:artist": new GLib.Variant("as", s.artist ? [s.artist] : []),
    "xesam:album": new GLib.Variant("s", s.album || ""),
  }
  return new GLib.Variant("a{sv}", meta)
}

// ── DBus vtable (one vtable dispatches both interfaces by name) ──

function handleMethodCall(
  _conn: Gio.DBusConnection,
  _sender: string,
  _objectPath: string,
  interfaceName: string,
  methodName: string,
  params: GLib.Variant,
  invocation: Gio.DBusMethodInvocation,
): void {
  try {
    if (interfaceName === ROOT_IFACE) {
      if (methodName === "Raise" || methodName === "Quit") {
        invocation.return_value(null)
      } else {
        invocation.return_dbus_error(
          "org.freedesktop.DBus.Error.UnknownMethod",
          `No such method ${methodName}`,
        )
      }
      return
    }
    switch (methodName) {
      case "Play":
        act((m) => m.play())
        invocation.return_value(null)
        break
      case "Pause":
        act((m) => m.pause())
        invocation.return_value(null)
        break
      case "PlayPause":
        act((m) => m.toggle())
        invocation.return_value(null)
        break
      case "Stop":
        act((m) => m.pause())
        invocation.return_value(null)
        break
      case "Next":
        act((m) => m.next())
        invocation.return_value(null)
        break
      case "Previous":
        act((m) => m.prev())
        invocation.return_value(null)
        break
      case "Seek": {
        const offsetUs = params.get_child_value(0).get_int64()
        const m = getActiveInstance()
        if (m) {
          const s = m.getStatus()
          m.seekSeconds((s.timePos ?? 0) + offsetUs / 1e6)
          emitSeeked(Math.max(0, Math.round(((s.timePos ?? 0) + offsetUs / 1e6) * 1e6)))
        }
        invocation.return_value(null)
        break
      }
      case "SetPosition": {
        const posUs = params.get_child_value(1).get_int64()
        const m = getActiveInstance()
        if (m) {
          m.seekSeconds(posUs / 1e6)
          emitSeeked(posUs)
        }
        invocation.return_value(null)
        break
      }
      case "OpenUri": {
        // get_string() returns a [value, length] tuple per the GLib typings.
        const [uri] = params.get_child_value(0).get_string()
        if (uri) {
          if (getActiveInstance()) act((m) => m.open(uri))
          else openPath(uri) // no window → open a fresh media window
        }
        invocation.return_value(null)
        break
      }
      default:
        invocation.return_dbus_error(
          "org.freedesktop.DBus.Error.UnknownMethod",
          `No such method ${methodName}`,
        )
    }
  } catch (e) {
    log(`mpris method ${methodName} failed: ${(e as Error).message}`)
    try {
      invocation.return_dbus_error("org.freedesktop.DBus.Error.Failed", String(e))
    } catch (err) {
      // The invocation was already replied to (double reply is an error).
      ignore("mpris dbus error reply", err)
    }
  }
}

function handleGetProperty(
  _conn: Gio.DBusConnection,
  _sender: string,
  _objectPath: string,
  interfaceName: string,
  propertyName: string,
): GLib.Variant | null {
  try {
    const s = mediaStatus()
    if (interfaceName === ROOT_IFACE) {
      switch (propertyName) {
        case "CanQuit":
          return new GLib.Variant("b", true)
        case "CanRaise":
          return new GLib.Variant("b", true)
        case "Identity":
          return new GLib.Variant("s", "player")
        case "DesktopEntry":
          return new GLib.Variant("s", "")
        case "SupportedUriSchemes":
          return new GLib.Variant("as", [])
        case "SupportedMimeTypes":
          return new GLib.Variant("as", [])
        case "HasTrackList":
          return new GLib.Variant("b", false)
        default:
          return null
      }
    }
    switch (propertyName) {
      case "PlaybackStatus":
        return new GLib.Variant("s", playbackStatus(s))
      case "LoopStatus":
        return new GLib.Variant("s", "None")
      case "Rate":
        return new GLib.Variant("d", s.speed)
      case "Shuffle":
        return new GLib.Variant("b", false)
      case "Metadata":
        return metadataVariant(s)
      case "Volume":
        return new GLib.Variant("d", s.volume / 100)
      case "Position":
        return new GLib.Variant("x", Math.max(0, Math.round((s.timePos ?? 0) * 1e6)))
      case "MinimumRate":
        return new GLib.Variant("d", 0.5)
      case "MaximumRate":
        return new GLib.Variant("d", 2.0)
      case "CanGoNext": {
        const pl = s.playlist
        const cur = currentIndex(pl)
        return new GLib.Variant("b", pl.length > 0 && cur >= 0 && cur < pl.length - 1)
      }
      case "CanGoPrevious": {
        const cur = currentIndex(s.playlist)
        return new GLib.Variant("b", cur > 0)
      }
      case "CanPlay":
        return new GLib.Variant("b", true)
      case "CanPause":
        return new GLib.Variant("b", true)
      case "CanSeek":
        return new GLib.Variant("b", true)
      case "CanControl":
        return new GLib.Variant("b", true)
      default:
        return null
    }
  } catch (e) {
    log(`mpris get ${propertyName} failed: ${(e as Error).message}`)
    return null
  }
}

function handleSetProperty(
  _conn: Gio.DBusConnection,
  _sender: string,
  _objectPath: string,
  interfaceName: string,
  propertyName: string,
  value: GLib.Variant,
): boolean {
  try {
    if (interfaceName !== PLAYER_IFACE) return false
    if (propertyName === "Rate") {
      const rate = value.get_double()
      if (rate > 0) act((m) => m.setSpeed(rate))
      return true
    }
    if (propertyName === "Volume") {
      const v = value.get_double()
      act((m) => m.setVolume(Math.max(0, Math.min(1, v)) * 100))
      return true
    }
    return false
  } catch (e) {
    log(`mpris set ${propertyName} failed: ${(e as Error).message}`)
    return false
  }
}

// GJS 1.88 binds Gio.DBusConnection.register_object with THREE closures
// (method_call, get_property, set_property) instead of a GDBusInterfaceVTable
// struct — verified against Gio-2.0.gir + a live headless probe. Plain JS
// functions are accepted at runtime; cast for the Closure-typed typings.

// ── signals ──

function emitSeeked(positionUs: number): void {
  try {
    conn?.emit_signal(
      null,
      PATH,
      PLAYER_IFACE,
      "Seeked",
      new GLib.Variant("(x)", [Math.max(0, Math.round(positionUs))]),
    )
  } catch (e) {
    log(`mpris Seeked emit failed: ${(e as Error).message}`)
  }
}

function emitProps(changed: Record<string, GLib.Variant>, invalidated: string[] = []): void {
  try {
    conn?.emit_signal(
      null,
      PATH,
      "org.freedesktop.DBus.Properties",
      "PropertiesChanged",
      new GLib.Variant("(sa{sv}as)", [PLAYER_IFACE, changed, invalidated]),
    )
  } catch (e) {
    log(`mpris PropertiesChanged emit failed: ${(e as Error).message}`)
  }
}

// ── lifecycle ──

/** Register the MPRIS bus name + object. Idempotent; failures are logged,
 * never thrown (the app must keep running without MPRIS). */
export function startMpris(): void {
  if (conn) return
  try {
    nodeInfo = Gio.DBusNodeInfo.new_for_xml(XML)
    conn = Gio.bus_get_sync(Gio.BusType.SESSION, null)
    nameId = Gio.bus_own_name_on_connection(conn, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null)
    // register_object takes ONE Gio.DBusInterfaceInfo per call — register the
    // object once per interface (same path, shared handler closures).
    const r1 = conn.register_object(
      PATH,
      nodeInfo.interfaces[0],
      handleMethodCall as any,
      handleGetProperty as any,
      handleSetProperty as any,
    )
    const r2 = conn.register_object(
      PATH,
      nodeInfo.interfaces[1],
      handleMethodCall as any,
      handleGetProperty as any,
      handleSetProperty as any,
    )
    if (r1 === 0 || r2 === 0) throw new Error("register_object returned 0")
    regIds = [r1, r2]
    // MPRIS reflects the ACTIVE transport instance — subscribe to its events
    // and resubscribe whenever the active window switches.
    function onMediaEvent(ev: MediaEvent): void {
      try {
        const s = mediaStatus()
        switch (ev.kind) {
          case "state": {
            const changed: Record<string, GLib.Variant> = {
              PlaybackStatus: new GLib.Variant("s", playbackStatus(s)),
              CanGoNext: new GLib.Variant(
                "b",
                s.playlist.length > 0 && currentIndex(s.playlist) < s.playlist.length - 1,
              ),
              CanGoPrevious: new GLib.Variant("b", currentIndex(s.playlist) > 0),
            }
            emitProps(changed)
            break
          }
          case "title":
            emitProps({ Metadata: metadataVariant(s) })
            break
          case "volume":
            emitProps({ Volume: new GLib.Variant("d", s.volume / 100) })
            break
          default:
            break
        }
      } catch (e) {
        log(`mpris event handler failed: ${(e as Error).message}`)
      }
    }
    function subscribeActive(): void {
      if (mediaUnsub) {
        mediaUnsub()
        mediaUnsub = null
      }
      const m = getActiveInstance()
      if (m) mediaUnsub = m.onEvent(onMediaEvent)
      else emitProps({ PlaybackStatus: new GLib.Variant("s", "Stopped") })
    }
    unsub = onActiveChange(() => subscribeActive())
    subscribeActive()
    log(`mpris registered: ${BUS_NAME}`)
  } catch (e) {
    log(`mpris start failed: ${(e as Error).message}`)
    conn = null
  }
}

/** Unregister + release the bus name. Idempotent. */
export function stopMpris(): void {
  if (mediaUnsub) {
    mediaUnsub()
    mediaUnsub = null
  }
  if (unsub) {
    unsub()
    unsub = null
  }
  if (conn) {
    for (const id of regIds) {
      try {
        conn.unregister_object(id)
      } catch (e) {
        // The object is already unregistered with the connection.
        ignore("mpris object unregister", e)
      }
    }
    regIds = []
    if (nameId) {
      try {
        Gio.bus_unown_name(nameId)
      } catch (e) {
        // The name is already unowned.
        ignore("mpris bus name unown", e)
      }
      nameId = 0
    }
    conn = null
  }
  nodeInfo = null
}
