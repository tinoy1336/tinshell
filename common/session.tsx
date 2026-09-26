/**
 * common/session.tsx — the frosted full-screen announcement of a
 * session transition: "Locking..." / "Logging out...".
 *
 * WHY IT EXISTS: a session transition is carried out by another process (logind
 * → hypridle → the lock bundle, or logind ending the session), and that handover
 * leaves the desktop painted and interactive for a beat. The overlay covers that
 * beat; once the lock is up, the ext-session-lock surface renders above every
 * layer surface, so nothing of this window is visible any more.
 *
 * INPUT BLOCKING: one layer-shell OVERLAY surface per monitor, anchored on all
 * four edges, keymode EXCLUSIVE and with an input region that is never narrowed.
 * The compositor delivers every key to an exclusive-interactivity layer surface,
 * and a full-screen surface with a full input region swallows every pointer
 * event over its monitor — so no keystroke and no click reaches the window
 * behind while the overlay is up. The FROST is the compositor's: the
 * `session-overlay` namespace carries a Hyprland layer rule (blur); the app CSS
 * only tints the glass and sizes the label.
 *
 * ORDERING: the action is dispatched only after the surfaces have reached the
 * screen (see whenShown) — never on a fixed sleep.
 *
 * NEVER STRANDING THE USER: the action runs INSIDE the overlay's lifetime, so a
 * thrown error or a rejected command dismisses the overlay at once; a lock poll
 * on the compositor's own lock state dismisses it the moment the lock surface is
 * up; and LINGER_MS bounds the whole transition, so an action that never took
 * the session away cannot leave an input-blocking scrim over the desktop.
 */
import GLib from "gi://GLib"
import { hyprctlJson } from "@common/hyprland/dispatch"
import { ignore, log } from "@common/log/logger"
import { SESSION_OVERLAY_NAMESPACE } from "@common/session-identity"
import { Astal, Gdk, Gtk } from "ags/gtk4"

type SessionTransition = "lock" | "logout"

/** Astal.WindowAnchor has no `ALL` member — the explicit OR is the full-screen
 *  form (the dock scrim's, apps/notifications/Popups.tsx's). */
const FULL =
  Astal.WindowAnchor.TOP |
  Astal.WindowAnchor.BOTTOM |
  Astal.WindowAnchor.LEFT |
  Astal.WindowAnchor.RIGHT

/** A surface that maps but is never handed a frame must not hold the action
 *  back: the transition is the user's intent, the overlay only announces it. */
const SHOWN_WAIT_MS = 500

/** How long the overlay stays up when the transition it announces never takes
 *  the session away — the stranding guard (generous: a lock bundle cold start
 *  takes a beat or two). */
const LINGER_MS = 20_000

/** Lock-state poll period while a `lock` transition runs. */
const LOCK_POLL_MS = 400

const OVERLAY_CSS = `
window.${SESSION_OVERLAY_NAMESPACE} { background-color: rgba(0, 0, 0, 0.35); }
.${SESSION_OVERLAY_NAMESPACE}-label { font-size: 30px; font-weight: 300; color: rgba(255, 255, 255, 0.92); }
`

/** The sheet is on the display once per PROCESS — a process fact, not per-app
 *  state: every caller contributes identical rules, and a GTK provider lives
 *  until the display dies (removing one after the fact restyles every window on
 *  the display — common/app/lazy's cssProviders rule). */
let cssInstalled = false

function installCss(): void {
  if (cssInstalled) return
  const display = Gdk.Display.get_default()
  if (!display) return
  try {
    const provider = new Gtk.CssProvider()
    provider.load_from_string(OVERLAY_CSS)
    Gtk.StyleContext.add_provider_for_display(
      display,
      provider,
      Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    )
    cssInstalled = true
  } catch (e) {
    // No sheet = untinted glass with the label still painted — the frost comes
    // from the compositor's layer rule either way.
    log(`[session-overlay] css failed: ${String(e)}`)
  }
}

/** Every monitor the display reports, in order. */
function monitorList(): Gdk.Monitor[] {
  const monitors = Gdk.Display.get_default()?.get_monitors?.()
  if (!monitors) return []
  const count = monitors.get_n_items?.() ?? 0
  const out: Gdk.Monitor[] = []
  for (let i = 0; i < count; i++) {
    const mon = monitors.get_item(i) as Gdk.Monitor | null
    if (mon) out.push(mon)
  }
  return out
}

/** One overlay window per monitor. Created unmapped — the caller maps it once
 *  whenShown has connected to the map signal. */
