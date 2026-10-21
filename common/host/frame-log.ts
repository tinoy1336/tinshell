/**
 * common/host/frame-log — measure this instance's frame cadence on demand.
 *
 * The complaint this answers is perceptual ("it feels like 30 fps with
 * stutters"), and no counter in the process answered it: the memory sampler
 * measures request latency, the allocator counters measure bytes, and neither
 * says how often the compositor got a finished frame. GTK already knows — a
 * GdkFrameClock delivers `after-paint` once per presented frame and reports the
 * compositor's own frame time — so this module drives that clock for a few
 * seconds and reports the interval distribution.
 *
 * DRIVING is deliberate. A Gtk4 surface receives frame callbacks only while it
 * is being drawn, so an idle instance would report one frame and then nothing.
 * The handler asks the measured window for another frame (`queue_draw`) after
 * each one, which measures the rate the instance can SUSTAIN: if the interval
 * distribution sits near the display period the instance keeps up, and every
 * interval well past it is a frame the compositor had to wait for.
 *
 * It measures ONE window — the one named by the request, or the first mapped
 * toplevel. That is the right unit for "is this surface slow": the surfaces
 * share the process's main loop, so a stall shows up wherever it is measured,
 * while a per-window cost (a large blurred layer surface) shows up only here.
 *
 * Results are appended, one row per run, to
 * `~/.local/state/tinshell/frame-runs.tsv` — beside the memory sampler's own
 * series, so a before/after comparison of a code or compositor change is a
 * diff of that file rather than a memory of how it felt.
 */
import GLib from "gi://GLib"
import { register } from "@common/commands/registry"
import { writeFileSync } from "@common/fs/files"
import { Gtk } from "ags/gtk4"

/** Long enough to cover several seconds of interaction, short enough that the
 *  forced repaints are not themselves the experiment. */
const DEFAULT_SECONDS = 5
const MAX_SECONDS = 60

/** A frame that never arrives: the surface stopped being drawn (hidden, or the
 *  compositor stopped sending callbacks), so the run ends and says so instead of
 *  hanging until the timer. */
const STALL_US = 1_500_000

/** Display periods the buckets name: a 60 Hz and a 30 Hz deadline. */
const PERIOD_60HZ_US = 16_700
const PERIOD_30HZ_US = 33_400

/** Where each run's summary lands, one TSV row per measurement. */
function resultsPath(): string {
  return GLib.build_filenamev([GLib.get_user_state_dir(), "tinshell", "frame-runs.tsv"])
}

const RESULTS_HEADER =
  "ts_iso\twindow\tseconds\tframes\tfps\tmean_ms\tp50_ms\tp95_ms\tworst_ms\tmissed_60hz\tmissed_30hz"

interface Target {
  win: any
  clock: any
  label: string
}

/** The name a toplevel is recognisable by: its layer-shell namespace, else its
 *  app id, else its title. */
function windowLabel(win: any): string {
  return win?.namespace ?? win?.application?.application_id ?? win?.title ?? "unnamed"
}

/** The first mapped toplevel whose label starts with `prefix` (an empty prefix
 *  matches anything), or null. A window that is not mapped has no frame clock. */
function pickWindow(prefix: string): Target | null {
  const tops = (Gtk.Window as unknown as { get_toplevels(): any }).get_toplevels()
  const count = tops.get_n_items()
  for (let i = 0; i < count; i++) {
    const win = tops.get_item(i)
    const label = String(windowLabel(win))
    if (prefix && !label.startsWith(prefix)) continue
    if (typeof win?.get_mapped === "function" && !win.get_mapped()) continue
    const clock = typeof win?.get_frame_clock === "function" ? win.get_frame_clock() : null
    if (!clock) continue
    return { win, clock, label }
  }
  return null
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  return sorted[index]
}

const toMs = (us: number): string => (us / 1000).toFixed(1)

/**
 * One measurement: returns a promise that settles with the report text. The
 * clock is disconnected and the timer removed on every path, so a caller that
 * ignores the result cannot leak a repaint loop into the instance.
 */
