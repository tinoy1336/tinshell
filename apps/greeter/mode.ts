/**
 * The greeter's run modes, resolved ONCE from the environment.
 *
 * One entry serves four products; the mode is picked before anything mounts:
 *
 *   - PRODUCTION   (no flag)             the greetd login screen, with handoff
 *   - TINSHELL_GREETER_PREVIEW=1|login        windowed login-card prototype
 *   - TINSHELL_GREETER_PREVIEW=lock           windowed lock-card prototype
 *   - TINSHELL_GREETER_HARNESS=1              the REAL AstalGreet flow against
 *                                        dev/greetd-dummy.py (no real PAM)
 *   - TINSHELL_GREETER_MODE=lock              the in-session session lock
 *
 * Preview and harness render as plain Gtk.Windows in the live session (spawned
 * by preview.sh; harness sets GREETD_SOCK to the dummy server) and NEVER spawn
 * the login handoff — in harness that would SIGKILL the running session.
 * Lock mode reuses the login card UI over Gtk4SessionLock + AstalAuth.Pam and
 * carries no last-user state (the lock authenticates the process owner).
 */
import GLib from "gi://GLib"

// Windowed prototype mode (dev only): "1"/"login" render the login card,
// "lock" renders the lock card — BOTH as plain windows in the live session,
// no greetd IPC, no session lock, NO PAM.
const previewRaw = GLib.getenv("TINSHELL_GREETER_PREVIEW") ?? ""
export const preview = previewRaw === "1" || previewRaw === "login"
export const previewLock = previewRaw === "lock"

// Dev harness: like preview (plain window in the live session) but with the
// REAL AstalGreet login flow over $GREETD_SOCK, pointed at dev/greetd-dummy.py to
// test wrong/right-password UX without a real greetd/PAM/faillock.
export const harness = GLib.getenv("TINSHELL_GREETER_HARNESS") === "1"

// In-session session lock (ext-session-lock via Gtk4SessionLock), launched by
// hypridle's lock_cmd. No greetd/AstalGreet, no handoff.
export const lockMode = GLib.getenv("TINSHELL_GREETER_MODE") === "lock"
