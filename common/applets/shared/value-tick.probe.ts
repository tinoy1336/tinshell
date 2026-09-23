/**
 * value-tick.probe — the animated numeric readout
 * (common/applets/shared/value-tick.ts).
 *
 * No applet, no display, no real widget: the tick takes its frame clock from
 * the widget it is handed and its config from the caller, so the probe drives
 * it with a stub widget (a tick callback it pumps by hand), a two-key config
 * and a stub poll. It asserts the walk itself, the kick policy (deadband,
 * visibility, an absent reading, the adopted first reading) and the
 * `timing.tickAnim` 0 snap.
 *
 * Run:
 *   ags bundle --gtk 4 common/applets/shared/value-tick.probe.ts /tmp/value-tick-probe.sh
 *   bash /tmp/value-tick-probe.sh        # exit 1 on any violated invariant
 */
import type Gtk from "gi://Gtk?version=4.0"
import type { AppletConfig } from "@common/applets/config"
import { createValueTick } from "./value-tick"

const results: string[] = []
let failed = false

function check(label: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failed = true
}

/** A widget whose frame clock the probe pumps by hand: `add_tick_callback`
 *  captures the callback (a non-zero id = a real tick source), `frame()` runs
 *  one frame and reports whether the tick source is still alive. */
function stubWidget() {
  let cb: ((widget: unknown, clock: unknown) => boolean) | null = null
  let draws = 0

  const frame = (): boolean => {
    const fn = cb
    if (!fn) return false
    const cont = fn(null, { get_frame_time: () => 0 })
    if (!cont) cb = null
    return cont
  }

  return {
    widget: {
      add_tick_callback: (fn: (widget: unknown, clock: unknown) => boolean): number => {
        cb = fn
        return 1
      },
      remove_tick_callback: (): void => {
        cb = null
      },
      queue_draw: (): void => {
        draws += 1
      },
    } as unknown as Gtk.Widget,
    running: (): boolean => cb !== null,
    draws: (): number => draws,
    frame,
    /** Run frames until the walk settles (or `max` frames), returning the
     *  values peeked at each frame in order. */
    pump: (peek: () => number, max = 500): number[] => {
      const seen: number[] = []
      let n = 0
      while (n < max) {
        seen.push(peek())
        if (!frame()) break
        n += 1
      }
      return seen
    },
  }
}

function stubConfig(tickAnim: number, framerate = 60): AppletConfig {
  return { timing: { tickAnim, framerate } } as unknown as AppletConfig
}

/** A stub poll: `peek()` reads the value, `set()` notifies every subscriber. */
function stubSource<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      peek: (): T => value,
      subscribe: (cb: () => void): (() => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
    set: (v: T): void => {
      value = v
      for (const cb of listeners) cb()
    },
    subscribers: (): number => listeners.size,
  }
}

// ── 1. The walk ──
{
  const { widget, ...w } = stubWidget()
  const poll = stubSource<number | null>(50)
  const tick = createValueTick({
    source: poll.source,
    read: (v) => v,
    widget,
    config: stubConfig(3000),
    deadband: 1,
  })
  check("a poll that already holds a reading paints it", tick.peek() === 50 && !w.running())

  // The reading that starts the first walk is adopted: the tick holds no
  // earlier reading to walk from.
  poll.set(60)
  check(
    "the first change is adopted, not walked",
    tick.peek() === 60 && !w.running(),
    `peek ${tick.peek()}`,
  )

  poll.set(70)
  const walk = w.pump(() => tick.peek())
  const digits = new Set(walk.map((v) => Math.round(v)))
  check(
    "a change then starts a walk that ends at the reading",
    walk.length > 20 && tick.peek() === 70 && !w.running(),
    `${walk.length} frames, ${w.draws()} icon repaints, ended at ${tick.peek()}`,
  )
  check(
    "the walked frames carry intermediate values",
    walk[0] === 60 && [...digits].filter((d) => d > 60 && d < 70).length >= 5,
    `digits seen: ${[...digits].sort((a, b) => a - b).join(",")}`,
  )
  check(
    "the walk is monotone and never overshoots",
    walk.every((v, i) => (i === 0 || v >= walk[i - 1]) && v <= 70),
  )

  // A change inside the deadband starts no walk (and no repaint of its own).
  const drawsBefore = w.draws()
  poll.set(70.5)
  check(
    "a change inside the deadband starts no walk",
    !w.running() && w.draws() === drawsBefore,
    `peek ${tick.peek()}`,
  )
}

