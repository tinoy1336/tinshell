/**
 * Runtime mode detection — resident instances vs standalone lazy islands.
 *
 * TINSHELL_SHELL=1 is set by tinshell-host.sh for EVERY instance with an eager member
 * — the production shell AND every resident island. It gates lifecycle
 * differences (quit-on-close, per-app log sinks): a resident instance never
 * dies with its last window. Islands (dev mode, per-app units / `ags run`)
 * may or may not set it — pure-lazy singletons do not.
 *
 * The PRODUCTION shell is identified by its instance name instead:
 * TINSHELL_HOST_INSTANCE=shell. Use isProductionShell for behaviour that must run
 * only in the real shell (e.g. skipping the per-app file sink — the shell
 * owns the one global sink).
 */
import GLib from "gi://GLib"

/** True in every RESIDENT instance (shell + resident islands; TINSHELL_SHELL=1).
 *  Gates quit-on-close lifecycles. NOT a shell discriminator. */
export const isShell = GLib.getenv("TINSHELL_SHELL") === "1"

/** True ONLY in the production shell instance (TINSHELL_HOST_INSTANCE=shell). */
export const isProductionShell = GLib.getenv("TINSHELL_HOST_INSTANCE") === "shell"

/** This instance's host name (TINSHELL_HOST_INSTANCE — set by tinshell-host.sh for
 *  every shape; the universal entry hard-errors when it is missing). The
 *  production shell is the instance named "shell"; every other resident
 *  instance (dev island / combo) carries its own name. Per-owner identity
 *  for files that must not be shared across instances (common/app/lazy's
 *  loaded-set memory). */
export const instanceName = GLib.getenv("TINSHELL_HOST_INSTANCE") ?? ""
