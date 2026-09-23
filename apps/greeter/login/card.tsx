/**
 * LoginCard — the greeter's centred login card:
 *   clock (time/date) → username → password (eye toggle) → status → session
 *   picker → submit.
 *
 * Pure UI: it reports submissions to a callback and exposes a control handle
 * (setStatus / setBusy / resetPassword / clearStatus) that the auth backend
 * (app.ts — the AstalGreet Greeter, or a preview fake) drives.
 */

import GLib from "gi://GLib"
import { FONT_FAMILY } from "@common/css/tokens"
import { hoverGlyph } from "@common/glyph/hover-glyph"
import { passwordEye } from "@common/glyph/password-eye"
import { Gtk } from "ags/gtk4"
import { get } from "../config"
import { readLastUser } from "../state"
import { fieldAccent, greeterPalette, rgbaTuple } from "../theme"
import Clock from "./clock"
import SessionPicker, { type SessionEntry } from "./sessions"

export interface LoginCardHandle {
  setStatus(msg: string, kind: "info" | "error"): void
  /** Auth failure — promptd's wrong-password treatment: show the error, the
   *  mask dots go red, focus returns to the password entry. Red clears on
   *  the first edit (changed handler). Text is NOT cleared. */
  authFailed(msg: string): void
  setBusy(busy: boolean): void
  resetPassword(): void
  clearStatus(): void
}

interface LoginCardResult {
  widget: Gtk.Widget
  handle: LoginCardHandle
}

