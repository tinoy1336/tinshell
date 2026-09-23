/**
 * media picker — the portal file prompt a media window raises when it was
 * opened without a file.
 *
 * The prompt goes through the xdg-desktop-portal FileChooser interface
 * (`org.freedesktop.portal.FileChooser.OpenFile`) rather than a GTK dialog:
 * the portal routes the request to whichever backend the session prefers —
 * here the TINSHELL portal app (`io.Astal.portal`; `portals.conf` maps the
 * FileChooser impl to `tinshell-portal`) — so the chooser the user sees is the
 * house one, styled like the rest of the home.
 *
 * Wire shape (the portal spec): the caller picks a `handle_token`, and the
 * portal answers the call with the Request object it will emit `Response` on
 * — a path derived from the token and the caller's unique bus name, which is
 * known BEFORE the call, so the subscription is armed first and no race
 * exists between the reply and the call's return. `Response` carries
 * `(u response, a{sv} results)`; `response` 0 means a file was chosen (uris
 * in `results.uris`), 1 means the user cancelled, anything else is an error.
 *
 * The prompt carries no parent window: the portal's `parent_window` string
 * needs an xdg-foreign export handle, which GTK4 does not expose; an empty
 * string is the spec's own value for "no parent".
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { log } from "@common/log/logger"

const PORTAL_BUS = "org.freedesktop.portal.Desktop"
const PORTAL_PATH = "/org/freedesktop/portal/desktop"
const CHOOSER_IFACE = "org.freedesktop.portal.FileChooser"
const REQUEST_IFACE = "org.freedesktop.portal.Request"

let promptSeq = 0

/** The Request object path the portal derives from a caller's bus name and
 *  handle token (`:1.42` + `ags_media_7` → `…/request/1_42/ags_media_7`). */
function requestPath(busName: string, handleToken: string): string {
  const sender = busName.replace(/^:/, "").replace(/\./g, "_")
  return `${PORTAL_PATH}/request/${sender}/${handleToken}`
}

/**
 * Ask the portal for a media file. `onPicked` receives the chosen file's
 * path; a cancelled or failed prompt calls nothing (the window stays as it
 * was — empty, for the no-file case).
 */
export function pickMediaFile(onPicked: (path: string) => void): void {
  let bus: Gio.DBusConnection
  try {
    bus = Gio.DBus.session
  } catch (e) {
    log(`media: no session bus for the file prompt: ${String(e)}`)
    return
  }

  promptSeq += 1
  const handleToken = `ags_media_${GLib.get_monotonic_time()}_${promptSeq}`
  const uniqueName = bus.get_unique_name() ?? ""
  const predicted = requestPath(uniqueName, handleToken)

  const sub = bus.signal_subscribe(
    PORTAL_BUS,
    REQUEST_IFACE,
    "Response",
    predicted,
    null,
    Gio.DBusSignalFlags.NONE,
    (_conn, _sender, _path, _iface, _signal, params) => {
      bus.signal_unsubscribe(sub)
      let response = -1
      let results: any = null
      try {
        ;[response, results] = params.deepUnpack() as [number, any]
      } catch (e) {
        log(`media: unreadable file-prompt reply: ${String(e)}`)
        return
      }
      if (response !== 0) {
        log(`media: file prompt closed without a file (response ${response})`)
        return
      }
      let uris: string[] = []
      try {
        // a{sv} values stay wrapped as GLib.Variant.
        uris = (results?.uris?.deepUnpack?.() ?? []) as string[]
      } catch (e) {
        log(`media: unreadable file-prompt uris: ${String(e)}`)
      }
      const uri = uris[0]
      if (!uri) {
        log("media: file prompt answered with no uri")
        return
      }
      const path = uri.startsWith("file:") ? Gio.File.new_for_uri(uri).get_path() : null
      if (!path) {
        log(`media: file prompt returned a non-local uri: ${uri}`)
        return
      }
      onPicked(path)
    },
  )

  const options = {
    handle_token: new GLib.Variant("s", handleToken),
    multiple: new GLib.Variant("b", false),
  }
  try {
    bus.call(
      PORTAL_BUS,
      PORTAL_PATH,
      CHOOSER_IFACE,
      "OpenFile",
      new GLib.Variant("(ssa{sv})", ["", "open media", options]),
      new GLib.VariantType("(o)"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_src, res) => {
        let handle: string | null = null
        try {
          ;[handle] = (bus.call_finish(res) as any).deepUnpack()
        } catch (e) {
          // No portal (or no FileChooser backend): nothing to show. The window
          // stays empty rather than growing a dialog of its own.
          log(`media: file prompt failed: ${String(e)}`)
          bus.signal_unsubscribe(sub)
          return
        }
        if (handle && handle !== predicted) {
          log(`media: file prompt request handle differs: ${handle} (subscribed ${predicted})`)
        }
      },
    )
  } catch (e) {
    log(`media: file prompt could not be sent: ${String(e)}`)
    bus.signal_unsubscribe(sub)
  }
}
