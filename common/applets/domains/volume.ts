/**
 * Volume domain — the default sink's level, mute state and device class.
 *
 * AstalWp connects to WirePlumber at factory time, so the sink is resolved on
 * the FIRST state read and never at module scope: a host that merely imports
 * this module (the request table, the in-process binder) must not connect. A
 * process with no default sink answers `available: false`, so a caller paints
 * its own "no output device" surface instead of a zero reading — and so does a
 * process whose sink WirePlumber has not bound yet (`sinkReady`): a not-yet-bound
 * endpoint reads as 0 %/muted, which is indistinguishable from a muted sink
 * unless availability is gated on it.
 *
 * CHANGE PATH: the sink's own property notifications (volume, mute, the
 * endpoint's device, a default-sink swap) write the reactive immediately, so a
 * drag or a media-key press is visible to every reader at once. The caller's
 * poll interval is the safety net of the hybrid pattern — it re-reads the sink
 * when a notification is missed (suspend/resume).
 *
 * ONE implementation: the volume applet and the overflow clock's transient
 * readout both read here, so no applet touches PipeWire itself.
 */

import AstalWp from "gi://AstalWp"
import GLib from "gi://GLib"
import { mkReactive, type Reactive, type ReactiveStore } from "@common/applets/utils/reactive"
import { ignore } from "@common/log/logger"

/** The active output's kind, classified from its PipeWire bus property and its
 *  form factor. */
export type SpeakerKind = "bluetooth" | "usb" | "headset" | "speaker"

export interface VolumeState {
  /** False while there is no reading to report — no PipeWire at all, no default
   *  sink selected, or an endpoint WirePlumber has not bound yet. `available`
   *  is the ONLY thing that separates "no reading yet" from a real sink the user
   *  muted at 0: an unavailable state carries the placeholder level 0/muted
   *  false, a real one carries the sink's own level and mute, so a consumer that
   *  needs "silent" must test `available && muted` and never the level alone. */
  available: boolean
  /** Sink level, 0..100. */
  volume: number
  muted: boolean
  kind: SpeakerKind
}

/** The state reported while there is no reading to report: no default sink, or
 *  a sink WirePlumber has not bound yet. */
const NO_SINK: VolumeState = { available: false, volume: 0, muted: false, kind: "speaker" }

/** The poll interval used when the caller passes a value the GLib timeout
 *  cannot take (non-finite or <= 0). */
const DEFAULT_POLL_MS = 30000

/** The reactive every caller shares (one sink read per process, like the other
 *  domains' pollers) and the tick the change notifications drive. */
let _state: ReactiveStore<VolumeState> | null = null
let _tick: (() => void) | null = null

/** The sink whose property notifications are currently armed. */
let _boundSpeaker: any = null
let _speakerSignalIds: number[] = []
let _wpArmed = false

/** Classify the sink's device: PipeWire bus (`device.bus` pw property:
 *  bluetooth / usb / pci / virtual) + form factor (headset/headphone/phone →
 *  headset). The ring colour follows, config-driven per type through
 *  `common/applets/volume/colour`. */
function classifyOutput(dev: any): SpeakerKind {
  let bus = ""
  let ff = ""
  try {
    bus = dev?.get_pw_property?.("device.bus") ?? ""
  } catch (e) {
    ignore("wp device.bus read", e)
  }
  try {
    ff = dev?.form_factor ?? ""
  } catch (e) {
    ignore("wp form_factor read", e)
  }
  if (bus === "bluetooth") return "bluetooth"
  if (bus === "usb") return "usb"
  if (ff === "headset" || ff === "headphone" || ff === "phone") return "headset"
  return "speaker"
}

/** Whether the endpoint accessor holds a REAL sink rather than a WirePlumber
 *  placeholder. Two tells, both read from the endpoint itself: WirePlumber
 *  assigns the node its id when it enumerates it, and the node's volume
 *  parameter — the per-channel volumes — lands one instant later. In a fresh
 *  process the accessor therefore answers a phantom (id 0, no path, no device,
 *  no channels) for a few ms and then a bound node whose parameter has not
 *  landed (id set, channels still empty); BOTH read `volume: 0, muted: true`,
 *  so neither is a reading. Only these two tells are judged: a null device is
 *  legitimate on a virtual sink, and the level itself is never a tell — a real
 *  sink the user muted at 0 has to stay available. A read that throws is not
 *  ready. */
export function sinkReady(speaker: any): boolean {
  try {
    if (!((speaker?.id ?? 0) > 0)) return false
    return (speaker.channels?.length ?? 0) > 0
  } catch (e) {
    ignore("sink readiness read", e)
    return false
  }
}

