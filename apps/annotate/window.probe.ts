/**
 * window.probe — the editor registry's lifecycle contract, including the race
 * that stranded windows.
 *
 * Why it exists: two faults here cost a long-lived shell both memory and
 * windows, and neither is visible from a single manual open. A window closed
 * while the placement chain was still awaiting `hyprctl` was presented anyway —
 * re-showing a DESTROYED window that no longer sits in `editors`, so `close`,
 * `closeEditors()` and `quit` could never reach it again (six survived one rapid
 * open/close loop and only a shell restart cleared them). The probe drives that
 * exact interleaving and asserts BOTH halves afterwards: the registry is empty
 * AND no window was left behind.
 *
 * The image is a fixture this probe writes itself (a 1x1 PNG) — never one of the
 * operator's own files (canon `j38zbx`).
 *
 * Run (exit non-zero on any violated invariant):
 *   TINSHELL_SHELL=1 ags bundle --gtk 4 apps/annotate/window.probe.ts /tmp/a.sh && TINSHELL_SHELL=1 bash /tmp/a.sh
 *
 * `TINSHELL_SHELL=1` puts annotate in RESIDENT mode on purpose: as a plain island
 * it quits the app when its last window closes, which would end the probe before
 * its first assertion (common/app/mode.ts).
 */
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import app from "ags/gtk4/app"
import { closeEditors, getEditor, openEditor, unmountAnnotate } from "./window"

const FIXTURE = "/tmp/annotate-probe/fixture.png"

/** A 1x1 PNG, written by GDK itself so the bytes are certain to decode — the
 *  still loader opens this file for real. Never one of the operator's images. */
function writeFixture(): void {
  GLib.mkdir_with_parents(GLib.path_get_dirname(FIXTURE), 0o755)
  const tex = Gdk.MemoryTexture.new(
    2,
    2,
    Gdk.MemoryFormat.R8G8B8,
    new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
    6,
  )
  tex.save_to_png(FIXTURE)
}

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

/** Pump the default main context for `ms` so the placement chain's awaits (the
 *  hyprctl read + the rule registration) actually land. */
function pump(ms: number): void {
  const ctx = GLib.MainContext.default()
  const end = GLib.get_monotonic_time() + ms * 1000
  while (GLib.get_monotonic_time() < end) {
    while (ctx.pending()) ctx.iteration(false)
    GLib.usleep(2_000)
  }
}

writeFixture()

// The probe owns no host: emit the application's startup before any window is
// built, or GTK refuses to add windows ("New application windows must be added
// after the GApplication::startup signal has been emitted") and `app.windows`
// stays empty — which would make every window-count assertion meaningless.
try {
  app.register(null)
} catch (e) {
  console.log("note: application register reported: " + String(e))
}
pump(200)

const before = app.windows.length

// ── one open maps exactly one window and registers exactly one editor ──
openEditor(FIXTURE)
check("open registers an editor", getEditor() !== null, true)
pump(3000)
check("open maps one window", app.windows.length, before + 1)

// ── the close path releases both halves ──
closeEditors()
pump(1500)
check("close unregisters the editor", getEditor(), null)
check("close destroys the window", app.windows.length, before)

// ── THE RACE: close before the placement chain's awaits resolve ──
for (let i = 0; i < 6; i++) {
  openEditor(FIXTURE)
  closeEditors()
}
pump(3000)
check("a rapid open/close leaves no editor", getEditor(), null)
check("a rapid open/close presents no window", app.windows.length, before)

// ── the shell unmount path leaves nothing behind either ──
openEditor(FIXTURE)
pump(1500)
unmountAnnotate()
pump(1500)
check("unmount leaves no editor", getEditor(), null)
check("unmount leaves no window", app.windows.length, before)

// ── the registry is reusable after all of that ──
openEditor(FIXTURE)
pump(1500)
check("a later open still registers", getEditor() !== null, true)
closeEditors()
pump(1500)
check("and closes cleanly again", app.windows.length, before)

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`annotate window probe failed: ${failed.length} check(s)`)
