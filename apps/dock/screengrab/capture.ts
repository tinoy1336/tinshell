/**
 * dock/screengrab/capture.ts — capture backend for the screen grab applet.
 *
 * Tools (verified on this machine): grim (stills, -g region, -t format,
 * -q jpeg quality, -c cursor), slurp (region selection, prints "x,y WxH"),
 * wf-recorder (video, -g region, -r framerate, -c codec, -p codec params,
 * SIGINT for the graceful stop), hyprctl (focused monitor / active window
 * geometry). All subprocess I/O is async (never block the main loop).
 *
 * Geometry: grim/wf-recorder take LAYOUT coordinates. hyprctl reports
 * PHYSICAL monitor pixels, so the focused-monitor geometry is divided by the
 * monitor scale. activewindow at/size are already logical.
 *
 * Recording lifecycle: startRecording spawns wf-recorder (pid tracked) and
 * publishes the recording state; stopRecording sends SIGINT — wf-recorder's
 * graceful stop, which finalizes the file. wf-recorder registers SIGTERM,
 * SIGINT and SIGHUP as graceful termination, so a unit teardown's cgroup
 * SIGTERM finalizes the file too.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { mkReactive } from "@common/applets/utils/reactive"
import { ensureDir, resolvePath } from "@common/fs/files"
import { ignore } from "@common/log/logger"
import { shq } from "@common/subprocess/quote"
import { runCb } from "@common/subprocess/run"
import { config } from "../config"

export type CaptureMode = "fullscreen" | "window" | "select"

/** Expand a leading ~ (bare or ~/) in a path — alias over the shared helper
 *  (other dock files import expandPath from here). */
export function expandPath(p: string): string {
  return resolvePath(p)
}

// ── Recording state ──

export interface Recording {
  pid: number
  file: string
  startUs: number
}

let recording: Recording | null = null
let procHandle: Gio.Subprocess | null = null
const rec = mkReactive<Recording | null>(null)

export function isRecording(): boolean {
  return recording !== null
}

export function recordingStartUs(): number | null {
  return recording ? recording.startUs : null
}

export function subscribeRecording(cb: () => void): () => void {
  return rec.subscribe(cb)
}

// ── Dock visibility (the settings "Show dock" toggle) ──
// The toggle controls whether the dock appears IN captures. Off → the dock is
// hidden for the duration of a still/video capture (grim/wf-recorder capture
// whatever is composited — a visible dock would be in the frame; Wayland has
// no per-surface capture exclusion) and is perfectly visible at all other
// times. On → the dock stays visible even during captures. The effective
// value (showDock || !capturing) is published here; the screengrab applet
// subscribes and applies it to its row (row.setDockVisible).

let captureActive = false // a still or video capture is in flight

const dockVis = mkReactive(true)

/** The dock's effective visibility right now: hidden ONLY while a capture is
 *  in flight AND the "Show dock" toggle is off; visible at all other times. */
export function dockVisibleEffective(): boolean {
  return config.screengrab.showDock || !captureActive
}

function syncDockVis(): void {
  dockVis.set(dockVisibleEffective())
}

/** Called by the settings menu after it writes the live config. */
export function syncShowDock(): void {
  syncDockVis()
}

export function subscribeShowDock(cb: () => void): () => void {
  return dockVis.subscribe(cb)
}

// ── Geometry resolution ──

/** The focused monitor's region in LAYOUT coordinates (hyprctl reports
 *  physical pixels — divide by scale). */
function focusedMonitorGeo(): Promise<string | null> {
  return new Promise((resolve) => {
    runCb("hyprctl -j monitors", (stdout) => {
      try {
        const monitors = JSON.parse(stdout)
        const mon = monitors.find((m: any) => m.focused) ?? monitors[0]
        if (!mon) {
          ignore("monitor geometry: hyprctl reported no monitor")
          resolve(null)
          return
        }
        const s = mon.scale || 1
        resolve(
          `${Math.round(mon.x / s)},${Math.round(mon.y / s)} ${Math.round(mon.width / s)}x${Math.round(mon.height / s)}`,
        )
      } catch (e) {
        ignore("monitor geometry parse", e)
        resolve(null)
      }
    })
  })
}

