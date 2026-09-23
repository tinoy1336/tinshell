/**
 * SessionPicker — enumerates login sessions from
 *   /usr/share/wayland-sessions/*.desktop  (wayland)
 *   /usr/share/xsessions/*.desktop         (x11)
 * and renders a horizontal chooser row. Hidden entries: any whose TryExec
 * (or, failing that, first Exec word) is not available — this hides
 * hyprland-uwsm.desktop (uwsm is not installed) automatically.
 *
 * The selected session is the value passed to AstalGreet's
 * start_session(cmd, env): cmd = cleaned Exec argv, env = XDG_SESSION_TYPE /
 * XDG_SESSION_DESKTOP / XDG_CURRENT_DESKTOP (greetd must receive these
 * BEFORE the PAM session opens — the greeter is the only place to set them).
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ignore } from "@common/log/logger"
import { Gtk } from "ags/gtk4"
import { get } from "../config"

type SessionType = "wayland" | "x11"

export interface SessionEntry {
  /** .desktop basename, e.g. "hyprland.desktop" (also the config key). */
  id: string
  /** Localized display name. */
  name: string
  /** argv for start_session. */
  exec: string[]
  /** "KEY=VALUE" env for start_session. */
  env: string[]
  type: SessionType
}

/** Strip freedesktop Exec field codes (%f %F %u %U %d %D %n %N %i %c %k %v %m) and collapse %% → %. */
const FIELD_CODES = /%[fFuUdDnNickvm]/g
function cleanExec(raw: string): string {
  return raw.replace(/%%/g, "\x00").replace(FIELD_CODES, "").split("\x00").join("%").trim()
}

function programAvailable(probe: string): boolean {
  if (!probe) return false
  return GLib.find_program_in_path(probe) !== null || GLib.file_test(probe, GLib.FileTest.EXISTS)
}

function parseDesktop(path: string, id: string, type: SessionType): SessionEntry | null {
  const kf = new GLib.KeyFile()
  try {
    kf.load_from_file(path, GLib.KeyFileFlags.NONE)
  } catch (e: any) {
    console.warn(`[greeter] unreadable session file ${path}: ${e?.message ?? e}`)
    return null
  }
  // Gio.KeyFile on this GLib: get_string/get_locale_string THROW on a missing
  // key (and get_keys returns a [array, length] tuple, not a string[] as the
  // .d.ts claims — gjs binding gap, same family as Graphene/Rect). Wrap in
  // try/catch instead of enumerating keys.
  const str = (key: string): string => {
    try {
      return kf.get_string("Desktop Entry", key) ?? ""
    } catch {
      return ""
    }
  }
  const loc = (key: string): string => {
    try {
      return kf.get_locale_string("Desktop Entry", key, null) ?? ""
    } catch {
      return ""
    }
  }
  try {
    const name = loc("Name") || str("Name")
    const exec = str("Exec").trim()
    const tryExec = str("TryExec")
    if (!name || !exec) return null
    // Availability gate: TryExec wins; else the Exec's first word. hyprland-
    // uwsm.desktop's TryExec=uwsm fails here (uwsm not installed) → hidden.
    const probe = (tryExec || exec.split(/\s+/)[0]).replace(/^["']|["']$/g, "")
    if (!programAvailable(probe)) return null
    const desktopNames = str("DesktopNames") || name
    const argv = cleanExec(exec).split(/\s+/).filter(Boolean)
    if (argv.length === 0) return null
    return {
      id,
      name,
      exec: argv,
      env: [
        `XDG_SESSION_TYPE=${type}`,
        `XDG_SESSION_DESKTOP=${name}`,
        `XDG_CURRENT_DESKTOP=${desktopNames.split(";")[0] || name}`,
      ],
      type,
    }
  } catch (e) {
    // Missing required keys → not a usable session entry.
    ignore("session entry parse", e)
    return null
  }
}

function scanDir(dir: string, type: SessionType): SessionEntry[] {
  const out: SessionEntry[] = []
  const dirFile = Gio.File.new_for_path(dir)
  const children: Gio.FileInfo[] = []
  try {
    const it = dirFile.enumerate_children(
      "standard::name,standard::type",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    let info: Gio.FileInfo | null
    while ((info = it.next_file(null))) children.push(info)
  } catch {
    return out // dir missing → no sessions of this type
  }
  for (const info of children) {
    if (info.get_file_type() !== Gio.FileType.REGULAR) continue
    const id = info.get_name()
    if (!id.endsWith(".desktop")) continue
    const entry = parseDesktop(`${dir}/${id}`, id, type)
    if (entry) out.push(entry)
  }
  return out
}

/** Enumerate + filter all available sessions (wayland first, then x11). */
export function loadSessions(): SessionEntry[] {
  return [
    ...scanDir("/usr/share/wayland-sessions", "wayland"),
    ...scanDir("/usr/share/xsessions", "x11"),
  ]
}

interface SessionPickerResult {
  widget: Gtk.Widget
  getSelected(): SessionEntry | null
}

export default function SessionPicker(sessions: SessionEntry[]): SessionPickerResult {
  let selected: SessionEntry | null = null
  let box!: Gtk.Box
  /** The session buttons with the id each one selects — the picker's own
   *  bookkeeping (no id is stashed on the widget). */
  const buttons: { button: Gtk.Button; id: string }[] = []

  const defaultId = get<string>("defaultSession", "hyprland.desktop")
  selected = sessions.find((s) => s.id === defaultId) ?? sessions[0] ?? null

  function pick(s: SessionEntry): void {
    selected = s
    for (const b of buttons) {
      if (b.id === s.id) b.button.add_css_class("selected")
      else b.button.remove_css_class("selected")
    }
  }

  const boxEl = (
    <box
      class="greeter-sessions"
      spacing={8}
      halign={Gtk.Align.CENTER}
      $={(self) => {
        box = self
      }}
    >
      {sessions.map((s) => (
        // biome-ignore lint/a11y/useButtonType: TINSHELL GTK4 Button widget (no HTML type prop)
        <button
          class={"greeter-session-btn" + (selected?.id === s.id ? " selected" : "")}
          label={s.name}
          $={(b) => {
            buttons.push({ button: b, id: s.id })
            b.connect("clicked", () => pick(s))
          }}
        />
      ))}
    </box>
  )
  void boxEl

  if (sessions.length === 0) {
    const label = new Gtk.Label({ label: "No sessions available" })
    label.add_css_class("greeter-sessions-empty")
    return { widget: label, getSelected: () => null }
  }

  return { widget: box, getSelected: () => selected }
}
