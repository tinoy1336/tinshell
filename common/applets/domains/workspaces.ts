/**
 * common/applets/domains/workspaces.ts — workspace state for the workspaces applet
 * (common/applets/workspaces/index.ts).
 *
 * PRIMARY source: Hyprland socket2 (event stream). fetchWorkspaceState does
 * ONE async hyprctl call on each socket2 event and as the fallback path;
 * config.timing.workspacePoll is only a 30s safety net. socket2 emits
 * `workspace>>N` (focus change) and
 * `focusedmon>>MON,N` (monitor focus) as plain text lines; the listener
 * reconnects with backoff if Hyprland restarts.
 *
 * jumpToWorkspace dispatches through Hyprland's Lua API
 * (`hl.dsp.focus({ workspace = N })`),
 * the same pattern the media applet uses for its Goto-player jumps.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { focusWorkspace } from "@common/hyprland/dispatch"
import { ignore } from "@common/log/logger"
import { runCb } from "@common/subprocess/run"

export interface WorkspaceState {
  /** The focused workspace id. */
  active: number
}

/** Poll the active workspace. Fires onState once the hyprctl call has
 *  landed (a failed call contributes its default — active 0 — so the icon
 *  degrades to its fallback instead of freezing). */
export function fetchWorkspaceState(onState: (s: WorkspaceState) => void): void {
  runCb("hyprctl -j activeworkspace", (out) => {
    let active = 0
    try {
      const j = JSON.parse(out)
      active = Number(j?.id ?? 0) || 0
    } catch (_) {
      active = 0
    }
    onState({ active })
  })
}

/** Jump to a workspace via the Lua dispatcher. */
export function jumpToWorkspace(id: number): void {
  focusWorkspace(id)
}

// ── socket2 event stream ──

const RECONNECT_MS = 5000
const RECONNECT_MAX_MS = 30000

/** Subscribe to Hyprland socket2 workspace-relevant events
 *  (`workspace>>`, `focusedmon>>`). fn fires on every matching line; the
 *  consumer dedups by comparing the fetched active id. Returns an
 *  unsubscribe fn (gnim onCleanup-compatible). Reconnects with backoff
 *  while the stream is down (Hyprland restart), capped at 30s. */
export function onWorkspaceEvents(fn: () => void): () => void {
  let closed = false
  let conn: Gio.SocketConnection | null = null
  let lineStream: Gio.DataInputStream | null = null
  let reconnectId: number | null = null
  let backoff = RECONNECT_MS

  const disconnectNow = (): void => {
    lineStream = null
    if (conn) {
      try {
        conn.close(null)
      } catch (e) {
        // The hyprland socket stream already died with its owner.
        ignore("hyprland socket disconnect", e)
      }
      conn = null
    }
  }

  const scheduleReconnect = (): void => {
    disconnectNow()
    if (closed || reconnectId !== null) return
    reconnectId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, backoff, () => {
      reconnectId = null
      connectSocket()
      return GLib.SOURCE_REMOVE
    })
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
  }

  const pump = (): void => {
    if (closed || !lineStream) return
    lineStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_src, res) => {
      if (closed || !lineStream) return
      let line: string | null = null
      try {
        const [raw] = lineStream.read_line_finish(res)
        line = raw === null ? null : new TextDecoder().decode(raw)
      } catch (_) {
        line = null
      }
      if (line === null) {
        // EOF — Hyprland went away; reconnect.
        scheduleReconnect()
        return
      }
      if (
        line.startsWith("workspace>>") ||
        line.startsWith("focusedmon>>") ||
        line.startsWith("configreload>>")
      ) {
        try {
          fn()
        } catch (e) {
          print(`[workspaces] event callback threw: ${e}`)
        }
      }
      pump()
    })
  }

  const connectSocket = (): void => {
    if (closed) return
    const sig = GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE")
    const path = sig ? `${GLib.get_user_runtime_dir()}/hypr/${sig}/.socket2.sock` : null
    if (!path) {
      scheduleReconnect()
      return
    }
    const sc = new Gio.SocketClient()
    sc.connect_async(Gio.UnixSocketAddress.new(path), null, (src, res) => {
      if (closed) return
      try {
        conn = (src as Gio.SocketClient).connect_finish(res)
        lineStream = new Gio.DataInputStream({ base_stream: conn.get_input_stream() })
        backoff = RECONNECT_MS
        pump()
      } catch (_) {
        scheduleReconnect()
      }
    })
  }

  connectSocket()

  return () => {
    closed = true
    if (reconnectId !== null) {
      GLib.source_remove(reconnectId)
      reconnectId = null
    }
    disconnectNow()
  }
}