/** The focused window's region (hyprctl activewindow at/size — already
 *  logical). Layer-shell surfaces (the dock) are not windows, so this never
 *  returns the dock itself. */
function focusedWindowGeo(): Promise<string | null> {
  return new Promise((resolve) => {
    runCb("hyprctl -j activewindow", (stdout, exitStatus) => {
      if (exitStatus !== 0) {
        resolve(null)
        return
      }
      try {
        const w = JSON.parse(stdout)
        if (!w || !w.mapped || !Array.isArray(w.at) || !Array.isArray(w.size)) {
          ignore("active window geometry missing")
          resolve(null)
          return
        }
        resolve(
          `${Math.round(w.at[0])},${Math.round(w.at[1])} ${Math.round(w.size[0])}x${Math.round(w.size[1])}`,
        )
      } catch (e) {
        ignore("active window parse", e)
        resolve(null)
      }
    })
  })
}

/** slurp prints "x,y WxH" (or exits non-zero when cancelled). */
function slurpGeo(): Promise<string | null> {
  return new Promise((resolve) => {
    runCb("slurp", (stdout, exitStatus) => {
      if (exitStatus !== 0) {
        resolve(null)
        return
      }
      const geo = stdout.trim()
      resolve(geo || null)
    })
  })
}

// ── Region freeze (hyprpicker) ──
// hyprpicker paints a still copy of every output on the overlay layer, so the
// frame the user selects on is the frame grim captures. slurp alone only draws
// a transparent box over a LIVE screen: hover-reactive UI changes state while
// the region is dragged and grim grabs whatever the cursor ends over.
//
// Two ordering rules follow from that:
//   - the picker must still be mapped when grim runs (killing it first races
//     the overlay fade-out and blends the frozen frame with the live screen),
//     so the handle survives selectGeo and is ended by the capture that used it;
//   - slurp must not start before the picker's surface is MAPPED. Both claim
//     EXCLUSIVE keyboard interactivity and Hyprland pins pointer+keyboard focus
//     to whichever maps LAST, so an early slurp loses its first click to the
//     picker's late map.
interface Freeze {
  proc: Gio.Subprocess
  pid: number
  guard: number
}

let freeze: Freeze | null = null

/** A picker left alive (slurp hang, a capture path that never reaches
 *  takeStill) would hold the frozen overlay on screen with no way out. */
const FREEZE_GUARD_MS = 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve()
      return GLib.SOURCE_REMOVE
    })
  })
}

/** Every layer surface in a `hyprctl layers -j` payload carrying the picker
 *  namespace for `pid` (the payload nests monitors → levels → surfaces, so the
 *  walk is structural rather than positional). */
function pickerSurfaces(node: unknown, pid: number, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const child of node) pickerSurfaces(child, pid, out)
    return
  }
  if (!node || typeof node !== "object") return
  const surface = node as Record<string, unknown>
  if (surface.namespace === "hyprpicker" && Number(surface.pid) === pid) {
    out.push(surface)
    return
  }
  for (const key of Object.keys(surface)) pickerSurfaces(surface[key], pid, out)
}

/** Spawn the freeze overlay; null when hyprpicker is missing or unrunnable
 *  (the capture then falls back to a live-screen selection). */
function startFreeze(): Freeze | null {
  endFreeze()
  let proc: Gio.Subprocess
  try {
    proc = Gio.Subprocess.new(
      ["hyprpicker", "-r", "-z", "-d", "-q"],
      Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
    )
  } catch (e) {
    ignore("hyprpicker spawn failed", e)
    return null
  }
  const pid = Number(proc.get_identifier())
  if (!pid) {
    proc.force_exit()
    return null
  }
  const guard = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FREEZE_GUARD_MS, () => {
    endFreeze()
    return GLib.SOURCE_REMOVE
  })
  freeze = { proc, pid, guard }
  return freeze
}

/** Drop the overlay. hyprpicker ignores SIGTERM while it is inside its
 *  screencopy loop, so the terminate is escalated after a short grace. */