function overlayWindow(mon: Gdk.Monitor, label: string): Astal.Window {
  return (
    <window
      namespace={SESSION_OVERLAY_NAMESPACE}
      class={SESSION_OVERLAY_NAMESPACE}
      gdkmonitor={mon}
      layer={Astal.Layer.OVERLAY}
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.EXCLUSIVE}
      anchor={FULL}
      visible={false}
    >
      <label
        class={`${SESSION_OVERLAY_NAMESPACE}-label`}
        label={label}
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.CENTER}
      />
    </window>
  ) as Astal.Window
}

/** Resolve once this surface has actually reached the screen: GTK's map signal,
 *  then one frame-clock tick. The compositor only asks a mapped surface for
 *  frames, so a tick is proof that a frame of this surface was submitted —
 *  unlike a fixed sleep, which only says how long the caller waited. Bounded by
 *  SHOWN_WAIT_MS so a surface that never maps cannot stall the transition. */
function whenShown(win: Astal.Window): Promise<void> {
  return new Promise((resolve) => {
    let tickId = 0
    let shownTimer = 0
    let settled = false

    const settle = (): void => {
      if (settled) return
      settled = true
      if (shownTimer) {
        try {
          GLib.source_remove(shownTimer)
        } catch (e) {
          ignore("session-overlay shown timer", e)
        }
        shownTimer = 0
      }
      if (tickId) {
        try {
          win.remove_tick_callback(tickId)
        } catch (e) {
          ignore("session-overlay tick remove", e)
        }
        tickId = 0
      }
      resolve()
    }

    // add_tick_callback returns 0 on an unrealized widget, and the map signal
    // fires only once — settle() covers both.
    const armTick = (): void => {
      if (settled) return
      tickId = win.add_tick_callback(() => {
        tickId = 0
        settle()
        return GLib.SOURCE_REMOVE
      })
    }

    shownTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOWN_WAIT_MS, () => {
      shownTimer = 0
      settle()
      return GLib.SOURCE_REMOVE
    })
    // A window that already mapped when the promise is built never re-emits
    // ::map, so a missed signal would otherwise cost the full SHOWN_WAIT_MS.
    if (win.get_mapped()) armTick()
    else win.connect("map", armTick)
  })
}

/**
 * Announce a session transition, then run the action that performs it.
 *
 * The overlay is raised first and the action is dispatched only once the overlay
 * is on screen. The promise settles when the action has been dispatched, not when
 * the session has actually gone away (for a logout it never settles — the
 * process dies with the session). A failed action dismisses the overlay and is
 * logged; the announcement never blocks the caller's flow.
 */
export async function runSessionTransition(
  kind: SessionTransition,
  action: () => void | Promise<void>,
): Promise<void> {
  const label = kind === "lock" ? "Locking..." : "Logging out..."

  // The surfaces and the timers of ONE transition live in this call's own
  // closure: no module-scope state, so a transition started while a scrim is up
  // can never inherit or dismiss the other's windows.
  const wins = monitorList().map((mon) => overlayWindow(mon, label))
  const timers = new Set<number>()

  const dismiss = (): void => {
    for (const id of timers) GLib.source_remove(id)
    timers.clear()
    for (const win of wins) {
      try {
        win.destroy()
      } catch (e) {
        ignore("session-overlay destroy", e)
      }
    }
  }

  // Each armed callback drops its own id BEFORE returning, so a fired timer is
  // never removed twice (GLib logs a critical for an id that is already gone).
  const arm = (ms: number, fn: () => void): void => {
    let id = 0
    id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      timers.delete(id)
      fn()
      return GLib.SOURCE_REMOVE
    })
    timers.add(id)
  }

  const pollLock = (): void => {
    void hyprctlJson("locked").then((state) => {
      if (state?.locked === true) {
        // The lock surface is up and covers everything, this scrim with it; the
        // compositor's own state is the signal to take the scrim away, so the
        // unlock cannot reveal it again.
        dismiss()
        return
      }
      arm(LOCK_POLL_MS, pollLock)
    })
  }

  if (wins.length === 0) {
    // No monitor to cover: skip the announcement rather than fake it. The
    // transition itself is never conditional on the overlay.
    log("[session-overlay] no monitor to cover")
  } else {
    installCss()
    const shown = wins.map(whenShown)
    for (const win of wins) win.visible = true
    await Promise.all(shown)
  }

  try {
    await action()
  } catch (e) {
    log(`[session-overlay] ${kind} action failed: ${(e as Error).message}`)
    dismiss()
    return
  }

  if (wins.length === 0) return

  // The action was accepted. A lock is confirmed by the compositor's lock state;
  // a logout has nothing to watch — the session, this process with it, is on its
  // way out, and the linger covers the case where it is not.
  if (kind === "lock") arm(LOCK_POLL_MS, pollLock)
  arm(LINGER_MS, () => {
    log(`[session-overlay] ${kind} did not take the session away within ${LINGER_MS}ms`)
    dismiss()
  })
}
