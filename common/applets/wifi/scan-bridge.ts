/**
 * common/applets/wifi/scan-bridge.ts — decouples the wifi MENU from the wifi
 * APPLET. The menu owns scan STATE (it knows when a scan is in flight);
 * the applet owns the scan AFFORDANCE (the scan glyph on the applet row —
 * the in-menu spinner is gone). One hook slot: the applet registers on
 * mount and unsubscribes on cleanup; notify() is best-effort fire-and-forget
 * (a missing hook = no spin, never a menu failure).
 *
 * No app imports — a cycle-free leaf (wifi-menu.tsx and the applet both reach
 * it without importing each other).
 */

import { ignore } from "@common/log/logger"

type WifiScanHook = (on: boolean) => void

let hook: WifiScanHook | null = null

/** Register the applet's scan-spin driver. Returns an unsubscribe. */
export function setWifiMenuScanHook(fn: WifiScanHook | null): () => void {
  hook = fn
  return () => {
    if (hook === fn) hook = null
  }
}

/** The menu reports scan-state changes (open → on, close/radio-off → off). */
export function wifiMenuScanNotify(on: boolean): void {
  try {
    hook?.(on)
  } catch (e) {
    // The applet's hook drives the scan glyph; a failure here must never fail
    // the menu, but it is reported so a dead glyph is diagnosable.
    ignore("wifi scan bridge notify", e)
  }
}
