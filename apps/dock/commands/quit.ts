/**
 * dock/commands/quit.ts — `dock quit`: fade the dock surfaces out, then quit.
 *
 * The shim's quit path (App.quit → g_application_quit → exit(code)) hard-exits
 * the process before GApplication ever emits ::shutdown (verified: a
 * quit()+exit(0) sequence never reaches the signal, while quit() alone does),
 * so the dock's own request command is the fading quit entry point instead
 * (createApp's generic quit is not registered for the island — the dock owns
 * this command).
 *
 * The reply is sent BEFORE the teardown, and the teardown is deferred to an
 * idle callback: the reply only reaches the bus once this handler returns (it is
 * a promise continuation), and fadeOutAllSync's main-context pump then flushes
 * it before app.quit() stops the bus service and exits.
 *
 * Teardown order: SIGINT any in-flight wf-recorder first (it finalizes the file
 * before the process dies), then the fade.
 *
 * The process QUIT is gated on the dock OWNING the process (dockOwnsProcess):
 * the dock is an eager member of every host that mounts it, and in a host that
 * carries other apps — the production shell, a combo — the fade is the whole
 * teardown. Quitting the process there would take down apps this request never
 * named; the host's own `<instance> quit` is its quit path.
 */
import GLib from "gi://GLib"
import { instanceName, isShell } from "@common/app/mode"
import { register } from "@common/commands/registry"
import app from "ags/gtk4/app"
import { getDockSurfaces } from "../Dock"
import { fadeOutAllSync } from "../fade"
import { stopRecording } from "../screengrab/capture"

/** True in a process the dock OWNS: its own island in either host shape — the
 *  universal entry (`tinshell-host start dock`, TINSHELL_HOST_INSTANCE=dock) or its
 *  per-app bundle (`run.sh dock`, the boot fleet's per-app path: no
 *  TINSHELL_HOST_INSTANCE, therefore not resident). Every OTHER host that mounts
 *  the dock is resident (TINSHELL_SHELL=1) and carries further apps, so a
 *  `dock quit` there fades the dock and leaves the host alive. */
const dockOwnsProcess = instanceName === "dock" || !isShell

register(["dock", "quit"], (_args, res) => {
  res("quitting")
  GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    stopRecording()
    fadeOutAllSync(getDockSurfaces().map((s) => s.window))
    if (dockOwnsProcess) app.quit()
    return GLib.SOURCE_REMOVE
  })
})
