# AGENTS.md — promptd

Part of the TINSHELL multi-app home. **READ `~/dev/tinshell/AGENTS.md` FIRST** —
the multi-app rules (one app = one explicitly-named bus, launch path via
`tinshell-host.sh` (the universal bundle), `ags -i <app> request` addressing, onboarding, common
modules) apply to everything in this file. This file is the app-specific
spec; the root file is the cross-app contract.

`promptd` is the multi-app home's prompt/input service: ONE long-running TINSHELL
app that owns centred modal input windows and serves any process that can
call `ags -i <instance> request "promptd ..."` (clients route shell-first: `ags -i shell
request "promptd ping"`, falling back to the dev island `ags -i promptd request
"promptd ping"`). It is the sanctioned UI for:

- **SUDO_ASKPASS** (`askpass`) — the bridge `~/.local/bin/sudo-approve-askpass`
  forwards sudo's prompt; the password flows window → CLI stdout → sudo and
  never enters pi. Falls back to yad when promptd is unreachable.
- **The pi sudo_approve tool** (`approve`) — command list + justifications +
  masked password in ONE window. The password is written to a 0600 temp file
  (only its path is returned); pi consumes it via a cat-askpass script and
  deletes the file. Falls back to the TUI dialog + yad path when promptd is
  unreachable.
- **Generic scriptable input** (`input`) — masked/text/number prompts.

## Identity

| | |
| --- | --- |
| Instance / bus | in shell: inside the shell instance (`io.Astal.shell`); dev island: `promptd` (`io.Astal.promptd`) |
| Unit | `tinshell-shell.service` (production); `tinshell-promptd.service` (DEV only) |
| Window namespace | `promptd` (Hyprland blur layerrule in hyprland.lua) |
| Launch path | `tinshell-host.sh start promptd --foreground` (systemd/tinshell-promptd.service ExecStart; shell member in production; this app has no `run.sh`) |

## Request API

All payloads are base64-encoded (the request CLI tokenizer splits argv on
whitespace). Responses come back on the CLI's stdout; `error: <msg>` is the
failure convention (exit code stays 0 — callers must check the prefix, not
the exit code).

Every command token is PREFIXED with `promptd` in BOTH modes (the registry is
process-global in shell): `ags -i shell request "promptd askpass <b64>"`, dev
island `ags -i promptd request "promptd askpass <b64>"`. The table below
lists the token after the prefix.

| Command | Payload (b64 of) | Returns |
| --- | --- | --- |
| `ping` | — | `pong` (health check for fallback logic) |
| `askpass <prompt-b64>` | sudo's prompt string | password, or `error: cancelled` |
| `approve <payload-b64>` | `{title?, commands:[{command, justification?}], justification?, error?, cacheValid?}` | `{decision:"approve", passwordFile}` or `{decision:"deny"}` |
| `input <payload-b64>` | `{mode: masked\|text\|number, title, body?, placeholder?}` | entered text, or `error: cancelled` |
| `confirm <payload-b64>` | `{title, body?, okLabel?, cancelLabel?}` | `ok`, or `error: cancelled` |
| `choice <payload-b64>` | `{title, body?, options: string[]}` | chosen option, or `error: cancelled` |
| `form <payload-b64>` | `{title, body?, fields:[{key, label, masked?}]}` | JSON `{key: value}`, or `error: cancelled` |
| `config get\|set\|reload\|all` | — | per launcher/dock convention |
| `close` | — | dismisses the open prompt (debug/testing aid) |

## Window behaviour