/** Re-read the sink because something it owns changed. */
function changed(): void {
  _tick?.()
}

/** Arm the default-sink swap on the WirePlumber proxy (once per process). */
function armWp(wp: any): void {
  if (_wpArmed) return
  _wpArmed = true
  try {
    wp.connect("notify::default-speaker", changed)
  } catch (e) {
    ignore("wp default-speaker signal", e)
  }
}

/** Arm the level / mute / device notifications on the CURRENT sink and drop the
 *  previous sink's (a stale sink's events would only re-read the current one —
 *  no value can be stranded, but the connections must not accumulate over sink
 *  swaps). */
function armSpeaker(speaker: any): void {
  if (!speaker || _boundSpeaker === speaker) return
  for (const id of _speakerSignalIds) {
    try {
      _boundSpeaker?.disconnect(id)
    } catch (e) {
      ignore("sink signal disconnect", e)
    }
  }
  _speakerSignalIds = []
  _boundSpeaker = speaker
  for (const signal of ["notify::volume", "notify::mute", "notify::device", "notify::is-default"]) {
    try {
      _speakerSignalIds.push(speaker.connect(signal, changed))
    } catch (e) {
      ignore(`sink ${signal}`, e)
    }
  }
}

/** The default sink, with its notifications armed. Null when the process has
 *  no WirePlumber connection or no default output — including a process whose
 *  session bus has no WirePlumber at all, where even the lookup can throw. The
 *  domain is bound in process by every host that mounts the volume applet (the
 *  dock and the greeter), so a throw here must not take a host down. */
function currentSink(): any | null {
  let wp: any = null
  try {
    wp = AstalWp.get_default()
  } catch (e) {
    ignore("AstalWp.get_default", e)
    return null
  }
  if (!wp) return null
  armWp(wp)
  const speaker: any = wp.defaultSpeaker ?? null
  armSpeaker(speaker)
  return speaker
}

function readSink(): VolumeState {
  const speaker = currentSink()
  if (!speaker || !sinkReady(speaker)) return NO_SINK
  let volume = 0
  let muted = false
  try {
    volume = Math.round((speaker.get_volume() ?? 0) * 100)
  } catch (e) {
    ignore("sink get_volume", e)
  }
  try {
    muted = speaker.get_mute() ?? false
  } catch (e) {
    ignore("sink get_mute", e)
  }
  return {
    available: true,
    volume: Math.max(0, Math.min(100, volume)),
    muted,
    kind: classifyOutput(speaker.device),
  }
}

/** One spelling of a state for change detection. */
function stateKey(s: VolumeState): string {
  return `${s.available}|${s.volume}|${s.muted}|${s.kind}`
}

/** The default sink's live state. The first caller's poll interval owns the
 *  safety-net cadence — the reactive is the process's single sink reader, the
 *  same way the other domains' pollers are. */
export function volumeState(pollIntervalMs: number): Reactive<VolumeState> {
  if (!_state) {
    const state = mkReactive<VolumeState>(NO_SINK)
    _state = state
    let last = ""
    _tick = (): void => {
      const next = readSink()
      const key = stateKey(next)
      if (key === last) return
      last = key
      state.set(next)
    }
    _tick()
    const ms =
      Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
        ? Math.max(200, pollIntervalMs)
        : DEFAULT_POLL_MS
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      _tick?.()
      return GLib.SOURCE_CONTINUE
    })
  }
  return _state
}

/** Set the default sink's level (0..100) and release a mute: a level the user
 *  asked for is one they want to hear. A process with no sink is a no-op, and so
 *  is an argument that is not a level — a request token that failed to decode
 *  must never move the sink. */
export function setVolume(pct: number): void {
  if (!Number.isFinite(pct)) return
  const speaker = currentSink()
  if (!speaker) return
  const level = Math.max(0, Math.min(100, pct))
  try {
    speaker.set_volume(level / 100)
    if (level > 0 && speaker.get_mute()) speaker.set_mute(false)
  } catch (e) {
    print(`[volume] set_volume FAILED: ${e}`)
  }
}

/** Mute or unmute the default sink. A process with no sink — and a non-boolean
 *  argument — is a no-op. */
export function setMuted(muted: boolean): void {
  if (typeof muted !== "boolean") return
  const speaker = currentSink()
  if (!speaker) return
  try {
    speaker.set_mute(muted)
  } catch (e) {
    print(`[volume] set_mute FAILED: ${e}`)
  }
}
