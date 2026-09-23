/**
 * common/applets/host/mount — the applets backend, mounted inside the dock.
 *
 * The user session's OS-call surface: the 17 `common/applets/domains/*` domain
 * modules live once, in the dock process, which reaches them IN PROCESS
 * (`createInProcessBackend`, ./in-process) and serves the rest of the session
 * over the `applets` request namespace
 * (`ags request "applets battery state"` in the instance hosting the dock).
 *
 * One handler per domain, registered under the `applets` namespace. The
 * domains, their members and the invocation rules are derived from the module
 * exports in ./transport — this file only wires the registry.
 *
 * SECOND LISTEN SURFACE: the shared-group unix socket (./socket-server) for
 * clients that cannot reach the dock's D-Bus instance — the pre-login greeter
 * runs as another user in its own compositor. It serves the SAME request body
 * and envelope; the socket is additive (a bind failure is logged and the
 * request surface keeps serving unchanged).
 *
 * No quit teardown: the backend owns no persisted state to flush (the applet
 * state stores write synchronously on set) and its OS resources are process
 * bound (logind inhibit fd, D-Bus subscriptions, the tablet helper child) —
 * they end with the dock's process. The socket file is not unlinked on quit
 * either: a stale path answers ECONNREFUSED, clients probe by CONNECT (never
 * by the file existing), and the next bind unlinks it.
 */
import { APPLETS_NAMESPACE } from "@common/applets/backend-protocol"
import { restoreInhibitState } from "@common/applets/domains/power"
import { startTabletWatchdog } from "@common/applets/domains/tablet"
import { register } from "@common/commands/registry"
import { startAppletsSocket } from "./socket-server"
import { APPLETS_DOMAINS, handleDomainRequest } from "./transport"

export function mountAppletsBackend(): void {
  for (const domain of Object.keys(APPLETS_DOMAINS)) {
    register([APPLETS_NAMESPACE, domain], (args, res) => {
      void handleDomainRequest(domain, args).then(res)
    })
  }
  // The different-user transport. Its handle needs no teardown here (see the
  // header), so the return value is deliberately dropped.
  startAppletsSocket()
  // Arm the machine-wide tablet ingest from THIS process: the switch helper
  // child is process bound, so the process that owns it is the one that starts
  // it — a host that never mounts the backend (or can never call it at all,
  // see the socket's owner-only members) must not be the only way it comes up.
  startTabletWatchdog()
  // Re-apply the persisted sleep inhibit from THIS process: the logind fd it
  // holds dies with this process, so the backend process is the one that
  // restores it — so a dock restart keeps the lock.
  void restoreInhibitState()
}
