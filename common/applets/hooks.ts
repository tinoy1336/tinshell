/**
 * Applet hooks — the host-policy surface applet mounts call.
 *
 * The dock and the greeter give an applet different things: the dock parks it
 * in overflow, runs move mode, records interactions and owns the surface's
 * visibility; the greeter has a cell gate and nothing else. Those are HOST
 * policies, so an applet asks through this interface and never reaches into
 * the host's row object.
 *
 * Each host implements it over whatever it has (dock: its DockRow; greeter:
 * its row stub) and passes it in the mount context.
 */
export interface AppletHooks {
  /** Park/restore the applet in the host's row (overflow, pause grace). */
  setAppletHidden(name: string, hidden: boolean): void
  /** Mark the applet inactive (no player, tablet mode off) — the host keeps
   *  it laid out but stops offering interaction. */
  setAppletDeactivated(name: string, v: boolean): void
  /** Raise/clear the applet's attention state (recording indicator). */
  setAppletAttention(name: string, on: boolean): void
  /** Ask the host to hide/show the whole dock band (the screengrab applet
   *  clears the dock out of a capture). */
  setDockVisible(v: boolean): void
}