- ONE window, created at startup, shown/hidden per request (launcher pattern).
- **Entry focus is grabbed on the window's `map` signal:** the
  handlers' immediate `grab_focus()` after `win.visible = true` races the
  compositor focus — the entry can end up unfocused, so typed text vanishes
  while the window-level Escape still works (looks like "can't interact with
  the popup"). Same race the notes app had; ask/approve grab the entry,
  form grabs the first field. The grab is guarded with `entry.get_parent()`:
  in cache-mode approve the entry is PARENTLESS (removed by placeActions —
  no password field) and grabbing focus on it poisons pointer input for the
  whole window. If a prompt ever misbehaves: restart `tinshell-promptd` — the
  window accumulates broken state across many show/hide cycles.
- **Action glyphs (eye/✗/✓) are REBUILT on every placement (freshGlyphs() in
  placeActions):** the action glyphs must be fresh Gtk.DrawingArea
  instances + fresh gestures per open, NEVER reused module-level singletons.
  Root cause of the frozen-glyph bug (cache-mode sudo_approve): the cache-
  expired flip re-parented the reused glyphs mid-gesture (press still held)
  leaving a stuck gesture state on the shared widgets — pointer input died
  for EVERY later window (no hover glow, no clicks; keyboard still worked).
  In isolation: window #1 works, window #2+ dead; fresh glyphs per placement
  fixes it. The window itself is still reused (launcher
  pattern), only the glyph widgets are rebuilt.
- Centred overlay layer; keymode EXCLUSIVE while visible — a modal prompt
  holds the keyboard until answered. NO auto-hide on focus loss (deliberate:
  answering or cancelling is the only exit).
- Return submits; Escape cancels; buttons for both. For ask/approve the entry
  owns Return (activate); for confirm/choice/form the window controller does.
- **Path type-ahead in text prompts.** The `input` dialog's entry (and every
  unmasked `form` field) runs the SAME inline Tab-cycling autofill the
  launcher's `!p`/`!code` bangs use — `createPathAutofill`
  (`common/path/autofill.ts`) over `common/path/complete.ts`. It is active only
  while a text prompt is open AND the entry text is path-shaped
  (`isPathShaped`: `/`, `~`, `./`, `../`), so masked/number prompts and
  ordinary words are untouched. Tab fills the next completion into a SELECTED
  ghost half, Shift+Tab cycles back, Right Arrow locks the ghost in as real
  text (a directory descends), and Enter submits the entry text as shown — a
  completed path. A BASENAME pattern (`*`/`?`) is answered by `globPath`: Tab
  previews that directory's matches newest-first and Enter/Right writes the
  chosen concrete path into the field; the pattern is only a way to reach a
  name — there is deliberately NO rename or replace action behind it. The cycle
  resets on every prompt close, so no window inherits the previous one's
  candidates. Form fields each own an autofill instance (fields are
  independent), and Tab without a candidate still moves focus to the next
  field.
- **A path-shaped `placeholder` SEEDS the entry.** notes' save-as passes the
  default export path and zenity's `--entry-text` is an initial value, so a
  path-shaped placeholder in text mode is written into the entry as real text
  (caret at the end): the completion then builds on that default's directory
  instead of an empty field, and Enter accepts it unchanged. Any other
  placeholder stays a hint (`placeholder-text`), and masked/number modes never
  seed.
- `confirm` accepts optional `okLabel`/`cancelLabel` — rendered as plain text
  (`.prompt-action-label`) immediately left of the ✓ / ✗ glyph it names, so
  zenity/yad wrappers can surface real verbs ("Delete" / "Keep") instead of
  bare glyphs. Omitted = glyphs only, the original look. The labels are NOT
  buttons: the glyph stays the click target.
- **The note line is approve-ONLY and every other kind must clear it**
  (`noteLabel.visible = false` in ask/askConfirm/askChoice/askForm). It was
  set by cache-mode approve and never reset, so after ONE cached
  `sudo_approve` the string "Sudo credentials are cached — no password
  needed" leaked into the next unrelated confirm/choice/form/ask window. Any
  new kind added to the control surface must reset it too.
- approve/choice render lists (commands with justifications / options) scroll
  inside a `Gtk.ScrolledWindow` capped at `COMMANDS_MAX_HEIGHT` (320 px) — past
  the cap the rows scroll rather than growing the card. choice selects on
  click (highlighted), OK/Return confirms.
