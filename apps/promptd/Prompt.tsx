/**
 * promptd window — ONE centred modal window reused for every prompt:
 * ask (masked/text/number), approve (command list + password), confirm,
 * choice (single-select list), form (multi-field).
 *
 * Mirrors the launcher's window shape: namespace "promptd" (Hyprland blur
 * layerrule), overlay layer, centred, keymode EXCLUSIVE while visible.
 * DELIBERATE DIFFERENCE from the launcher: no auto-hide on focus loss —
 * answering or cancelling is the only exit.
 *
 * Secrets: the approve flow writes the password to a 0600 temp file and only
 * the file path leaves this process. ask returns the password on stdout per
 * the askpass contract (that is the caller's bridge job).
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { FONT_FAMILY } from "@common/css/tokens"
import { hoverGlyph } from "@common/glyph/hover-glyph"
import { createSpinnerGlyph } from "@common/glyph/spinner"
import { ignore } from "@common/log/logger"
import { createPathAutofill } from "@common/path/autofill"
import { isPathShaped } from "@common/path/complete"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import type {
  ApproveRequest,
  ApproveResult,
  FormField,
  PromptControl,
  PromptRequest,
} from "./commands"

const { NONE } = Astal.WindowAnchor

/** Height the approve/choice command list is allowed to claim inside the card
 *  (logical px). The scroller propagates its natural height, so this is the cap
 *  the widget reports: past it the rows scroll instead of growing the card past
 *  the overlay. GTK4 CSS has no `max-height`, so the bound lives on the
 *  `Gtk.ScrolledWindow` (max-content-height) and not in style.css. */
const COMMANDS_MAX_HEIGHT = 320

/** The control surface, set while Prompt() builds its window; mount.ts hands
 *  it to the request dispatcher (null before Prompt() ran). */
let controlHandle: PromptControl | null = null

