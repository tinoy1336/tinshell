/**
 * polkit mount — the polkit AuthenticationAgent builder.
 *
 * Shared by the island app.ts (instanceName "polkit", io.Astal.polkit, unit
 * tinshell-polkit.service — the DEV island) and the shell instance. The app
 * has ZERO windows: it is a long-running session service holding the polkit
 * AuthenticationAgent on the SYSTEM bus; its UI is promptd's masked `input`
 * dialog (see agent.ts).
 */
import "./commands" // side-effect: registers request handlers against the shared registry
import { isProductionShell } from "@common/app/mode"
import { fileSink, setSink } from "@common/log/logger"
import { startAgent } from "./agent"

// Launched from systemd / the shell — stderr lands in journald, but the no-tty
// file-sink convention (dock pattern) keeps debug logs greppable in one
// place. Skipped only in the production shell (which owns the one global
// sink); the dev island unit logs here.
if (!isProductionShell) {
  setSink(fileSink("/tmp/tinshell-polkit-debug.log"), "[polkit]")
}

export function mountPolkit(): void {
  startAgent()
}
