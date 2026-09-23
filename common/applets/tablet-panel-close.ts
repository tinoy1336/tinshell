/**
 * common/applets/tablet-panel-close — tablet-mode auto-close of an open applet
 * panel.
 *
 * OWNER: the HOST process. Both inputs of the policy are host state — whether
 * a panel is open (panel-hub's open/close notifications) and what "the cursor
 * left" means for each applet core (panel-hub's leave-eval registry, filled by
 * common/applets/shared/create-applet-core). The tablet state itself is
 * machine-wide and comes from the applets backend's tablet domain
 * (common/applets/domains/tablet.ts owns the switch helper and the latch); it reaches
 * the host through the applet backend contract (`tablet.onTabletChange`), which
 * seeds the current value and then reports edges. The dock hosts the backend,
 * so it reads that state directly; a host that does not (the greeter) reads it
 * over its transport.
 *
 * Behaviour: while tablet mode is on AND a panel is open, a timing.tabletCloseMs
 * timer arms; on expiry it SIMULATES a cursor-leave on every applet window
 * (simulateLeaveAll — each core re-runs its leave-grace evaluation), so the
 * timeout has the exact same effect across the board as moving the cursor away
 * and off the applet in laptop mode: the open panel closes via the normal
 * 220ms leave-grace with the same guards (real pointer still inside → stays
 * open, drag held → stays open, keepOpen pin → stays open), the overflow
 * reveal session collapses via overflowIdle after the keepers release, and the
 * clock recovers via its own reappear timer. Leaving tablet mode, or closing
 * the panel by any other path, cancels the timer.
 *
 * The timer RE-ARMS itself on expiry when a guard kept the panel open (drag
 * held, keepOpen pin): the tablet domain reports edges, not ticks, so the
 * repeat has to live here or a surviving panel stays open forever.
 */
import GLib from "gi://GLib"
import type { AppletBackend } from "./backend"
import { onPanelOpenChange, simulateLeaveAll } from "./panel-hub"

interface TabletPanelCloseOptions {
  /** The host's tablet domain (the applet backend contract). */
  tablet: AppletBackend["tablet"]
  /** Auto-close span in ms (config.timing.tabletCloseMs); <= 0 disables it. */
  closeMs: number
}

let started = false
let closeMs = 0
let panelOpen = false
let tabletOn = false
let timerId: number | null = null
let fired = 0

function clearTimer(): void {
  if (timerId !== null) {
    GLib.source_remove(timerId)
    timerId = null
  }
}

/** Arm the close timer if tablet mode is on and it isn't armed already. */
function armTimer(): void {
  if (timerId !== null) return
  if (closeMs <= 0) return
  timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, closeMs, () => {
    timerId = null
    fired++
    print("[tablet-panel-close] timer expired — simulating cursor-leave on all applets")
    // The timeout's effect must match "the cursor left the window" exactly:
    // each applet re-runs its leave-grace evaluation (guards: real pointer
    // inside, drag held, keepOpen pin). The row cascade (reveal-session
    // collapse, clock reappear) follows from the panel close paths.
    simulateLeaveAll()
    // RE-ARM while the panel survived (a guard kept it open): see the header.
    if (panelOpen && tabletOn) armTimer()
    return GLib.SOURCE_REMOVE
  })
}

/** Re-evaluate the timer after any policy input changed: it only matters while
 *  a panel is open AND tablet mode is on. */
function evaluate(): void {
  if (!panelOpen || !tabletOn) {
    clearTimer()
    return
  }
  armTimer()
}

/** Wire the tablet-panel-close policy for one host (idempotent). */
export function startTabletPanelClose(opts: TabletPanelCloseOptions): void {
  if (started) return
  started = true
  closeMs = opts.closeMs
  onPanelOpenChange((open) => {
    panelOpen = open
    evaluate()
  })
  opts.tablet.onTabletChange((tablet) => {
    tabletOn = tablet
    evaluate()
  })
}

/** Introspection for the host's tablet debug request — the probe for whether
 *  the policy is live in THIS process (`dock tablet get`). */
export function tabletPanelCloseInfo(): string {
  return (
    `panelOpen=${panelOpen ? 1 : 0} tablet=${tabletOn ? 1 : 0}` +
    ` panelCloseTimer=${timerId !== null ? "armed" : "idle"}` +
    ` tabletCloseMs=${closeMs} panelCloseFired=${fired}`
  )
}