function endFreeze(): void {
  if (!freeze) return
  const { proc, guard } = freeze
  freeze = null
  if (guard) GLib.source_remove(guard)
  try {
    proc.send_signal(15)
  } catch (e) {
    ignore("hyprpicker terminate", e)
  }
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
    try {
      if (!proc.get_if_exited()) proc.force_exit()
    } catch (e) {
      ignore("hyprpicker force exit", e)
    }
    return GLib.SOURCE_REMOVE
  })
}

/** Wait until this picker's overlay is really on screen: hyprctl lists a layer
 *  surface the moment it is CREATED, and `alpha` (the animation goal) reaches 1
 *  only when the surface maps. */
async function waitForFreezeMapped(pid: number): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (!freeze || freeze.pid !== pid) return
    const out = await new Promise<string>((resolve) =>
      runCb("hyprctl layers -j", (stdout, status) => resolve(status === 0 ? stdout : "")),
    )
    if (out) {
      try {
        const surfaces: Record<string, unknown>[] = []
        pickerSurfaces(JSON.parse(out), pid, surfaces)
        if (surfaces.length > 0 && surfaces.every((s) => Number(s.alpha) >= 1)) return
      } catch (e) {
        ignore("hyprctl layers parse", e)
      }
    }
    await sleep(10)
  }
  ignore("hyprpicker overlay never reported mapped")
}

/** Region select on a frozen frame. A bare click (press+release, no drag) comes
 *  back as a 1x1 box — how a first click absorbed by a late-mapping overlay
 *  shows up. Re-arm the freeze and let the user drag again rather than export
 *  an invisible one-pixel PNG. */
async function selectGeo(): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = startFreeze()
    if (started) await waitForFreezeMapped(started.pid)
    const geo = await slurpGeo()
    if (!geo) {
      endFreeze()
      return null
    }
    const dims = geo.split(" ").pop() ?? ""
    const [w, h] = dims.split("x").map((n) => Number(n))
    if (w >= 2 && h >= 2) return geo
    endFreeze()
  }
  return null
}

export async function resolveGeometry(mode: CaptureMode): Promise<string | null> {
  switch (mode) {
    case "fullscreen":
      return focusedMonitorGeo()
    case "window":
      return focusedWindowGeo()
    case "select":
      return selectGeo()
  }
}

// ── Stills ──

/** grim capture. `geo` null = whole desktop. Calls onDone(ok) when finished.
 *  Marks the capture active first (hides the dock when the "Show dock" toggle
 *  is off) and gives the hide commit a couple of frames before grim grabs —
 *  the compositor must present the hidden dock before the capture, or the
 *  first frame still shows it. */
export function takeStill(geo: string | null, file: string, onDone?: (ok: boolean) => void): void {
  const sg = config.screengrab
  ensureDir(expandPath(sg.dir))
  const cmd = [
    "grim",
    geo ? `-g ${shq(geo)}` : "",
    "-t",
    sg.format === "jpg" ? "jpeg" : "png",
    sg.format === "jpg" ? `-q ${Math.round(sg.jpegQuality)}` : "",
    sg.cursor ? "-c" : "",
    shq(file),
  ]
    .filter(Boolean)
    .join(" ")
  captureActive = true
  syncDockVis()
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
    runCb(cmd, (_out, status) => {
      // The freeze overlay outlives geo resolution on purpose (grim must see the
      // frozen frame); the capture that used it is what ends it.
      endFreeze()
      captureActive = false
      syncDockVis()
      onDone?.(status === 0)
    })
    return GLib.SOURCE_REMOVE
  })
}

// ── Video ──

/** Pick the ffmpeg encoder name for the codec choice + hardware preference.
 *  VAAPI (h264_vaapi/vp9_vaapi/av1_vaapi) runs on the AMD iGPU's VCN block;
 *  the CPU fallbacks are libx264 / libvpx-vp9. AV1 software encoding
 *  (libsvtav1) is far too slow for live capture, so av1 degrades to H.264
 *  without the hardware path. */
function pickVideoCodec(hw: boolean, codec: string): string {
  if (hw) {
    if (codec === "vp9") return "vp9_vaapi"
    if (codec === "av1") return "av1_vaapi"
    return "h264_vaapi"
  }
  if (codec === "vp9") return "libvpx-vp9"
  return "libx264"
}