export function promptControl(): PromptControl | null {
  return controlHandle
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

type Kind = "ask" | "approve" | "confirm" | "choice" | "form"

export default function Prompt() {
  let win: Astal.Window
  let entry: Gtk.Entry
  let titleLabel: Gtk.Label
  let bodyLabel: Gtk.Label
  let noteLabel: Gtk.Label
  let commandsBox: Gtk.Box
  let commandsScroll: Gtk.ScrolledWindow
  let entryRow: Gtk.Box
  let formBox: Gtk.Box
  let actionsRow: Gtk.Box
  let pending: Pending | null = null
  let kind: Kind = "ask"
  let mode: PromptRequest["mode"] = "text"
  let masked = true
  let validating = false
  let approveAttempts = 0
  let cacheMode = false
  let cacheTrusted = false
  let cacheTimer: ReturnType<typeof setTimeout> | null = null
  let approveReq: ApproveRequest | null = null
  let formFields: Array<{ key: string; entry: Gtk.Entry }> = []
  let choiceRows: Gtk.Widget[] = []
  let choiceSelected = 0

  function clearBox(box: Gtk.Box): void {
    let child = box.get_first_child()
    while (child) {
      const next = child.get_next_sibling()
      box.remove(child)
      child = next
    }
  }

  // ── Inline action glyphs (eye / ✗ / ✓) — the dock's hoverGlyph, extracted
  // to common/glyph/hover-glyph. At rest muted; on hover brightens to white
  // with a soft white radial glow (the user's "glow white" treatment).
  const GLYPH_BOX = 24
  const GLYPH_FS = 13
  const REST: [number, number, number, number] = [0.651, 0.651, 0.651, 1]
  const WHITE: [number, number, number, number] = [1, 1, 1, 1]
  const mkGlyph = (emoji: string | (() => string), onClick: () => void): Gtk.DrawingArea => {
    const g = hoverGlyph({
      emoji,
      box: GLYPH_BOX,
      fontSize: GLYPH_FS,
      rest: REST,
      fontFamily: FONT_FAMILY,
      hover: { colour: WHITE, glow: WHITE, glowAlpha: 0.18 },
      ownHover: true,
      onClick,
    })
    g.widget.add_css_class("prompt-action")
    return g.widget
  }
  // Eye toggles masking: CLOSED (eye-slash) while hidden, open when revealed
  // (dock convention). GTK entry visibility=true means SHOWN — feed it the
  // inverse of `masked` (masked=true = hidden = visibility=false).
  // The action glyphs are REBUILT on every placement (fresh instances +
  // fresh gestures per open): reused instances accumulated a stuck gesture
  // state when the cache-expired flip re-parented them mid-gesture, which
  // killed pointer input for every later window (frozen glyphs).
  let eyeGlyph: Gtk.DrawingArea | null = null
  let xGlyph: Gtk.DrawingArea | null = null
  let checkGlyph: Gtk.DrawingArea | null = null
  const freshGlyphs = (): void => {
    eyeGlyph = mkGlyph(
      () => (masked ? "\uf070" : "\uf06e"),
      () => {
        masked = !masked
        entry.set_property("visibility", !masked)
      },
    )
    xGlyph = mkGlyph("\uf00d", () => cancel())
    checkGlyph = mkGlyph("\uf00c", () => submit())
  }
  /** Optional text beside an action glyph (confirm's okLabel/cancelLabel).
   *  Fresh instance per placement, same reasoning as freshGlyphs. */
  const mkActionLabel = (text: string): Gtk.Label => {
    const l = new Gtk.Label({ label: text })
    l.add_css_class("prompt-action-label")
    return l
  }
  // Transient validation spinner — FRONT of the glyph row, appears ONLY
  // while validating (comes and goes). Non-interactive by construction (the
  // shared spinner sets can_target false): no glow, no clicks. Same emoji as
  // the dock menus' connecting spinner (config.appearance.icons.menuSpinner,
  // U+F0450) and no ease-back (transient — stops dead).
  const spinner = createSpinnerGlyph({
    size: 24,
    fontSize: 13, // same ink size as the action glyphs
    emoji: "\udb81\udc50", // U+F0450 = the dock menus' menuSpinner glyph (󰑐)
    colour: [0.54, 0.71, 0.97, 1], // #8ab5f7 — the launcher/dock accent
    fontFamily: FONT_FAMILY,
    easeBack: false,
  })
  spinner.widget.add_css_class("prompt-spinner")
  spinner.widget.visible = false

  // Path type-ahead for the input dialogs — the SAME inline Tab cycle the
  // launcher's !p/!code bangs use (common/path/autofill over
  // common/path/complete). Active only while a text prompt is OPEN and the
  // text is path-shaped, so masked/number prompts and ordinary words are
  // untouched, and a form field owns its own instance (one cycle per field).
  const pathAutofill = createPathAutofill({
    extract: (t) => (kind === "ask" && mode === "text" && isPathShaped(t) ? t.trim() : null),
  })

  /** Place the action glyphs: inside the entry row (entry + [eye] + ✗ + ✓)
   *  for input modes, or in the bottom actions row (✗ + ✓) otherwise.
   *  Glyphs are single instances — re-parented via append on each open.
   *  `labels` (bottom row only) puts caller-supplied text beside each glyph. */
  function placeActions(
    eye: boolean,
    inEntry: boolean,
    labels?: { ok?: string; cancel?: string },
  ): void {
    clearBox(entryRow)
    clearBox(actionsRow)
    freshGlyphs() // rebuild the action glyphs per placement (stuck-gesture fix)
    // The entry is a REUSED singleton — re-enable it on every placement:
    // a successful validation (or the 3-attempt auth-failed path) leaves
    // setValidatingUI's lock on (success skips setValidatingUI(false)) and
    // finish() never resets it — a locked entry is unfocusable AND
    // untypeable, i.e. the dead-password-field bug. The glyphs
    // are fresh per placement so they never carry the lock.
    entry.sensitive = true
    // Spinner is only ever shown during validation — never linger between
    // windows.
    spinner.widget.visible = false
    if (inEntry) {
      entryRow.append(entry)
      entryRow.append(spinner.widget)
      // @ts-expect-error runtime accepts this argument shape (type-only gap, msg: Argument of type 'DrawingArea | null' is)
      if (eye) entryRow.append(eyeGlyph)
      // @ts-expect-error runtime accepts this argument shape (type-only gap, msg: Argument of type 'DrawingArea | null' is)
      entryRow.append(xGlyph)
      // @ts-expect-error runtime accepts this argument shape (type-only gap, msg: Argument of type 'DrawingArea | null' is)
      entryRow.append(checkGlyph)
      entryRow.visible = true
      actionsRow.visible = false
    } else {
      actionsRow.append(spinner.widget)
      if (labels?.cancel) actionsRow.append(mkActionLabel(labels.cancel))
      // @ts-expect-error runtime accepts this argument shape (type-only gap, msg: Argument of type 'DrawingArea | null' is)
      actionsRow.append(xGlyph)
      if (labels?.ok) actionsRow.append(mkActionLabel(labels.ok))
      // @ts-expect-error runtime accepts this argument shape (type-only gap, msg: Argument of type 'DrawingArea | null' is)
      actionsRow.append(checkGlyph)
      entryRow.visible = false
      actionsRow.visible = true
    }
  }

  /** Shared teardown: drop the pending request, stop the cache watch and
   *  validation spinner, release the entry lock, hide the window. Returns the
   *  pending request so the caller can settle it. */
  function closePrompt(): Pending | null {
    const p = pending
    pending = null
    stopCacheWatch()
    // The path cycle describes the closing window's text — drop it so the
    // next prompt starts clean (its own seed re-arms the cycle).
    pathAutofill.reset()
    // Never leak the validation spinner across windows: stop + hide on close
    // (the success path never runs setValidatingUI(false)).
    spinner.setSpinning(false)
    spinner.widget.visible = false
    win.visible = false
    return p
  }

  function finish(value: unknown): void {
    closePrompt()?.resolve(value)
  }

  function fail(err: Error): void {
    closePrompt()?.reject(err)
  }

  function writePasswordFile(password: string): string {
    const [file, stream] = Gio.File.new_tmp("sudo-approve-pw-XXXXXX")
    // new_tmp returns a GFileIOStream — GJS cannot auto-convert it for a
    // base_stream property; unwrap the GOutputStream first.
    const out = new Gio.DataOutputStream({ base_stream: stream.output_stream })
    out.put_string(password + "\n", null)
    out.close(null)
    file.set_attribute_uint32("unix::mode", 0o600, Gio.FileQueryInfoFlags.NONE, null)
    return file.get_path()!
  }

  /** `sudo -n -v` — is the credential cache still valid? Non-interactive,
   *  no password, no prompt. BOUNDED like the password validation: an 8s
   *  force-exit timeout + slow-log (>2s warns to the journal) — a hung
   *  probe must never leave the window locked with the spinner forever. */
  function sudoCacheValid(): Promise<boolean> {
    return new Promise((resolve) => {
      let proc: Gio.Subprocess | null = null
      const t0 = GLib.get_monotonic_time()
      const timer = setTimeout(() => {
        try {
          proc?.force_exit()
        } catch (e) {
          // The probe process already exited.
          ignore("sudo cache probe force-exit", e)
        }
        console.warn("sudoCacheValid: timed out after 8s")
        resolve(false)
      }, 8000)
      try {
        proc = Gio.Subprocess.new(
          ["sudo", "-n", "-v"],
          Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        )
        proc.wait_check_async(null, (_p: any, res: any) => {
          clearTimeout(timer)
          let ok = false
          try {
            ok = proc!.wait_check_finish(res)
          } catch {
            ok = false
          }
          const ms = (GLib.get_monotonic_time() - t0) / 1000
          if (ms > 2000) console.warn(`sudoCacheValid: slow (${Math.round(ms)}ms)`)
          resolve(ok)
        })
      } catch (e: any) {
        clearTimeout(timer)
        console.warn(`sudoCacheValid: failed: ${e?.message ?? e}`)
        resolve(false)
      }
    })
  }

  /** Cache-valid mode: re-probe every 20s; on expiry flip to the password
   *  UI with a notice (the user asked to be TOLD, not silently re-prompted). */
  function startCacheWatch(): void {
    stopCacheWatch()
    cacheTimer = setTimeout(async () => {
      if (!cacheMode) return
      const valid = await sudoCacheValid()
      if (!valid && cacheMode) {
        enterPasswordMode("Sudo credentials expired — enter your password")
      } else if (cacheMode) {
        startCacheWatch()
      }
    }, 20000)
  }

  function stopCacheWatch(): void {
    if (cacheTimer) {
      clearTimeout(cacheTimer)
      cacheTimer = null
    }
  }

  /** Flip from cache-valid mode to the password UI, with a notice. */
  function enterPasswordMode(note: string): void {
    if (!cacheMode) return
    cacheMode = false
    stopCacheWatch()
    placeActions(true, true)
    entry.set_property("visibility", false)
    entry.set_property("placeholder-text", "Password")
    noteLabel.label = note
    noteLabel.add_css_class("warn")
    noteLabel.visible = true
    entry.grab_focus()
  }

  /** Lock/unlock ALL interaction during validation (the user's request —
   *  sudo's wrong-password delay must not allow typing/clicking/Escape in
   *  the meantime). Bounded: the 8s force-exit timeout always releases.
   *  The spinner appears at the end of the glyph row while locked and
   *  eases away after release (comes and goes, never permanent). */
  function setValidatingUI(on: boolean): void {
    entry.sensitive = !on
    eyeGlyph!.sensitive = !on
    xGlyph!.sensitive = !on
    checkGlyph!.sensitive = !on
    if (on) {
      spinner.widget.visible = true
      spinner.setSpinning(true)
    } else {
      spinner.setSpinning(false)
      spinner.widget.visible = false
    }
  }

  /** Validate the password against PAM WITHOUT closing the window.
   *
   *  PAM directly, NOT `sudo -S -k -v`: sudo re-prompts after a rejection and
   *  the retry reads an already-exhausted stdin — an empty-password
   *  authentication that pam_faillock counts all the same. One rejected entry
   *  therefore cost TWO tally entries against deny=9/unlock_time=0, a lockout
   *  budget shared with login, the lock screen and polkit. AstalAuth's
   *  Pam.authenticate is one-shot: exactly ONE PAM authentication per press, no
   *  subprocess, and the same system-auth stack sudo resolves to
   *  (/etc/pam.d/astal-auth → login → system-login → system-auth), so faillock
   *  counting is unchanged. A wrong password leaves the window open in the red
   *  error state (no flicker); a right one clears the tally (system-auth's
   *  authsucc). The password never leaves this process except into PAM.
   *
   *  GOTCHAS: authenticate_finish THROWS on failure (caught → ok=false). The
   *  typelib is lazy-imported, so a promptd that never validates an approval
   *  never loads it. Every failure path resolves — a hung validation must never
   *  leave the window's `validating` latch set (that locked the UI + keyboard). */
  function validatePassword(password: string): Promise<{ ok: boolean; error: string }> {
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (result: { ok: boolean; error: string }): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(result)
      }
      timer = setTimeout(() => settle({ ok: false, error: "password validation timed out" }), 8000)
      import("gi://AstalAuth")
        .then((m: any) => {
          const Pam = (m.default ?? m).Pam
          Pam.authenticate(password, (_src: any, res: any) => {
            try {
              Pam.authenticate_finish(res)
              settle({ ok: true, error: "" })
            } catch (e: any) {
              settle({ ok: false, error: String(e?.message ?? e) })
            }
          })
        })
        .catch((e: any) =>
          settle({ ok: false, error: `PAM backend unavailable: ${e?.message ?? e}` }),
        )
    })
  }

  function selectChoice(i: number): void {
    choiceRows[choiceSelected]?.remove_css_class("prompt-choice-selected")
    choiceSelected = i
    choiceRows[i]?.add_css_class("prompt-choice-selected")
  }

  async function submit(): Promise<void> {
    if (!pending) return
    switch (kind) {
      case "ask": {
        if (mode === "number" && entry.text.trim() !== "" && Number.isNaN(Number(entry.text))) {
          entry.grab_focus()
          return
        }
        const text = entry.text
        entry.text = ""
        finish(text)
        break
      }
      case "approve": {
        if (validating) return
        const p = pending
        if (cacheMode) {
          // Trusted (caller-probed) cache mode: commit directly — promptd
          // can't re-probe the caller's slot, and any real mid-batch expiry
          // is handled by the extension's cache-miss fallback.
          if (cacheTrusted) {
            stopCacheWatch()
            approveReq = null
            finish({ decision: "approve" } satisfies ApproveResult)
            return
          }
          // Final cache re-check before committing (the user may have sat
          // past the 5-minute window while reading).
          setValidatingUI(true)
          const stillValid = await sudoCacheValid()
          setValidatingUI(false)
          if (pending !== p) return
          if (stillValid) {
            stopCacheWatch()
            approveReq = null
            finish({ decision: "approve" } satisfies ApproveResult)
            return
          }
          enterPasswordMode("Sudo credentials expired — enter your password")
          return
        }
        if (entry.text.length === 0) {
          entry.grab_focus()
          return
        }
        validating = true
        setValidatingUI(true)
        const password = entry.text
        try {
          // Validate WITHOUT closing the window; on success the password is
          // written to the temp file and the window closes once.
          const v = await validatePassword(password)
          if (pending !== p) return // cancelled while validating
          if (v.ok) {
            const passwordFile = writePasswordFile(password)
            entry.text = ""
            approveReq = null
            finish({ decision: "approve", passwordFile } satisfies ApproveResult)
            return
          }
          approveAttempts++
          if (approveAttempts >= 3) {
            approveReq = null
            finish({
              decision: "auth-failed",
              error: v.error,
              attempts: approveAttempts,
            } satisfies ApproveResult)
            return
          }
          // Wrong password: unlock, stay open, red dots until the user edits.
          setValidatingUI(false)
          entry.add_css_class("prompt-entry-error")
          entry.grab_focus()
        } finally {
          validating = false
        }
        break
      }
      case "confirm":
        finish("ok")
        break
      case "choice":
        // @ts-expect-error @girs under-declares `get_label`; gjs provides it at runtime
        finish(choiceRows[choiceSelected]?.get_label?.() ?? "")
        break
      case "form": {
        const out: Record<string, string> = {}
        for (const f of formFields) out[f.key] = f.entry.text
        finish(out)
        break
      }
    }
  }

  function cancel(): void {
    if (!pending) return
    // Full lockout during validation — Escape does nothing
    // until the failure/success returns; the 8s force-exit timeout bounds
    // the lock. This intentionally supersedes the older
    // kill-validator-on-cancel behaviour.
    if (validating) return
    if (kind === "approve") {
      approveReq = null
      finish({ decision: "deny" } satisfies ApproveResult)
      return
    }
    fail(new Error("cancelled"))
  }

  /** Toggle the commands list (approve/choice modes) — the box lives inside
   *  a scroller, so both must follow or the wrapper keeps a phantom size. */
  function setCommandsVisible(v: boolean): void {
    commandsBox.visible = v
    commandsScroll.visible = v
  }

  function renderCommands(commands: ApproveRequest["commands"]): void {
    clearBox(commandsBox)
    for (const c of commands) {
      const row = new Gtk.Label({
        label: GLib.markup_escape_text(c.command, -1),
        use_markup: true,
        xalign: 0,
        wrap: true,
        max_width_chars: 64,
      })
      row.add_css_class("prompt-command")
      commandsBox.append(row)
      if (c.justification) {
        const why = new Gtk.Label({
          // 59 chars + the "Why: " prefix = the same 64-char wrap width as
          // the command lines, so the card never widens for justifications.
          label: "Why: " + GLib.markup_escape_text(c.justification, -1),
          use_markup: true,
          xalign: 0,
          wrap: true,
          max_width_chars: 59,
        })
        why.add_css_class("prompt-justification")
        commandsBox.append(why)
      }
    }
  }

  function renderChoice(options: string[]): void {
    clearBox(commandsBox)
    choiceRows = []
    choiceSelected = 0
    options.forEach((opt, i) => {
      const row = new Gtk.Label({
        label: GLib.markup_escape_text(opt, -1),
        use_markup: true,
        xalign: 0,
        wrap: true,
        max_width_chars: 64,
      })
      row.add_css_class("prompt-choice")
      if (i === 0) row.add_css_class("prompt-choice-selected")
      const click = new Gtk.GestureClick()
      click.connect("pressed", (_g: any, _n: number, _x: number, _y: number) => {
        selectChoice(i)
      })
      row.add_controller(click)
      commandsBox.append(row)
      choiceRows.push(row)
    })
  }

  function renderForm(fields: FormField[]): void {
    clearBox(formBox)
    formFields = []
    for (const f of fields) {
      const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
      })
      row.add_css_class("prompt-form-row")
      const label = new Gtk.Label({ label: f.label, xalign: 0 })
      label.add_css_class("prompt-form-label")
      const field = new Gtk.Box({ hexpand: true })
      field.add_css_class("prompt-form-field")
      const e = new Gtk.Entry({ hexpand: true })
      e.add_css_class("prompt-form-entry")
      // Masked entries show `*` (not the theme's bullet) per user.
      e.set_invisible_char("*")
      if (f.masked) e.set_property("visibility", false)
      e.connect("activate", () => submit())
      // A form field carries a path too (neither zenity --forms nor prompt
      // --form declares a field type), so a path-shaped field entry gets the
      // same Tab cycle. ONE autofill per field: fields are independent, and a
      // shared instance would carry one field's cycle into the next. A masked
      // field never completes, and Tab without a candidate still moves focus.
      const fieldAutofill = f.masked
        ? null
        : createPathAutofill({ extract: (t) => (isPathShaped(t) ? t.trim() : null) })
      const key = new Gtk.EventControllerKey()
      key.connect("key-pressed", (_c: any, keyval: number) => {
        if (!fieldAutofill) return false
        if (keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab) {
          const r = fieldAutofill.onTab(e.get_text(), keyval === Gdk.KEY_ISO_Left_Tab)
          if (r !== null) {
            e.set_text(r.text)
            e.select_region(r.committedLen, r.text.length)
            return true
          }
        } else if (keyval === Gdk.KEY_Right || keyval === Gdk.KEY_KP_Right) {
          const r = fieldAutofill.onAccept(e.get_text())
          if (r !== null) {
            e.set_text(r.text)
            e.set_position(-1)
            return true
          }
        }
        return false
      })
      e.add_controller(key)
      e.connect("changed", () => fieldAutofill?.onInput(e.text))
      field.append(e)
      row.append(label)
      row.append(field)
      formBox.append(row)
      formFields.push({ key: f.key, entry: e })
    }
  }

  function open(k: Kind, title: string, body?: string): Promise<unknown> {
    if (pending) return Promise.reject(new Error("busy: another prompt is open"))
    kind = k
    titleLabel.label = title
    bodyLabel.label = body ?? ""
    bodyLabel.visible = !!body
    win.visible = true
    return new Promise<unknown>((resolve, reject) => {
      pending = { resolve, reject }
    })
  }

  const control: PromptControl = {
    ask(opts) {
      mode = opts.mode
      masked = mode === "masked"
      setCommandsVisible(false)
      formBox.visible = false
      // The note line belongs to approve's cache/expiry flow ONLY — every
      // other kind must clear it, or a cache-mode approval leaks
      // "Sudo credentials are cached" into the next unrelated window.
      noteLabel.visible = false
      placeActions(masked, true)
      // A PATH-SHAPED placeholder is the prompt's declared default — notes'
      // save-as passes the default export path, zenity's --entry-text is an
      // initial value. Seed it as REAL text: the entry then holds a concrete
      // path the completion can build on and Enter accepts unchanged. Any
      // other placeholder stays a hint.
      const declared = opts.placeholder ?? ""
      const seed = masked || !isPathShaped(declared) ? "" : declared
      pathAutofill.reset()
      entry.text = seed
      if (seed !== "") entry.set_position(-1)
      entry.set_property("visibility", !masked)
      entry.set_property("placeholder-text", declared)
      entry.remove_css_class("prompt-entry-error")
      const p = open("ask", opts.title, opts.body)
      entry.grab_focus()
      return p as Promise<string>
    },
    async approve(req) {
      if (pending) return Promise.reject(new Error("busy: another prompt is open"))
      approveReq = req
      masked = true
      approveAttempts = 0
      entry.text = ""
      entry.remove_css_class("prompt-entry-error")
      // Cache decision: prefer the caller's OWN-slot probe (cacheValid) —
      // only the slot the commands actually run in matters. Per-terminal/
      // per-parent-PID timestamps make promptd's local probe misleading (it
      // measures a different slot, so "cached" showed wrong when the caller's
      // slot was really expired). Direct callers fall back to the
      // local probe.
      const trusted = typeof req.cacheValid === "boolean"
      const cached = trusted ? req.cacheValid : await sudoCacheValid()
      if (pending) return Promise.reject(new Error("busy: another prompt is open"))
      cacheMode = cached ?? false
      cacheTrusted = trusted
      setCommandsVisible(true)
      formBox.visible = false
      renderCommands(req.commands)
      if (cacheMode) {
        placeActions(false, false)
        noteLabel.label = "Sudo credentials are cached — no password needed"
        noteLabel.remove_css_class("warn")
        noteLabel.visible = true
        // Agent-signalled cache: promptd can't re-probe the caller's slot,
        // so skip the 20s watch — real expiry is caught by the extension's
        // cache-miss fallback at run time (a password window appears).
        if (!cacheTrusted) startCacheWatch()
      } else {
        placeActions(true, true)
        entry.set_property("visibility", false)
        entry.set_property("placeholder-text", "Password")
        noteLabel.visible = false
        entry.grab_focus()
      }
      return open(
        "approve",
        req.title ?? "Approve as root?",
        req.justification,
      ) as Promise<ApproveResult>
    },
    askConfirm(req) {
      setCommandsVisible(false)
      formBox.visible = false
      noteLabel.visible = false
      placeActions(false, false, { ok: req.okLabel, cancel: req.cancelLabel })
      return open("confirm", req.title, req.body) as Promise<"ok">
    },
    askChoice(req) {
      setCommandsVisible(true)
      formBox.visible = false
      noteLabel.visible = false
      placeActions(false, false)
      renderChoice(req.options)
      return open("choice", req.title, req.body) as Promise<string>
    },
    askForm(req) {
      setCommandsVisible(false)
      formBox.visible = true
      noteLabel.visible = false
      placeActions(false, false)
      renderForm(req.fields)
      const p = open("form", req.title, req.body) as Promise<Record<string, string>>
      formFields[0]?.entry.grab_focus()
      return p
    },
    cancel,
  }

  return (
    <window
      namespace="promptd"
      class="promptd"
      name="promptd"
      layer={Astal.Layer.OVERLAY}
      keymode={Astal.Keymode.EXCLUSIVE}
      anchor={NONE}
      visible={false}
      $={(self) => {
        win = self
        // Control surface for the request dispatcher (mount.ts → setControl).
        controlHandle = control
        // Window-level key backstop: Escape cancels; Return submits for the
        // no-entry kinds (confirm/choice/form). For ask/approve the entry
        // owns Return via its activate signal — the controller skips those
        // so there is no double-submit.
        const winKey = new Gtk.EventControllerKey()
        winKey.connect("key-pressed", (_c: any, keyval: number) => {
          if (keyval === Gdk.KEY_Escape) {
            cancel()
            return true
          }
          if (
            (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) &&
            kind !== "ask" &&
            kind !== "approve"
          ) {
            submit()
            return true
          }
          return false
        })
        self.add_controller(winKey)
        self.connect("realize", () => {
          self.get_surface?.()?.set_opaque_region?.(null)
        })
        // Grab the mode's focus once the window is actually mapped — the
        // handlers' immediate grab_focus races the compositor focus and the
        // entry can end up unfocused (typed text vanishes while the
        // window-level Escape still works). Same race the notes app had.
        self.connect("map", () => {
          if (!self.visible) return
          // Grab only when the entry is actually in the window tree: in
          // cache-mode approve the entry is PARENTLESS (removed by
          // placeActions — there is no password field) and grab_focus on an
          // unparented GtkEntry kills pointer input for the whole window
          // (frozen deny/approve glyphs).
          if ((kind === "ask" || kind === "approve") && entry.get_parent()) entry.grab_focus()
          else if (kind === "form") formFields[0]?.entry?.grab_focus()
        })
      }}
    >
      <box class="card" orientation={Gtk.Orientation.VERTICAL}>
        <label class="prompt-title" label=" " xalign={0} $={(l) => (titleLabel = l)} />
        <label
          class="prompt-body"
          label=" "
          xalign={0}
          wrap
          max_width_chars={64}
          $={(l) => (bodyLabel = l)}
        />
        <label
          class="prompt-note"
          label=""
          xalign={0}
          wrap
          max_width_chars={64}
          visible={false}
          $={(l) => (noteLabel = l)}
        />
        <scrolledwindow
          $={(ref) => {
            commandsScroll = ref
            ref.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            ref.set_propagate_natural_height(true)
            ref.set_max_content_height(COMMANDS_MAX_HEIGHT)
          }}
          class="prompt-commands-scroll"
          visible={false}
        >
          <box
            class="prompt-commands"
            orientation={Gtk.Orientation.VERTICAL}
            $={(b) => (commandsBox = b)}
          />
        </scrolledwindow>
        <box
          class="prompt-form"
          orientation={Gtk.Orientation.VERTICAL}
          $={(b) => (formBox = b)}
          visible={false}
        />
        <box class="prompt-entry-row" $={(b) => (entryRow = b)}>
          <entry
            class="prompt-entry"
            hexpand
            $={(e) => {
              entry = e
              // Masked entries show `*` (not the theme's bullet) per user.
              e.set_invisible_char("*")
              // Entry-level Escape (the focused widget consumes it so it
              // never leaks to the window behind the prompt), and the path
              // autofill keys: Tab/Shift+Tab cycle the completion candidates,
              // Right Arrow locks the shown ghost in as real text (a dir
              // descends). A key the cycle cannot answer falls through to the
              // default entry behaviour.
              const key = new Gtk.EventControllerKey()
              key.connect("key-pressed", (_c: any, keyval: number) => {
                if (keyval === Gdk.KEY_Escape) {
                  cancel()
                  return true
                }
                if (keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab) {
                  const r = pathAutofill.onTab(e.get_text(), keyval === Gdk.KEY_ISO_Left_Tab)
                  if (r !== null) {
                    e.set_text(r.text)
                    e.select_region(r.committedLen, r.text.length)
                    return true
                  }
                  return false
                }
                if (keyval === Gdk.KEY_Right || keyval === Gdk.KEY_KP_Right) {
                  const r = pathAutofill.onAccept(e.get_text())
                  if (r !== null) {
                    e.set_text(r.text)
                    e.set_position(-1)
                    return true
                  }
                }
                return false
              })
              e.add_controller(key)
              e.connect("activate", () => submit())
              // Red error state clears the moment the user edits.
              e.connect("changed", () => {
                e.remove_css_class("prompt-entry-error")
                pathAutofill.onInput(e.text)
              })
            }}
          />
        </box>
        <box
          class="prompt-actions"
          halign={Gtk.Align.END}
          visible={false}
          $={(b) => (actionsRow = b)}
        />
      </box>
    </window>
  )
}
