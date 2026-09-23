/**
 * Hyprland dispatch + state helpers — the cross-app hyprctl wrapper.
 *
 * This is a Lua-config Hyprland build (0.56+). The standard
 * `hyprctl dispatch exec "cmd"` does NOT work — it routes through the Lua
 * interpreter and errors on the command string. The working form is the Lua
 * function-call dispatch: `hyprctl dispatch "hl.dsp.<fn>(...)"`. This module
 * owns that gotcha once so call sites stop hand-rolling the eval string.
 * A runtime string interpolated into such a dispatch is a Lua string literal
 * first and a shell command only after Lua decodes it: `./lua-string` owns that
 * encoding (`luaStringLiteral`).
 *
 * Provides:
 *   - `launchPinned(cmd, workspace?, float?)` — workspace-pinned app launch
 *       (Hyprland's PID-scoped initial-workspace rule; survives the app's
 *       multi-second startup delay; does not move existing same-class windows).
 *       Pass `float=true` to also float the launched window (stacked on top).
 *   - `focusWorkspace(id)` — switch workspace
 *   - `focusWindow(addr)` — focus a window by its `address:0x...` id
 *   - `activeWorkspaceId()` — read the focused workspace id (Promise)
 *   - `hyprctlJson(cmd)` — raw JSON read (e.g. "hyprctl -j clients")
 *
 * All dispatches are fire-and-forget (hyprctl exits fast); JSON reads resolve
 * async so they never block the GTK main loop.
 */
import GLib from "gi://GLib"
import { ignore } from "@common/log/logger"
import { run, runCb, spawnDetached } from "@common/subprocess/run"
import { luaStringLiteral } from "./lua-string"

/** hyprctl reads answer locally in milliseconds; a wedged compositor or a stuck
 *  hyprctl must not hang the caller forever. Both readers below answer their
 *  documented failure value (null) past this deadline. */
const HYPRCTL_READ_TIMEOUT_MS = 3_000

/**
 * Launch `cmd` pinned to a workspace. If `workspace` is omitted, the active
 * workspace id is read first (the common case — pin to wherever the user is).
 * When `float` is true, the launched window also floats (stacked on top) via
 * the `float=true` initial rule in the same dispatch.
 * Falls back to a bare unpinned launch if hyprctl is unavailable.
 *
 * `cmd` is a SHELL COMMAND LINE, not one argv word: `hl.dsp.exec_cmd` hands the
 * decoded string to `sh -c`, so a caller with arguments of its own must
 * shell-quote each one (`common/subprocess/quote`) — and its backslashes and
 * quotes then have to survive the Lua literal this module wraps the string in
 * (`./lua-string`).
 */
export async function launchPinned(cmd: string, workspace?: number, float = false): Promise<void> {
  const ws = workspace ?? (await activeWorkspaceId())

  // Single-instance fallback: apps like Firefox/Chromium hand off to an
  // already-running process, so the PID-scoped `float=true` initial rule never
  // matches the new window. Capture the pre-launch focused window so a delayed
  // float can tell when focus moved to a NEW window and float it explicitly.
  const preAddr = float ? await focusedAddress() : null

  if (ws === null) {
    // Fallback: no workspace read — fire the bare command via hyprctl dispatch.
    const lua = float
      ? `hl.dsp.exec_cmd(${luaStringLiteral(cmd)}, {float=true})`
      : `hl.dsp.exec_cmd(${luaStringLiteral(cmd)})`
    spawnDetached(["hyprctl", "dispatch", lua])
  } else {
    const rules = float ? `{workspace=${ws}, float=true}` : `{workspace=${ws}}`
    const lua = `hl.dsp.exec_cmd(${luaStringLiteral(cmd)}, ${rules})`
    spawnDetached(["hyprctl", "dispatch", lua])
  }

  if (float) schedulePostLaunchFloat(preAddr)
}

/** Jump to a workspace via the Lua dispatcher. Fire-and-forget. */
export function focusWorkspace(id: number): void {
  runCb(`hyprctl dispatch "hl.dsp.focus({ workspace = ${id} })"`, () => {})
}

/** Focus a window by its `address:0x…` id. Fire-and-forget. */
export function focusWindow(addr: string): void {
  runCb(`hyprctl dispatch "hl.dsp.focus({ window = 'address:${addr}' })"`, () => {})
}

/** Read the focused workspace id via `hyprctl -j activeworkspace`. null on failure. */
export async function activeWorkspaceId(): Promise<number | null> {
  try {
    const res = await run(["hyprctl", "-j", "activeworkspace"], {
      timeoutMs: HYPRCTL_READ_TIMEOUT_MS,
    })
    if (res.exit !== 0) return null
    const parsed = JSON.parse(res.stdout)
    const id = parsed?.id
    return typeof id === "number" ? id : null
  } catch (e) {
    ignore("hyprctl activeworkspace read", e)
    return null
  }
}

/** Read JSON from a hyprctl command (e.g. "clients", "activewindow").
 *  Pass the JSON subcommand without the `hyprctl -j ` prefix. */
export async function hyprctlJson(subcmd: string): Promise<any | null> {
  try {
    const res = await run(["hyprctl", "-j", subcmd], { timeoutMs: HYPRCTL_READ_TIMEOUT_MS })
    if (res.exit !== 0) return null
    return JSON.parse(res.stdout)
  } catch (e) {
    ignore(`hyprctl ${subcmd} read`, e)
    return null
  }
}

/** Read the RAW stdout of a hyprctl JSON command (e.g. "clients"). For callers
 *  whose parser takes the JSON text itself (the media-window match). */
export async function hyprctlText(subcmd: string): Promise<string | null> {
  try {
    const res = await run(["hyprctl", "-j", subcmd], { timeoutMs: HYPRCTL_READ_TIMEOUT_MS })
    return res.exit === 0 ? res.stdout : null
  } catch (e) {
    ignore(`hyprctl ${subcmd} read`, e)
    return null
  }
}

/** Read the focused window's `address:0x…` id, or null if none is focused. */
async function focusedAddress(): Promise<string | null> {
  const aw = await hyprctlJson("activewindow")
  const addr = aw?.address
  return typeof addr === "string" ? addr : null
}

/**
 * Post-launch fallback float for single-instance apps. The `float=true`
 * initial rule (PID-scoped) already floats fresh-process apps; apps like
 * Firefox hand off to an existing process so the rule never matches. When
 * focus moves to a NEW window that is still tiled, float it explicitly.
 * Scheduled twice (500/1300ms) to catch slow-to-map windows; the second run
 * is a no-op if the first already floated (floating becomes truthy).
 */
function schedulePostLaunchFloat(preAddr: string | null): void {
  for (const delayMs of [500, 1300]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
      void (async () => {
        try {
          const aw = await hyprctlJson("activewindow")
          const addr: string | null = typeof aw?.address === "string" ? aw.address : null
          if (addr === null || addr === preAddr) return // focus hasn't moved to a new window — do nothing
          if (aw?.floating) return // already floating (the float=true rule handled it)
          spawnDetached(["hyprctl", "dispatch", `hl.dsp.window.float({action="set"})`])
        } catch {
          /* best-effort fallback — never throw into the main loop */
        }
      })()
      return GLib.SOURCE_REMOVE
    })
  }
}
