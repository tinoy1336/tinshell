/**
 * keys/backend.ts — the input backend behind a module boundary.
 *
 * v1 path: **ydotool (uinput)** — NOT wtype. wtype 0.4 is broken on this
 * Hyprland 0.56.2 build: WAYLAND_DEBUG shows it
 * sends keycode 1 for EVERY key while its uploaded keymap defines keycodes
 * >= 8 (xkb minimum) — a keycode/keymap mismatch that strict compositors
 * resolve as NoSymbol; nothing received a single wtype key. ydotool (real
 * evdev keycodes through the compositor's own keymap) works in both a
 * Wayland and an XWayland app.
 *
 * Every keypress spawns a short-lived `ydotool key <code>:1 <code>:0`
 * (press+release pair per spawn — no stuck-key risk, the safe repeat form).
 * Key repeat is client-side (keys/repeat.ts): one spawn per tick.
 *
 * ydotoold must be running (a transient user unit). app.ts ensures it before
 * first use.
 *
 * The C-helper upgrade path (protocol-native virtual-keyboard-v1 with a
 * CORRECT keymap, one connection, xkb keymap control) swaps in behind this
 * interface if ydotool ever feels bad; the interface (sendKey/sendText) is
 * the only entry point Main.ts uses.
 */
import { run, spawnDetached } from "@common/subprocess/run"
import { log } from "../log"
import { keyArgv, keysymToEvdev } from "./evdev"

/** Fire-and-forget single key (press+release) via ydotool. */
export function sendKey(keysym: string): void {
  const spec = keysymToEvdev(keysym)
  if (!spec) {
    log(`sendKey: unknown keysym '${keysym}'`)
    return
  }
  spawnDetached(keyArgv(spec))
}

/** Fire-and-forget text typing via ydotool. */
export function sendText(text: string): void {
  spawnDetached(["ydotool", "type", text])
}

/** How long ONE ydotool delivery may take before it is reported as not
 *  delivered: the debug `key` command must answer
 *  (`error: ydotool failed for …`) instead of hanging on a wedged daemon. */
const YDOTOOL_DELIVERY_TIMEOUT_MS = 3_000

/** Awaited variant — used by the debug `key` command to verify keys land
 *  (exit 0 = ydotool delivered the events). */
export async function sendKeyChecked(keysym: string): Promise<boolean> {
  const spec = keysymToEvdev(keysym)
  if (!spec) return false
  try {
    const r = await run(keyArgv(spec), { timeoutMs: YDOTOOL_DELIVERY_TIMEOUT_MS })
    return r.exit === 0
  } catch (e) {
    // A spawn failure or the deadline above: answer the function's boolean
    // contract (not delivered) instead of rejecting into the request handler.
    log(`sendKeyChecked: ydotool failed for '${keysym}': ${(e as Error).message}`)
    return false
  }
}
