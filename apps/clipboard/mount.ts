/**
 * clipboard app — the clipboard surface as a REAL standalone app
 * (bus io.Astal.clipboard). Sources live here (capture, Picker, store).
 * Capture loop is config-gated (clipboard.capture, startup-read).
 *
 * Production runs inside the shell; this island is the DEV shape.
 * Config: the clipboard's OWN store + facade (./config).
 */
import "./commands"
import "@common/log/debug-log" // sets the ONE sink (file /tmp/tinshell-debug.log)
import theme from "@common/shell/theme.css"
import { startCapture } from "./capture"
import { setControl } from "./commands"
import { config } from "./config"
import Picker, { pickerControl } from "./Picker"
import { all } from "./store"
import { buildClipboardCss } from "./style"
import style from "./style.css"
import { backfillThumbs } from "./thumbs"

export const clipboardCss = `${theme}\n${style}\n${buildClipboardCss()}`

/** Clipboard: resident capture loop (config-gated) + picker popup. */
export function clipboardMount(): void {
  // Resident capture loop (startup-read gate: clipboard.capture, keyboard-
  // gating style) + the picker popup, built once, shown on demand
  // (launcher/promptd pattern).
  if (config.capture) startCapture()
  // Entries captured before the thumbnail cache existed have none: build them
  // in the background here, so the picker's first open is already fast (see
  // thumbs.ts for why the picker must never decode an entry's full PNG).
  backfillThumbs(
    all()
      .filter((e) => e.mime === "image")
      .map((e) => e.id),
  )
  Picker()
  setControl(pickerControl())
}
