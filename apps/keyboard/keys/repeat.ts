/**
 * keys/repeat.ts — client-side key repeat.
 *
 * ydotool has no repeat, so the keyboard owns it: press → send the first key
 * immediately (in Main.ts) → if held past `repeat.delayMs`, emit `sendKey` at
 * `repeat.rateHz` until release. ONE ydotool spawn per tick, each a
 * press+release pair — killing/aborting any tick can never leave a stuck key
 * (the pair is atomic in one short-lived process).
 */
import GLib from "gi://GLib"
import { config } from "../config"
import { sendKey } from "./backend"

let phase: "none" | "delay" | "repeat" = "none"
let timer: number | null = null
let keysym: string | null = null

function clearTimer(): void {
  if (timer !== null) {
    GLib.source_remove(timer)
    timer = null
  }
}

/** Called on key press for repeat-enabled keys. Waits `repeat.delayMs`
 *  (default 400) before the first REPEAT tick — Main.ts already sent the
 *  press key — then emits one tick every `1/repeat.rateHz` until release. */
export function startRepeat(k: string): void {
  stopRepeat()
  keysym = k
  const delay = config.repeat.delayMs ?? 400
  const period = 1000 / (config.repeat.rateHz ?? 30)
  phase = "delay"
  timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
    phase = "repeat"
    sendKey(keysym as string)
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, period, () => {
      if (keysym) sendKey(keysym)
      return GLib.SOURCE_CONTINUE
    })
    return GLib.SOURCE_REMOVE
  })
}

/** Called on key release (and on any cancel path). */
export function stopRepeat(): void {
  clearTimer()
  phase = "none"
  keysym = null
}

/** Debug/introspection. */
export function repeatInfo(): string {
  return `phase=${phase} keysym=${keysym ?? "none"} delayMs=${config.repeat.delayMs} rateHz=${config.repeat.rateHz}`
}
