/**
 * Clipboard copy — puts a value on the default-seat clipboard.
 *
 * Text goes through GDK: GdkClipboard has `set_content(Gdk.ContentProvider)`,
 * and the working call is `Gdk.ContentProvider.new_for_value(text)` +
 * `set_content(provider)`.
 *
 * Images go through wl-copy: a provider built from PNG bytes
 * (`ContentProvider.new_for_bytes` + `set_content`) left the clipboard with NO
 * selection owner in the shell process — wl-paste reported no types at all —
 * while wl-copy holds the data reliably (byte-identical round trip through
 * wl-paste). The child reads the file AFTER this call returns, so a caller must
 * not unlink the file it passes; apps that render a scratch copy keep it at a
 * fixed path instead of deleting it.
 */
import Gdk from "gi://Gdk?version=4.0"
import { log } from "@common/log/logger"
import { shq } from "@common/subprocess/quote"
import { spawnDetached } from "@common/subprocess/run"

export function copy(text: string): void {
  const display = Gdk.Display.get_default()
  if (!display) return
  try {
    const provider = Gdk.ContentProvider.new_for_value(text)
    display.get_clipboard().set_content(provider)
  } catch (e) {
    log(`clipboard copy failed: ${(e as Error).message}`)
  }
}

/** Put a PNG file on the clipboard as `image/png` (see the module header for
 *  why this is wl-copy rather than a GDK provider). The file is read by the
 *  child, so it must outlive this call. */
export function copyImageFile(path: string): void {
  spawnDetached(["/bin/sh", "-c", `wl-copy -t image/png < ${shq(path)}`])
}