export default function LoginCard(
  onSubmit: (user: string, pass: string, session: SessionEntry) => void,
  sessions: SessionEntry[],
  opts?: { lock?: boolean },
): LoginCardResult {
  let userEntry: Gtk.Entry | null = null
  let passEntry: Gtk.Entry | null = null
  let statusLabel: Gtk.Label | null = null
  let submitGlyph: Gtk.DrawingArea | null = null
  let busy = false

  // Lock mode (opts.lock): the card authenticates the process owner. The
  // username is forced visible + prefilled read-only from $USER, and the
  // session picker is hidden (there is no session to select on a lock).
  const lockMode = opts?.lock ?? false

  const userFieldVisible = lockMode || get<boolean>("appearance.userFieldVisible", true)
  const fieldWidth = get<number>("appearance.fieldWidth", 320)
  const picker = SessionPicker(sessions)
  // Hide the picker when there's only one session — the selection is then
  // just baked in (the picker's getSelected still returns the single one).
  // The "No sessions available" empty state still shows when there are 0.
  const pickerVisible = lockMode
    ? false
    : get<boolean>("appearance.sessionPickerVisible", true) && sessions.length > 1
  const lastUser = lockMode ? GLib.get_user_name() : readLastUser()
  // Function-scope (used by BOTH the entry prefill and the map focus grab).
  const prefill = lastUser || get<string>("defaultUser", "").trim()

  const pal = greeterPalette()
  const eye = passwordEye({
    getEntry: () => passEntry,
    // The field glyphs sit on the well's dark glass: the muted tone at rest, the
    // suite's accent halo on hover (the menus' glyph convention).
    rest: rgbaTuple(pal.mutedText, 0.9),
    glowAlpha: pal.glowAlpha,
  })
  const eyeGlyph = eye.widget

  // Submit affordance: a glyph inside the password field.
  // Enter on the password entry submits too.
  const submitHover = hoverGlyph({
    emoji: "\udb83\udcdf", // 󰳟 — login/enter glyph
    box: 24,
    fontSize: 13,
    rest: rgbaTuple(pal.text, 0.85),
    fontFamily: FONT_FAMILY,
    hover: {
      colour: rgbaTuple(pal.text, 1),
      // The in-field glyph glow follows the fields' OFF-TOKEN accent
      // (fieldAccent(): the off-white tone, not the blue menu.accent).
      glow: rgbaTuple(fieldAccent(pal), 1),
      glowAlpha: pal.glowAlpha,
    },
    ownHover: true,
    onClick: () => submit(),
  })
  submitGlyph = submitHover.widget

  const handle: LoginCardHandle = {
    setStatus(msg, kind) {
      if (!statusLabel) return
      statusLabel.label = msg
      statusLabel.remove_css_class("greeter-status-error")
      statusLabel.remove_css_class("greeter-status-info")
      statusLabel.add_css_class(kind === "error" ? "greeter-status-error" : "greeter-status-info")
    },
    authFailed(msg) {
      this.setStatus(msg, "error")
      // promptd's wrong-password state: dots + caret red, focus back on the
      // entry, text kept. Cleared on the first edit (changed handler).
      passEntry?.add_css_class("greeter-entry-error")
      passEntry?.grab_focus()
    },
    setBusy(b) {
      busy = b
      for (const w of [userEntry, passEntry, submitGlyph]) {
        if (w) w.sensitive = !b
      }
    },
    resetPassword() {
      if (!passEntry) return
      passEntry.text = ""
      passEntry.grab_focus()
    },
    clearStatus() {
      if (statusLabel) statusLabel.label = ""
    },
  }

  function submit(): void {
    if (busy) return
    const user =
      (userEntry?.text ?? "").trim() || readLastUser() || get<string>("defaultUser", "").trim()
    if (!user) {
      handle.setStatus("Enter a username", "info")
      userEntry?.grab_focus()
      return
    }
    // Lock mode: no session selection — the backend (AstalAuth) authenticates
    // the process owner and ignores user/session.
    if (!lockMode) {
      const session = picker.getSelected()
      if (!session) {
        handle.setStatus("No session selected", "error")
        return
      }
      handle.clearStatus()
      handle.setBusy(true)
      onSubmit(user, passEntry?.text ?? "", session)
      return
    }
    handle.clearStatus()
    handle.setBusy(true)
    // SAFETY: lock mode has no session selection — the null session is never
    // used by the auth backend (unlock path ignores it).
    onSubmit(user, passEntry?.text ?? "", null as unknown as SessionEntry)
  }

  let root!: Gtk.Box
  const rootEl = (
    <box
      class="greeter-root"
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.CENTER}
      hexpand
      vexpand
      $={(self) => {
        root = self
        // Initial focus on map (grabbing at build time races the compositor):
        // prefilled username → straight to the password field (returning
        // users just type); blank → username field.
        self.connect("map", () => {
          if (prefill && userFieldVisible) passEntry?.grab_focus()
          else if (userEntry) userEntry?.grab_focus()
          else passEntry?.grab_focus()
        })
      }}
    >
      <box
        class="greeter-card"
        orientation={Gtk.Orientation.VERTICAL}
        spacing={0}
        $={(card) => {
          card.set_size_request(get<number>("appearance.cardWidth", 440), -1)
        }}
      >
        {get<boolean>("appearance.clockVisible", true) && <Clock />}
        {userFieldVisible && (
          <box
            class="greeter-field"
            halign={Gtk.Align.CENTER}
            $={(f) => f.set_size_request(fieldWidth, -1)}
          >
            <entry
              class="greeter-entry"
              placeholder-text="Username"
              hexpand
              editable={!lockMode}
              $={(e) => {
                userEntry = e
                if (prefill) e.text = prefill
                e.connect("activate", () => passEntry?.grab_focus())
              }}
            />
          </box>
        )}
        <box
          class="greeter-field"
          halign={Gtk.Align.CENTER}
          $={(f) => f.set_size_request(fieldWidth, -1)}
        >
          <entry
            class="greeter-entry"
            placeholder-text="Password"
            visibility={false}
            hexpand
            $={(e) => {
              passEntry = e
              // Masked chars are `*` (not the theme's bullet) per user.
              e.set_invisible_char("*")
              e.connect("activate", () => submit())
              // Red error state clears on edit (promptd).
              e.connect("changed", () => e.remove_css_class("greeter-entry-error"))
            }}
          />
          {eyeGlyph}
          {submitGlyph}
        </box>
        <label class="greeter-status" label="" $={(l) => (statusLabel = l)} />
        {pickerVisible && picker.widget}
      </box>
    </box>
  )
  void rootEl

  return {
    widget: root,
    handle,
  }
}