function buildRecorderArgs(
  geo: string | null,
  file: string,
  hw: boolean,
  codec: string,
  crf: number,
): string[] {
  return [
    "wf-recorder",
    geo ? "-g" : "",
    geo ?? "",
    "-r",
    String(Math.round(config.screengrab.framerate)),
    "-c",
    pickVideoCodec(hw, codec),
    ...(hw
      ? // VAAPI quality is QP-based (CQP rate control) — the same tier numbers
        // as the CPU crf values. The device pins the encode to the AMD iGPU.
        ["-d", config.screengrab.vaapiDevice, "-p", "rate_control=CQP", "-p", `qp=${crf}`]
      : ["-p", `crf=${crf}`]),
    config.screengrab.audio ? "-a" : "",
    "-f",
    file,
  ].filter(Boolean)
}

/** Spawn wf-recorder detached (pid tracked) and publish the recording state.
 *  Marks the capture active first (hides the dock when "Show dock" is off) and
 *  gives the hide a couple of frames before wf-recorder's first grab. */
export function startRecording(geo: string | null, file: string): void {
  if (recording) return
  const sg = config.screengrab
  ensureDir(expandPath(sg.dir))
  const crf = sg.videoQuality === "low" ? 28 : sg.videoQuality === "high" ? 18 : 23
  const wantHw = sg.hwEncode
  let retried = false

  const spawn = (useHw: boolean): void => {
    const args = buildRecorderArgs(geo, file, useHw, sg.codec, crf)
    let proc: Gio.Subprocess
    try {
      proc = Gio.Subprocess.new(
        args,
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
      )
    } catch (e) {
      print(`[screengrab] wf-recorder spawn failed: ${e}`)
      if (useHw && !retried) {
        retried = true
        spawn(false)
      }
      return
    }
    procHandle = proc
    const pid = proc.get_identifier()
    if (!pid) {
      proc.force_exit()
      procHandle = null
      if (useHw && !retried) {
        retried = true
        spawn(false)
      }
      return
    }
    recording = { pid: Number(pid), file, startUs: GLib.get_monotonic_time() }
    rec.set(recording)
    // Early-exit grace: a vaapi spawn that dies within this window (bad
    // device/driver hiccup) is retried once with the CPU encoder; a recording
    // that survives the grace is a real capture and keeps the hw path.
    let pastGrace = false
    if (useHw) {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
        pastGrace = true
        return GLib.SOURCE_REMOVE
      })
    } else {
      pastGrace = true
    }
    // Watch the process: if it exits on its own (crash, or a failed start), clear
    // the stale recording state — the blink/stop control must not dangle on a
    // dead pid — and restore the dock (a dead recorder must not leave it hidden).
    proc.wait_check_async(null, () => {
      const wasOurs = recording && recording.pid === Number(pid)
      const badExit = (proc.get_exit_status?.() ?? -1) !== 0
      if (wasOurs) {
        recording = null
        procHandle = null
        rec.set(null)
        captureActive = false
        syncDockVis()
      }
      if (useHw && !pastGrace && badExit && !retried) {
        retried = true
        spawn(false)
      }
    })
  }
  captureActive = true
  syncDockVis()
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
    spawn(wantHw)
    return GLib.SOURCE_REMOVE
  })
}

/** SIGINT = wf-recorder's graceful stop (finalizes the file). Sends the
 *  signal via the live subprocess handle when available (no kill-subprocess
 *  race against an imminent app exit). */
export function stopRecording(): void {
  if (!recording) return
  const pid = recording.pid
  recording = null
  rec.set(null)
  const proc = procHandle
  procHandle = null
  if (proc) {
    try {
      proc.send_signal(2) /* SIGINT — GLib.UnixSignal isn't in the TS types */
    } catch (e) {
      print(`[screengrab] SIGINT failed: ${e}`)
    }
  } else {
    runCb(`kill -INT ${pid}`, () => {})
  }
  // Recording done → the dock comes back (SIGINT stops wf-recorder's capture
  // before it finalizes, so the restore never lands in the video).
  captureActive = false
  syncDockVis()
}