- Approve requires a non-empty password; number mode validates on submit.
- Wrong-password handling (approve mode): the password is validated INSIDE
  promptd (`sudo -S -v`, password via stdin, never leaves the process) on
  submit — the window NEVER closes/reopens on a wrong password. Wrong →
  entry text + mask dots go red (class `prompt-entry-error`, clears on
  edit), entry focused, count++; max 3 attempts, then the window closes
  once with `{decision:"auth-failed", error, attempts}` and the caller
  (sudo_approve) sends a critical notify-send.
- During validation the window is FULLY LOCKED (entry + glyphs insensitive,
  Escape ignored; dimmed via :disabled css) and a spinner glyph (the dock's
  shared spinner glyph (`common/glyph/spinner`)) appears at the START
  of the glyph row — non-interactive, comes and goes (eases away ~350ms
  after release). Bounded by the 8s force-exit timeout.
  GOTCHA: the spinner state LEAKS across windows — the successful-validation
  path closes the window without setValidatingUI(false); finish/fail now stop
  - hide it and placeActions resets it on every placement (a leaked
  still-spinning spinner appeared in the next prompt).
  GOTCHA: the VALIDATION LOCK leaks the same way and kills the next window's
  password field: setValidatingUI(true) sets entry.sensitive=false;
  the success + 3-attempt-auth-failed paths skip setValidatingUI(false) and
  finish/fail never reset it — the singleton entry stays DISABLED, so the
  next password-mode window shows an unfocusable, untypeable field while
  window-level Escape still works. Fix: entry.sensitive=true in finish/fail
  AND in placeActions (every placement).
- CACHE MODE (approve): the caller (pi's
  sudo_approve) probes ITS OWN sudo slot (`sudo -n -v` in the agent process)
  and passes `cacheValid` in the payload — promptd trusts it. sudo caches
  credentials PER-TERMINAL (or per-parent-PID when there's no tty; see
  `timestamp_type`), so promptd's local probe measures a DIFFERENT slot and
  its "cached" message was WRONG (showed cached when the agent's slot was
  expired → a password was needed). promptd's local
  `sudo -n -v` probe remains only as the fallback for direct callers (no
  cacheValid in the payload).
  - cacheValid:true → NO password field, muted note "Sudo credentials are
    cached — no password needed"; NO 20s watch, ✓ commits directly (promptd
    can't re-probe the caller's slot; real mid-batch expiry is caught by the
    extension's cache-miss fallback — a password window appears at run time).
  - cacheValid:false → password field, no 20s watch (the caller's probe is
    authoritative for its own slot).
  - No `cacheValid` (a direct caller) → promptd's local `sudo -n -v` probe
    decides: cached → the muted note, the 20s watch and the final ✓ re-probe;
    not cached → password field.
  - Validation now runs `sudo -S -k -v` (-k = ignore cached credentials), so
    a warm promptd slot cannot silently accept a WRONG password — `-k` makes
    validation independent of any cached credential, so cache mode is a UX
    convenience only. Cache approvals resolve `{decision:"approve"}`
    (no passwordFile); the extension runs plain `sudo -n`.
- form renders one entry row per field; masked fields hide input; Return in
  any field submits the whole form.

## Password hygiene

- approve writes the password to `Gio.File.new_tmp` (0600 forced via
  `unix::mode`), returns only the path, appends `\n` for the askpass protocol.
  GOTCHA: `new_tmp` returns a GFileIOStream — GJS cannot auto-convert it for a
  `base_stream` property; unwrap `stream.output_stream` first (otherwise
  put_string throws TypeError, the window stays open and the password path
  is dead).
- The caller owns cleanup: pi's sudo_approve deletes the file in `finally`.
- askpass returns the password on stdout per the sudo askpass protocol — that
  is the bridge's job, not pi's.

## Theme