// ── 2. Visibility gates the walk ──
{
  const { widget, ...w } = stubWidget()
  const poll = stubSource<number | null>(20)
  let visible = false
  const tick = createValueTick({
    source: poll.source,
    read: (v) => v,
    widget,
    config: stubConfig(3000),
    deadband: 1,
    isVisible: () => visible,
  })
  poll.set(40)
  check("a hidden applet starts no walk", !w.running(), `peek ${tick.peek()}`)

  visible = true
  poll.set(45)
  check("the first visible change is adopted", tick.peek() === 45 && !w.running())
  poll.set(80)
  check("a later visible change starts a walk", w.running())

  // A walk in flight stops when the applet goes hidden, and a later visible
  // change restarts it — the frame loop is never left burning.
  w.frame()
  const midway = tick.peek()
  visible = false
  w.frame()
  check("a walk stops when the applet goes hidden", !w.running(), `peek ${midway}`)
  visible = true
  poll.set(90)
  check("a later visible change restarts the walk", w.running())
  w.pump(() => tick.peek())
  check("the restarted walk ends at the reading", tick.peek() === 90 && !w.running())
}

// ── 3. An absent reading is not a value ──
{
  const { widget, ...w } = stubWidget()
  const poll = stubSource<number | null>(30)
  const tick = createValueTick({
    source: poll.source,
    read: (v) => v,
    widget,
    config: stubConfig(3000),
    deadband: 1,
  })
  poll.set(45)
  w.pump(() => tick.peek())
  poll.set(null)
  check(
    "an absent reading neither animates nor moves the target",
    !w.running() && tick.peek() === 45,
    `peek ${tick.peek()}`,
  )
}

// ── 4. The first reading of a poll that starts empty is adopted ──
{
  const { widget, ...w } = stubWidget()
  const poll = stubSource<number | null>(null)
  const tick = createValueTick({
    source: poll.source,
    read: (v) => v,
    widget,
    config: stubConfig(3000),
    deadband: 1,
  })
  poll.set(52)
  check(
    "the first reading of an empty poll is adopted, not walked from nothing",
    tick.peek() === 52 && !w.running(),
    `peek ${tick.peek()}`,
  )
}

// ── 5. tickAnim 0 = the readout does not animate ──
{
  const { widget, ...w } = stubWidget()
  const poll = stubSource<number | null>(10)
  const tick = createValueTick({
    source: poll.source,
    read: (v) => v,
    widget,
    config: stubConfig(0),
    deadband: 1,
  })
  poll.set(90)
  check(
    "tickAnim 0 paints the new reading at once",
    tick.peek() === 90 && !w.running(),
    `peek ${tick.peek()}`,
  )
}

// ── 6. dispose releases the poll subscription ──
{
  const { widget } = stubWidget()
  const poll = stubSource<number | null>(10)
  const tick = createValueTick({
    source: poll.source,
    read: (v) => v,
    widget,
    config: stubConfig(3000),
    deadband: 1,
  })
  tick.dispose()
  check("dispose releases the poll subscription", poll.subscribers() === 0, `${poll.subscribers()}`)
}

console.log(results.join("\n"))
console.log(
  `value-tick.probe: ${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`,
)
if (failed) {
  console.log("[probe] RESULT: FAIL")
  imports.system.exit(1)
}
console.log("[probe] RESULT: PASS")
imports.system.exit(0)