function measure(target: Target, seconds: number): Promise<string> {
  return new Promise((resolve) => {
    const intervals: number[] = []
    let lastFrameTime = 0
    let finished = false
    const startedAt = GLib.get_monotonic_time()

    const finish = (note?: string): void => {
      if (finished) return
      finished = true
      try {
        target.clock.disconnect(handlerId)
      } catch {
        /* the clock is gone with its surface; nothing to disconnect */
      }
      GLib.source_remove(timerId)

      const elapsedUs = GLib.get_monotonic_time() - startedAt
      if (intervals.length === 0) {
        resolve(
          `window: ${target.label}\nframes: none in ${(elapsedUs / 1e6).toFixed(1)}s — ${note ?? "the clock delivered no frame (surface not being drawn)"}`,
        )
        return
      }
      const sorted = [...intervals].sort((a, b) => a - b)
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length
      const fps = intervals.length / (elapsedUs / 1e6)
      const missed60 = intervals.filter((v) => v > PERIOD_60HZ_US * 1.5).length
      const missed30 = intervals.filter((v) => v > PERIOD_30HZ_US * 1.5).length
      const gdkFps = typeof target.clock.get_fps === "function" ? target.clock.get_fps() : 0

      const summary = [
        `window: ${target.label}`,
        `frames: ${intervals.length} over ${(elapsedUs / 1e6).toFixed(1)}s  →  ${fps.toFixed(1)} fps sustained`,
        `intervals (ms): mean ${toMs(mean)}  p50 ${toMs(percentile(sorted, 0.5))}  p95 ${toMs(percentile(sorted, 0.95))}  worst ${toMs(sorted[sorted.length - 1])}  best ${toMs(sorted[0])}`,
        `missed deadlines: ${missed60} past 1.5x60Hz, ${missed30} past 1.5x30Hz`,
        `gdk's own estimate: ${gdkFps.toFixed(1)} fps${note ? `  (${note})` : ""}`,
        `logged to ${resultsPath()}`,
      ].join("\n")

      const row = [
        GLib.DateTime.new_now_local().format("%FT%T%z"),
        target.label,
        String(seconds),
        String(intervals.length),
        fps.toFixed(1),
        toMs(mean),
        toMs(percentile(sorted, 0.5)),
        toMs(percentile(sorted, 0.95)),
        toMs(sorted[sorted.length - 1]),
        String(missed60),
        String(missed30),
      ].join("\t")

      const path = resultsPath()
      let previous = ""
      try {
        const [ok, bytes] = GLib.file_get_contents(path)
        if (ok && bytes) previous = new TextDecoder().decode(bytes as Uint8Array)
      } catch {
        /* no file yet: this run creates it */
      }
      const body = previous.trim()
        ? `${previous.trimEnd()}\n${row}\n`
        : `${RESULTS_HEADER}\n${row}\n`
      if (!writeFileSync(path, body)) {
        resolve(`${summary}\nnote: could not write ${path}`)
        return
      }
      resolve(summary)
    }

    const handlerId = target.clock.connect("after-paint", () => {
      const now = target.clock.get_frame_time()
      if (lastFrameTime !== 0) {
        const delta = now - lastFrameTime
        if (delta > 0) intervals.push(delta)
        if (delta > STALL_US) finish(`stopped early: a frame took ${toMs(delta)} ms`)
      }
      lastFrameTime = now
      // Ask for the next frame: without damage the clock stops delivering.
      try {
        target.win.queue_draw()
      } catch {
        /* an unrealized window cannot be asked; the stall guard ends the run */
      }
    })

    const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, seconds * 1000, () => {
      finish()
      return GLib.SOURCE_REMOVE
    })
  })
}

/**
 * Register `<instance> debug frames [seconds] [window-label-prefix]`, beside
 * `<instance> debug build` — the same instance-keyed shape, so it adds no
 * namespace of its own. `seconds` defaults to 5 and is capped at 60; the prefix
 * selects a surface by the label its window carries (`dock-pill`, `launcher`,
 * `notifications-centre`, …).
 */
export function registerFrameLogRequest(instance: string): void {
  register([instance, "debug", "frames"], (args, res) => {
    const rawSeconds = Number(args[0] ?? DEFAULT_SECONDS)
    if (!Number.isFinite(rawSeconds) || rawSeconds <= 0) {
      res("error: usage: debug frames [seconds] [window-label-prefix]")
      return
    }
    const seconds = Math.min(Math.floor(rawSeconds), MAX_SECONDS)
    const prefix = args[1] ?? ""
    const target = pickWindow(prefix)
    if (!target) {
      res(
        prefix
          ? `error: no mapped window whose label starts with "${prefix}"`
          : "error: no mapped window to measure",
      )
      return
    }
    measure(target, seconds).then(
      (report) => res(report),
      (e: Error) => res(`error: frame measurement failed: ${e.message}`),
    )
  })
}
