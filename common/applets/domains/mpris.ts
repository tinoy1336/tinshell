/**
 * common/applets/domains/mpris.ts — event-driven MPRIS status source.
 *
 * Session-bus D-Bus signals, no subprocess:
 *   - org.freedesktop.DBus NameOwnerChanged (arg0namespace
 *     "org.mpris.MediaPlayer2.") → players appear/disappear (drives the
 *     media applet's auto-hide rule and the player map).
 *   - org.freedesktop.DBus.Properties PropertiesChanged with arg0
 *     org.mpris.MediaPlayer2.Player → PlaybackStatus / Position / Metadata
 *     (mpris:length, xesam:title, xesam:artist) updates from any player.
 *   - org.mpris.MediaPlayer2.Player Seeked → position jumps.
 *
 * The ACTIVE player is the most recently PLAYING one, else the most recently
 * seen — the same choice playerctl's {{playerName}} makes. The player name is
 * the well-known name suffix (e.g. "chromium" from
 * org.mpris.MediaPlayer2.chromium), so ringColours.mediaByPlayer keys keep
 * working.
 *
 * The published snapshot carries the track metadata the media applet matches
 * windows on (title/artist), so no caller shells out to playerctl for it.
 *
 * safetyRefresh() re-lists the bus and re-reads the active player's position
 * — the slow safety-net poll (timing.poll.media) calls it so missed signals
 * and position drift self-heal without a subprocess.
 *
 * TRANSPORT ACTIONS: `playPause` / `next` / `previous` are request-path members
 * (mutators — owner-only over the socket) that act on the player the last
 * emit() reported as active; see `activeWellKnown`.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ignore } from "@common/log/logger"

const MPRIS_PREFIX = "org.mpris.MediaPlayer2."
const PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"
const PLAYER_PATH = "/org/mpris/MediaPlayer2"

export interface MprisState {
  playing: boolean
  noPlayer: boolean
  positionUs: number
  lengthUs: number
  player: string // well-known name suffix ("chromium", "spotify", ...)
  /** Track metadata from the player's Metadata dict ("" when absent). */
  title: string
  artist: string
  sampledAtUs: number // monotonic time of the last position sample
}

export interface MprisController {
  stop: () => void
  safetyRefresh: () => void
}

interface PlayerEntry {
  unique: string
  name: string
  playing: boolean
  positionUs: number
  lengthUs: number
  title: string
  artist: string
  lastSeenUs: number
}

/** The well-known name of the player the LAST emit() reported as active — the
 *  target of the exported transport actions. Module scope because those actions
 *  are stateless request-path members (`applets mpris playPause`): the
 *  controller is created per subscriber, so its state is not reachable from
 *  them. It is the player the applet is showing — the one the user means when
 *  they press Play/Pause on its disc. */
let activeWellKnown: string | null = null

/** Copy the published fields out of a Metadata a{sv} variant. */
function applyMetadata(e: PlayerEntry, metadataVariant: GLib.Variant): void {
  try {
    const n = metadataVariant.n_children()
    for (let j = 0; j < n; j++) {
      const mentry = metadataVariant.get_child_value(j)
      const key = mentry.get_child_value(0).get_string()[0]
      const v = mentry.get_child_value(1).get_variant()
      if (key === "mpris:length") e.lengthUs = Number(v.get_int64()) || 0
      else if (key === "xesam:title") e.title = v.get_string()[0] ?? ""
      else if (key === "xesam:artist") {
        // xesam:artist is a LIST of performer credits.
        const list = v.recursiveUnpack()
        e.artist = Array.isArray(list) ? list.join(", ") : String(list ?? "")
      }
    }
  } catch (e) {
    ignore("mpris metadata parse", e)
  }
}

/** Parse PlaybackStatus/Position/Metadata out of an a{sv} dict variant. */
function applyDict(e: PlayerEntry, dict: GLib.Variant): void {
  const n = dict.n_children()
  for (let i = 0; i < n; i++) {
    const entry = dict.get_child_value(i)
    const key = entry.get_child_value(0).get_string()[0]
    const v = entry.get_child_value(1).get_variant()
    try {
      if (key === "PlaybackStatus") e.playing = v.get_string()[0] === "Playing"
      else if (key === "Position") e.positionUs = Number(v.get_int64()) || 0
      else if (key === "Metadata") applyMetadata(e, v)
    } catch (e) {
      ignore("mpris property apply", e)
    }
  }
}

