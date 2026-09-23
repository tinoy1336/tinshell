import GLib from "gi://GLib"
import type { MprisState } from "@common/applets/backend"
import { createStepApplet } from "@common/applets/shared/create-step-applet"
import { clamp01, drawDisc, drawGlyph, drawRings } from "@common/applets/shared/draw-utils"
import type { AppletContext, DrawIcon } from "@common/applets/types"
import { focusWindow, focusWorkspace, hyprctlText } from "@common/hyprland/dispatch"
import { ignore } from "@common/log/logger"
import { onCleanup } from "gnim"

export default function mount({ port, hooks, config, backend }: AppletContext): void {
  const icon = port.icon
  let localPlaying = false
  let localNoPlayer = false

  // ── Overflow/idle lifecycle (timing.mediaIdleMs) ──
  // Monotonic µs of the last playback ACTIVITY: refreshed on every Playing
  // snapshot, and latched at the playing→paused transition (the grace window
  // starts at the STOP, not at the last position sync). 0 = no playback ever
  // observed in this applet instance.
  let lastActiveUs = 0
  let idleTimerId: number | null = null
  // True once the idle grace has fully elapsed while paused — the overflow
  // move already happened and a LATER paused snapshot must NOT un-park the
  // applet. The 30s safety poll re-applies the same paused state on every
  // tick; without this latch the unconditional unhide below slid the icon
  // back out of overflow on the first post-grace poll, and nothing re-armed
  // the timer (the grace only starts on a transition) — the media applet
  // then sat visible in the row forever.
  let idleOverflowed = false
  // True while DESPAWNED (no MPRIS player exists at all): the applet is
  // row-deactivated — hidden in EVERY overflow mode (even "show") and
  // excluded from the reveal fan-out — instead of parked in overflow.
  let despawned = false

  // ── Playback progress (for the smooth ring) ──
  // Sampled position/length from the MPRIS snapshot (µs) + the monotonic time of the
  // sample. While playing the ring extrapolates `pos + (now - sampledAt)` so
  // it GLIDES continuously between the (2s) polls instead of stepping — a
  // 50ms tick drives the redraws while playing and stops when paused.
  let playPosUs = 0
  let playLengthUs = 0
  let sampledAtUs = 0
  let tickId: number | null = null
  /** The active (or most recent) player: its bus-name suffix drives the ring
   *  colour via `ringColours.mediaByPlayer`; title/artist feed the Goto-player
   *  window match. All three come from the last MPRIS snapshot. */
  let activePlayer = ""
  let activeTitle = ""
  let activeArtist = ""

  function currentProgress(): number {
    if (playLengthUs <= 0) return 0
    const p = localPlaying ? playPosUs + (GLib.get_monotonic_time() - sampledAtUs) : playPosUs
    return Math.max(0, Math.min(1, p / playLengthUs))
  }

  /** Run (or stop) the per-frame redraw tick — active only while playing. */
  function updateTick(): void {
    if (localPlaying && tickId === null) {
      tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        if (!localPlaying) {
          tickId = null
          return GLib.SOURCE_REMOVE
        }
        icon.queue_draw()
        return GLib.SOURCE_CONTINUE
      })
    } else if (!localPlaying && tickId !== null) {
      GLib.source_remove(tickId)
      tickId = null
    }
  }

  const pos = port.geometry.position
  // Right-edge docks swap Previous/Next (Next at index 2, Previous at index 3).
  const swap = pos.startsWith("right")

  const prevIdx = swap ? 3 : 2
  const nextIdx = swap ? 2 : 3

  // Goto toggle state: while engaged (the media window focused), the Goto
  // step shows the return glyph and clicking it focuses the window/workspace
  // the user was pulled from. Per-applet-instance (there is only one media
  // applet).
  let gotoOrigin: { addr: string | null; ws: number } | null = null

  // Unified Play/Pause (the glyph reflects the live player state) + Goto
  // player (focus the window that's actually playing; engaged again = return
  // to the origin) + Prev/Next (swapped on right-edge docks).
  const steps = [
    {
      label: "Play/Pause",
      get emoji() {
        return localPlaying
          ? config.appearance.icons.mediaPause
          : config.appearance.icons.mediaPlaying
      },
    },
    {
      label: "Goto player",
      get emoji() {
        return gotoOrigin ? config.appearance.icons.mediaReturn : config.appearance.icons.mediaOpen
      },
    },
    swap
      ? {
          label: "Next",
          get emoji() {
            return config.appearance.icons.mediaNext
          },
        }
      : {
          label: "Previous",
          get emoji() {
            return config.appearance.icons.mediaPrev
          },
        },
    swap
      ? {
          label: "Previous",
          get emoji() {
            return config.appearance.icons.mediaPrev
          },
        }
      : {
          label: "Next",
          get emoji() {
            return config.appearance.icons.mediaNext
          },
        },
  ]

  const stepColours = config.appearance.stepColours.media
  const colours = swap
    ? [stepColours[0], stepColours[1], stepColours[3], stepColours[2]]
    : stepColours

  /** Goto player — a toggle. First click: remember the current window +
   *  workspace, then switch to + focus the window actually playing the track
   *  (title match first, class fallback — see common/applets/domains/media-window.ts).
   *  Second click: return to the origin window (or its workspace if it
   *  closed). `hl.dsp.focus` (hyprland's Lua dispatcher API) switches the workspace as
   *  part of focusing, so one dispatch per leg is enough. The match inputs are
   *  the LAST published MPRIS snapshot — no subprocess is spawned for them. */
  function gotoPlayer(): void {
    void (async () => {
      const clientsJson = await hyprctlText("clients")
      if (clientsJson === null) return
      const win = backend.mediaWindow.findMediaWindow(
        clientsJson,
        activePlayer,
        activeTitle,
        activeArtist,
      )
      if (!win) return

      // Engaged → return to the origin.
      if (gotoOrigin) {
        const origin = gotoOrigin
        gotoOrigin = null
        if (origin.addr !== null && clientsJson.includes(origin.addr)) {
          focusWindow(origin.addr)
        } else {
          focusWorkspace(origin.ws)
        }
        icon.queue_draw()
        return
      }

      // Not engaged: capture the origin, then go.
      const active = (await hyprctlText("activewindow")) ?? ""
      let addr: string | null = null
      let ws = win.ws
      try {
        const a = JSON.parse(active)
        addr = a.address ?? null
        ws = a.workspace?.id ?? ws
      } catch (e) {
        ignore("hyprctl activewindow parse", e)
      }
      // Already on the media window — nothing to toggle.
      if (addr === win.addr) return
      gotoOrigin = { addr, ws }
      focusWindow(win.addr)
      icon.queue_draw()
    })()
  }

  // ── Overflow / idle lifecycle ──

  function clearIdleTimer(): void {
    if (idleTimerId !== null) {
      GLib.source_remove(idleTimerId)
      idleTimerId = null
    }
  }

  /** The OVERFLOW move after the idle grace: flips ONLY the auto-hide rule —
   *  every piece of applet state (progress ring, activePlayer, goto origin)
   *  is preserved, so the move never resets anything. */
  function enterOverflowIdle(): void {
    idleTimerId = null
    if (localPlaying || localNoPlayer || despawned) return
    idleOverflowed = true
    hooks.setAppletHidden(port.name, true)
  }

  /** (Re)arm the idle timer from lastActiveUs + timing.mediaIdleMs (read at
   *  arm time — a live config change applies on the next transition). */
  function armIdleTimer(): void {
    clearIdleTimer()
    const idleUs = Math.max(0, config.timing.mediaIdleMs) * 1000
    const remainUs = idleUs - (GLib.get_monotonic_time() - lastActiveUs)
    if (remainUs <= 0) {
      enterOverflowIdle()
      return
    }
    idleTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(remainUs / 1000), () => {
      enterOverflowIdle()
      return GLib.SOURCE_REMOVE
    })
  }

  /** Apply an MPRIS state snapshot (from the event source or the safety poll)
   *  to the icon + the overflow/despawn lifecycle. Mirrors the old playerctl
   *  parse exactly.
   *
   *  Lifecycle:
   *   - playing → row visible (IMMEDIATELY, even from overflow/despawn);
   *     every playing snapshot refreshes lastActiveUs (the 5-min timer
   *     restarts on every playback activity).
   *   - player exists, paused → grace starts at the playing→paused
   *     transition (or at first sight of a never-playing player); after
   *     timing.mediaIdleMs the applet moves INTO OVERFLOW, state preserved.
   *   - no player at all → DESPAWN (row-deactivated; not parked in overflow);
   *     a fresh player re-spawns it normally. */
  function applyStatus(s: MprisState): void {
    if (s.noPlayer) {
      clearIdleTimer()
      lastActiveUs = 0
      idleOverflowed = false // fresh episode for the next player that appears
      if (!localNoPlayer || localPlaying || playPosUs !== 0 || playLengthUs !== 0) {
        localNoPlayer = true
        localPlaying = false
        playPosUs = 0
        playLengthUs = 0
        updateTick()
        if (!port.isHiddenState()) icon.queue_draw()
      }
      if (!despawned) {
        despawned = true
        // Deactivate FIRST (drives the fade-out/park transition); the
        // autoHidden flip behind it is the bookkeeping half of "gone".
        hooks.setAppletDeactivated(port.name, true)
        hooks.setAppletHidden(port.name, true)
      }
      return
    }
    if (despawned) {
      // Re-spawn after a despawn: restore row eligibility; the autoHidden
      // rule below (from the playing state) completes the transition.
      despawned = false
      hooks.setAppletDeactivated(port.name, false)
    }
    if (s.playing) {
      lastActiveUs = GLib.get_monotonic_time()
      idleOverflowed = false // playback resumed — the applet is row-eligible again
      clearIdleTimer()
    } else if (localPlaying) {
      // playing → paused transition: the idle grace starts at the STOP.
      lastActiveUs = GLib.get_monotonic_time()
      armIdleTimer()
    } else if (lastActiveUs <= 0) {
      // Player present but never seen playing (seeded paused): seed the
      // grace window so it shows for mediaIdleMs before overflowing.
      lastActiveUs = GLib.get_monotonic_time()
      armIdleTimer()
    }
    const changed =
      s.playing !== localPlaying || s.noPlayer !== localNoPlayer || s.player !== activePlayer
    localPlaying = s.playing
    localNoPlayer = false
    activePlayer = s.player
    activeTitle = s.title
    activeArtist = s.artist
    playPosUs = s.positionUs
    playLengthUs = s.lengthUs
    sampledAtUs = s.sampledAtUs
    updateTick()
    if (changed && !port.isHiddenState()) icon.queue_draw()
    // Un-hide only while the icon belongs in the row: playing, or paused
    // INSIDE the grace window. Once the grace elapsed the timer already
    // parked us in overflow — re-asserting visible here (every snapshot, incl.
    // the 30s safety poll) would undo that move and strand us visible.
    if (!idleOverflowed) hooks.setAppletHidden(port.name, false)
  }

  // ── Icon ──

  const drawMediaIcon: DrawIcon = (
    cr,
    w,
    h,
    _value,
    _state,
    ringFill = 1,
    _skipDisc,
    _textValue,
  ) => {
    const rf = clamp01(ringFill)
    const size = Math.min(w, h)
    const cx = w / 2
    const cy = h / 2
    const ic = config.appearance.icons
    drawDisc(config, cr, size / 2, size / 2, size / 2)

    // Playback progress ring — tracks the current track's position. The arc
    // glides continuously while playing (wall-clock extrapolation between the
    // 2s polls, redrawn by the 50ms tick); holds still while paused. No ring
    // for streams without a known length (mpris:length = 0).
    if (rf > 0.001 && playLengthUs > 0) {
      const prog = currentProgress()
      if (prog > 0.001) {
        // The ring adapts to the CURRENTLY PLAYING media (most recent): the
        // colour follows the active player via ringColours.mediaByPlayer,
        // falling back to the base ringColours.media.
        const byPlayer = config.appearance.ringColours.mediaByPlayer
        const mc = byPlayer?.[activePlayer] ?? config.appearance.ringColours.media
        const radius = (config.layout.iconSize - config.appearance.ringThickness) / 2
        drawRings(
          cr,
          cx,
          cy,
          radius,
          config.appearance.ringThickness,
          [{ start: 0, end: prog * 100, colour: [mc.rgb[0], mc.rgb[1], mc.rgb[2], mc.alpha] }],
          rf,
        )
      }
    }

    const glyph = localPlaying ? ic.mediaPaused : ic.mediaPlaying
    drawGlyph(
      config,
      cr,
      size / 2,
      size / 2,
      glyph,
      config.fonts.iconSize,
      [0.9, 0.9, 0.9, rf],
      undefined,
      config.appearance.textShadow.alpha * rf,
    )
  }

  createStepApplet(port, {
    config,
    steps,
    getStepColour: (i: number) => colours[i],
    drawIcon: drawMediaIcon,
    getInitialStep: () => 0,
    onSelect: (step) => {
      if (step === 0) backend.mpris.playPause()
      else if (step === 1) gotoPlayer()
      else if (step === prevIdx) backend.mpris.previous()
      else if (step === nextIdx) backend.mpris.next()
    },
    logLabel: "media",
    // The closed-state dock glyph IS the same single Play/Pause emoji as step 0
    // (both reflect the live playback state), so when the panel opens on step 0
    // and the glyph matches, skip the cross-fade — the identical icon would
    // otherwise blink in place. Same parity as LockSession's dockGlyph.
    dockGlyph: {
      emoji: () =>
        localPlaying ? config.appearance.icons.mediaPause : config.appearance.icons.mediaPlaying,
      colour: config.appearance.glyphColour,
    },
  })

  // Event-driven MPRIS status (replaces the 2s playerctl subprocess poll):
  // player appear/disappear + PlaybackStatus/Position/Metadata changes arrive
  // as D-Bus signals; the applet reacts instantly. The safety-net poll below
  // only re-lists + resyncs the position every timing.poll.media (default 30s)
  // so missed signals and glide drift self-heal.
  const mpris = backend.mpris.mprisState(applyStatus)
  onCleanup(mpris.stop)

  const pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, config.timing.poll.media, () => {
    mpris.safetyRefresh()
    return GLib.SOURCE_CONTINUE
  })
  onCleanup(() => {
    GLib.source_remove(pollId)
    if (tickId !== null) GLib.source_remove(tickId)
    clearIdleTimer()
  })
}
