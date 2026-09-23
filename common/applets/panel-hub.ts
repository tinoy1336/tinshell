type CloseFn = () => void
let currentClose: CloseFn | null = null

export function registerOpen(close: CloseFn) {
  if (currentClose && currentClose !== close) currentClose()
  currentClose = close
  notifyOpenChange()
}

export function unregisterOpen(close: CloseFn) {
  if (currentClose === close) currentClose = null
  notifyOpenChange()
}

/** Close whatever panel is currently open (the panel scrim corner-cancel
 *  and the panel Escape path call this). Respects the keepOpen pin — a
 *  menu-pinned panel survives. */
export function closeOpenPanel(): void {
  currentClose?.()
}

// ── Leave-simulation registry ──
// The tablet-mode watchdog maps tabletCloseMs expiry to "the cursor left the
// window" (the tablet close timeout must have the exact same effect as moving
// the cursor away in laptop mode). It cannot synthesize a real GTK leave, so
// each applet core registers its leave-grace evaluation (evaluateLeave in
// create-applet-core.ts) and the watchdog broadcasts it via simulateLeaveAll.
// The per-core evaluation reuses the REAL leave machinery (maybeScheduleClose's
// guards: real pointer inside, drag held, keepOpen pin) so every surface
// settles exactly as a cursor-leave would. Registered at core setup,
// unregistered in onCleanup — rebuild-safe (each dock generation is a gnim
// scope, disposed on rebuild).

type LeaveEval = () => void
const leaveEvals = new Set<LeaveEval>()

export function registerLeaveEval(fn: LeaveEval): void {
  leaveEvals.add(fn)
}

export function unregisterLeaveEval(fn: LeaveEval): void {
  leaveEvals.delete(fn)
}

/** Run every registered leave-evaluation — the tablet watchdog calls this on
 *  tabletCloseMs expiry. */
export function simulateLeaveAll(): void {
  for (const fn of [...leaveEvals]) fn()
}

// ── Panel open/close notifications ──
// Lets long-lived watchers (the tablet-mode watchdog) pause their polling
// while no panel is open. Called after every registerOpen/unregisterOpen.

type OpenChangeFn = (open: boolean) => void
const openChangeCbs: OpenChangeFn[] = []

export function onPanelOpenChange(cb: OpenChangeFn): () => void {
  openChangeCbs.push(cb)
  return () => {
    const i = openChangeCbs.indexOf(cb)
    if (i >= 0) openChangeCbs.splice(i, 1)
  }
}

function notifyOpenChange(): void {
  const open = currentClose !== null
  for (const cb of openChangeCbs) cb(open)
}