- The entry right-click context menu (GTK's default edit menu — Cut/Copy/
  Paste/Delete/Select All + Input Methods/Insert Emoji) is CSS-themed in
  `style.css`, appearance-only: the menu popover is a subsurface of the
  promptd window, so the `promptd` blur layerrule frosts it like the card;
  the bg matches `.card` (`--tinshell-panel` + `--tinshell-panel-radius`), items are
  `modelbutton` rows (the GTK4 popover paints its panel on the `contents`
  child node — the outer `popover` node is transparent) in `--tinshell-ink` with
  the `.prompt-choice:hover` highlight, muted disabled items, subtle
  separators. The default menu is kept, not replaced.
- **The command list's height cap is a widget property, not CSS.** GTK4 CSS has
  no `max-height` (the declaration is inert and GTK logs a CSS CRITICAL at every
  start); the approve/choice scroller bounds itself through
  `max-content-height` (`COMMANDS_MAX_HEIGHT` in `Prompt.tsx`, with
  `propagate-natural-height` on), so the rows scroll once the child asks for
  more than the cap instead of growing the card past the overlay.

## Config

`config.defaults.json` + `config.schema.json` + thin `config.ts` over the
shared loader via `createAppStore` (same shape as launcher/dock). Live file: `config.json` (created
on first run). The schema declares NO keys — nothing in promptd reads a config
value (the approve/choice list height is the `max-content-height` cap above,
not a config key), so `additionalProperties: false` rejects every config write.

## Clients

- `~/.local/bin/prompt` — yad-compatible dialog CLI (--entry/--hide-text/
  --question/--list/--form/--title/--text) routed through promptd; execs real
  yad with the original args when promptd is unreachable (drop-in fallback).
- `~/.local/bin/zenity` — zenity-compatible CLI, sibling of
  `prompt`, shadows `/usr/bin/zenity` on PATH. Maps --question (okLabel/
  cancelLabel honoured), --entry/--password/--hide-text/--entry-text, --list
  (single --column only), --forms (--add-entry/--add-password, joined by
  --separator) and --info/--warning/--error. Anything promptd cannot
  represent faithfully — --file-selection, --progress, --scale, --calendar,
  --notification, --text-info, --extra-button, --timeout, multi-column lists
  — execs the REAL binary with the original argv, as does an unreachable
  promptd. A user dismiss exits 1 and never spawns a second dialog.
- `~/.local/bin/pinentry-promptd` — assuan pinentry for gpg-agent
  (gpg-agent.conf pinentry-program); probes promptd at startup, execs
  pinentry-gnome3 when down. GETPIN data is percent-encoded; SET* values
  percent-decoded. Gotcha: never use bash herestrings when passing passwords
  to encoders (trailing \n becomes %0A in the passphrase).
- `~/.local/bin/ssh-askpass-promptd` — SSH_ASKPASS bridge (same contract as
  sudo askpass; SSH_ASKPASS + SSH_ASKPASS_REQUIRE=force in environment.d and
  ~/.zshenv).
- `~/.local/bin/sudo-approve-askpass` — SUDO_ASKPASS bridge (promptd first,
  yad fallback; `error: cancelled` never re-prompts).
- The two text clients post `mode: "text"`, so a path typed through
  `prompt --entry` or `zenity --entry` gets the input dialog's path type-ahead
  with no client change. `--file-selection` never reaches promptd (that flag
  execs the real zenity → the portal chooser).

## Lifecycle

- `systemctl --user restart tinshell-promptd`; unit = the standard TINSHELL template:
  bus-name wait (ExecStartPre), Restart=on-failure, StartLimitIntervalSec=0,
  EGL + VK ICD env pinned to Mesa/AMD.
- Not autostarted from hyprland.lua (per-app dev units are never autostarted
  there): in production promptd is an eager member of the shell, and the dev
  unit `tinshell-promptd.service` is started explicitly when running islands.
- If promptd dies mid-prompt: the window dies with it, the request fails, and
  callers fall back (yad / TUI dialog). The unit revives the app.
