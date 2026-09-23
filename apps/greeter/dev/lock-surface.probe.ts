/**
 * lock-surface.probe — dev probe for the lock screen's failure path.
 *
 * Drives `buildLockSurface` (lock/surface.ts) with STUB windows, a stub
 * card and factories that throw, proving:
 *   (a) no exception escapes into the caller (the `::monitor` lockout path is
 *       closed), and
 *   (b) a window is STILL assigned for the monitor — composed without the
 *       strip when the applet strip failed (the backdrop survives), the
 *       minimal fallback surface when the card failed.
 *
 * It never acquires a session lock, never calls logind/hypridle, never touches
 * /run, never constructs a Gtk widget or a real window, and is NOT imported by
 * the greeter app (only app.ts's import graph is bundled).
 *
 * Run:  ags run --gtk 4 apps/greeter/dev/lock-surface.probe.ts
 */
import type { Gtk } from "ags/gtk4"
import { buildLockSurface, LOCK_FALLBACK_CLASS } from "../lock/surface"
import type { LoginCardHandle } from "../login/card"

interface StubState {
  css: string[]
  child: unknown
  controllers: number
}

function stubWindow(): { state: StubState; win: Gtk.Window } {
  const state: StubState = { css: [], child: null, controllers: 0 }
  const win = {
    add_css_class: (c: string) => {
      state.css.push(c)
    },
    set_child: (w: unknown) => {
      state.child = w
    },
    add_controller: () => {
      state.controllers++
    },
  } as unknown as Gtk.Window
  return { state, win }
}

const CSS = "greeter-lock"
const MARKER = "stub-child"

const checks: [string, boolean][] = []
const check = (name: string, ok: boolean): void => {
  checks.push([name, ok])
}

// ── 1. the applet strip factory throws ──────────────────────────────────────
{
  const { state, win } = stubWindow()
  const cardChild = { marker: MARKER, part: "card" }
  const composed = { marker: MARKER, part: "composed" } as unknown as Gtk.Widget
  let composedWith: { card: unknown; strip: unknown } | null = null
  let assigned: Gtk.Window | null = null
  let assignedMonitor: unknown = null
  let escapes = 0
  const result = buildLockSurface(
    {
      card: () => ({
        widget: cardChild as unknown as Gtk.Widget,
        handle: {} as LoginCardHandle,
      }),
      strip: () => {
        throw new Error("dock factory exploded")
      },
      compose: (c, s) => {
        composedWith = { card: c, strip: s }
        return composed
      },
      escape: () => {
        escapes++
      },
      makeWindow: () => win,
      fallback: () => ({ marker: MARKER, part: "minimal" }) as unknown as Gtk.Widget,
    },
    (w, mon) => {
      assigned = w
      assignedMonitor = mon
    },
    { output: "stub-monitor" },
  )
  check("strip throw: window assigned", assigned === win)
  check("strip throw: monitor forwarded", (assignedMonitor as any)?.output === "stub-monitor")
  // Read through an assertion: TS's call-flow narrowing cannot see the factory's
  // assignment, so a direct read collapses `composedWith` to null.
  const seen = composedWith as { card: unknown; strip: unknown } | null
  check("strip throw: composed from the card", seen?.card === cardChild)
  check("strip throw: composed WITHOUT the strip", seen?.strip === null)
  check("strip throw: composition reaches the window", state.child === composed)
  check("strip throw: result ok", result.ok === true)
  check("strip throw: escape attached once", escapes === 1 && state.controllers === 0)
  check("strip throw: no fallback class", !state.css.includes(LOCK_FALLBACK_CLASS))
  check("strip throw: greeter-lock class kept", state.css.includes(CSS))
}

// ── 2. the CARD factory throws (the minimal surface path) ───────────────────
{
  const { state, win } = stubWindow()
  const minimalChild = { marker: MARKER, part: "minimal" }
  let assigned: Gtk.Window | null = null
  const result = buildLockSurface(
    {
      card: () => {
        throw new Error("card factory exploded")
      },
      strip: () => ({ marker: MARKER, part: "strip" }) as unknown as Gtk.Widget,
      compose: (c) => c,
      escape: () => {},
      makeWindow: () => win,
      fallback: () => minimalChild as unknown as Gtk.Widget,
    },
    (w) => {
      assigned = w
    },
    "stub",
  )
  check("card throw: window still assigned", assigned === win)
  check("card throw: fallback content on the window", state.child === minimalChild)
  check("card throw: fallback class present", state.css.includes(LOCK_FALLBACK_CLASS))
  check("card throw: result reports failure", result.ok === false && !!result.error)
}

// ── 3. the COMPOSITION throws (window built, child never set) ───────────────
{
  const { state, win } = stubWindow()
  const minimalChild = { marker: MARKER, part: "minimal" }
  let assigned: Gtk.Window | null = null
  const result = buildLockSurface(
    {
      card: () => ({ widget: {} as Gtk.Widget, handle: {} as LoginCardHandle }),
      strip: () => ({}) as Gtk.Widget,
      compose: () => {
        throw new Error("compose exploded")
      },
      escape: () => {},
      makeWindow: () => win,
      fallback: () => minimalChild as unknown as Gtk.Widget,
    },
    (w) => {
      assigned = w
    },
    "stub",
  )
  check("compose throw: window still assigned", assigned === win)
  check("compose throw: fallback content", state.child === minimalChild)
  check("compose throw: result reports failure", result.ok === false && !!result.error)
}

// ── 4. even `assign` throwing must not escape ────────────────────────────────
{
  const { win } = stubWindow()
  let escaped: unknown = null
  let result: ReturnType<typeof buildLockSurface> | null = null
  try {
    result = buildLockSurface(
      {
        card: () => ({ widget: {} as Gtk.Widget, handle: {} as LoginCardHandle }),
        strip: () => ({}) as Gtk.Widget,
        compose: (c) => c,
        escape: () => {},
        makeWindow: () => win,
        fallback: () => ({}) as Gtk.Widget,
      },
      () => {
        throw new Error("assign exploded")
      },
      "stub",
    )
  } catch (e) {
    escaped = e
  }
  check("assign throw: nothing escaped", escaped === null)
  check("assign throw: result reports the failure", result !== null && result.ok === false)
}

// ── report ──────────────────────────────────────────────────────────────────
const failed = checks.filter(([, ok]) => !ok)
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`)
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`lock-surface probe failed: ${failed.length} check(s)`)