export function mprisState(onChange: (s: MprisState) => void): MprisController {
  const bus = Gio.DBus.session
  const players = new Map<string, PlayerEntry>() // unique name -> entry
  const subIds: number[] = []
  let stopped = false

  function emit(): void {
    if (stopped) return
    let active: PlayerEntry | null = null
    let seen: PlayerEntry | null = null
    for (const e of players.values()) {
      if (e.playing && (!active || e.lastSeenUs > active.lastSeenUs)) active = e
      if (!seen || e.lastSeenUs > seen.lastSeenUs) seen = e
    }
    const e = active ?? seen
    activeWellKnown = e ? `${MPRIS_PREFIX}${e.name}` : null
    onChange({
      playing: e?.playing ?? false,
      noPlayer: players.size === 0,
      positionUs: e?.positionUs ?? 0,
      lengthUs: e?.lengthUs ?? 0,
      player: e?.name ?? "",
      title: e?.title ?? "",
      artist: e?.artist ?? "",
      sampledAtUs: GLib.get_monotonic_time(),
    })
  }

  function seedPlayer(wellKnown: string, unique: string): void {
    // Read the player's current properties via GetAll to populate the entry.
    bus.call(
      wellKnown,
      PLAYER_PATH,
      "org.freedesktop.DBus.Properties",
      "GetAll",
      new GLib.Variant("(s)", [PLAYER_IFACE]),
      new GLib.VariantType("(a{sv})"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_obj: any, res: any) => {
        try {
          const reply = bus.call_finish(res)
          const e: PlayerEntry = {
            unique,
            name: wellKnown.slice(MPRIS_PREFIX.length),
            playing: false,
            positionUs: 0,
            lengthUs: 0,
            title: "",
            artist: "",
            lastSeenUs: GLib.get_monotonic_time(),
          }
          applyDict(e, reply.get_child_value(0))
          players.set(unique, e)
          emit()
        } catch (e) {
          // The player left the bus between ListNames and the property read.
          ignore("mpris player vanished mid-seed", e)
        }
      },
    )
  }

  // ── Initial seed: enumerate the current players ──
  function listPlayers(): void {
    bus.call(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListNames",
      null,
      new GLib.VariantType("(as)"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_obj: any, res: any) => {
        try {
          // ListNames returns (as) — ONE child (the name array). deepUnpack
          // yields [string[]]; destructuring a second element here (the old
          // `[, names]` form) made `names` undefined and silently skipped the
          // whole seed loop — players already on the bus at (re)build time
          // were never seen (media applet stuck hidden in overflow).
          const [names] = bus.call_finish(res).deepUnpack() as [string[]]
          for (const name of names) {
            if (!name.startsWith(MPRIS_PREFIX)) continue
            bus.call(
              "org.freedesktop.DBus",
              "/org/freedesktop/DBus",
              "org.freedesktop.DBus",
              "GetNameOwner",
              new GLib.Variant("(s)", [name]),
              new GLib.VariantType("(s)"),
              Gio.DBusCallFlags.NONE,
              -1,
              null,
              (_o2: any, res2: any) => {
                try {
                  const [unique] = bus.call_finish(res2).deepUnpack() as [string]
                  seedPlayer(name, unique)
                } catch (e) {
                  ignore("mpris name-owner lookup", e)
                }
              },
            )
          }
        } catch (e) {
          ignore("mpris initial player seed", e)
        }
        // Emit even when the list is empty (or the call failed) — the
        // no-player state must reach the applet so the auto-hide rule fires;
        // without this the applet stays visible forever with no players.
        emit()
      },
    )
  }

  // ── Player appear/disappear ──
  // arg0 is matched EXACTLY (gjs exposes no arg0namespace), so the MPRIS
  // namespace filter happens in the callback via the name prefix.
  subIds.push(
    bus.signal_subscribe(
      "org.freedesktop.DBus",
      "org.freedesktop.DBus",
      "NameOwnerChanged",
      "/org/freedesktop/DBus",
      null,
      Gio.DBusSignalFlags.NONE,
      (_c: any, _s: any, _p: any, _i: any, _sig: any, params: GLib.Variant) => {
        try {
          const name = params.get_child_value(0).get_string()[0]
          if (!name.startsWith(MPRIS_PREFIX)) return
          const oldOwner = params.get_child_value(1).get_string()[0]
          const newOwner = params.get_child_value(2).get_string()[0]
          if (newOwner) seedPlayer(name, newOwner)
          else if (oldOwner && players.delete(oldOwner)) emit()
        } catch (e) {
          ignore("mpris name-owner-changed", e)
        }
      },
    ),
  )

  // ── Player property changes (PlaybackStatus / Position / Metadata) ──
  // arg0 is an EXACT server-side match on PropertiesChanged's interface arg
  // (the trailing-dot namespace form does not work — that is a separate
  // arg0namespace concept gjs doesn't expose). The sender is the player's
  // unique name, which the map keys on.
  subIds.push(
    bus.signal_subscribe(
      null,
      "org.freedesktop.DBus.Properties",
      "PropertiesChanged",
      null,
      PLAYER_IFACE,
      Gio.DBusSignalFlags.NONE,
      (_c: any, sender: any, _p: any, _i: any, _sig: any, params: GLib.Variant) => {
        try {
          const e = players.get(sender ?? "")
          if (!e) return
          applyDict(e, params.get_child_value(1))
          e.lastSeenUs = GLib.get_monotonic_time()
          emit()
        } catch (e) {
          ignore("mpris properties-changed", e)
        }
      },
    ),
  )

  // ── Seeked (position jumps) ──
  subIds.push(
    bus.signal_subscribe(
      null,
      PLAYER_IFACE,
      "Seeked",
      PLAYER_PATH,
      null,
      Gio.DBusSignalFlags.NONE,
      (_c: any, sender: any, _p: any, _i: any, _sig: any, params: GLib.Variant) => {
        try {
          const e = players.get(sender ?? "")
          if (!e) return
          e.positionUs = Number(params.get_child_value(0).get_int64()) || 0
          e.lastSeenUs = GLib.get_monotonic_time()
          emit()
        } catch (e) {
          ignore("mpris seeked signal", e)
        }
      },
    ),
  )

  listPlayers()

  return {
    stop: () => {
      stopped = true
      for (const id of subIds) bus.signal_unsubscribe(id)
      subIds.length = 0
      players.clear()
    },
    safetyRefresh: () => {
      // Re-list (self-heals missed appear/disappear) + resync the active
      // player's position (self-heals glide drift) — all DBus, no subprocess.
      listPlayers()
      let active: PlayerEntry | null = null
      for (const e of players.values()) {
        if (e.playing && (!active || e.lastSeenUs > active.lastSeenUs)) active = e
      }
      const target = active
      if (!target) return
      bus.call(
        target.unique,
        PLAYER_PATH,
        "org.freedesktop.DBus.Properties",
        "Get",
        new GLib.Variant("(ss)", [PLAYER_IFACE, "Position"]),
        new GLib.VariantType("(v)"),
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_o: any, res: any) => {
          try {
            const reply = bus.call_finish(res)
            target.positionUs = Number(reply.get_child_value(0).get_variant().get_int64()) || 0
            target.lastSeenUs = GLib.get_monotonic_time()
            emit()
          } catch (e) {
            ignore("mpris position poll", e)
          }
        },
      )
    },
  }
}

// ── Transport actions (request-path members) ──

/** Fire-and-forget a player method on the active player. No player = no-op. */
function playerCall(method: "PlayPause" | "Next" | "Previous"): void {
  const target = activeWellKnown
  if (!target) return
  try {
    Gio.DBus.session.call(
      target,
      PLAYER_PATH,
      PLAYER_IFACE,
      method,
      null,
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_o: any, res: any) => {
        try {
          Gio.DBus.session.call_finish(res)
        } catch (e) {
          ignore(`mpris ${method}`, e)
        }
      },
    )
  } catch (e) {
    ignore(`mpris ${method} call`, e)
  }
}

/** Toggle play/pause on the active player. Owner-only over the socket. */
export function playPause(): void {
  playerCall("PlayPause")
}

/** Skip to the next track. Owner-only over the socket. */
export function next(): void {
  playerCall("Next")
}

/** Skip to the previous track. Owner-only over the socket. */
export function previous(): void {
  playerCall("Previous")
}
