# AGENTS.md — polkit

Part of the TINSHELL multi-app home. **READ `~/dev/tinshell/AGENTS.md` FIRST** —
the multi-app rules (one app = one explicitly-named bus, launch path via
`tinshell-host.sh` (the universal bundle), `ags -i <app> request` addressing, onboarding, common
modules) apply to everything in this file. This file is the app-specific
spec; the root file is the cross-app contract.

`polkit` is the multi-app home's polkit AuthenticationAgent: a long-running
session service that makes `pkexec` / GParted / Flatpak install-time /
`systemctl` user-session authorizations work again by routing polkitd's
`BeginAuthentication` calls into a themed promptd `input` dialog (masked
password) and running the polkit-127 PAM handshake. It is NOT part of the
shell surface (it has no UI of its own) and NOT part of promptd (promptd is
the _generic_ dialog service; polkit is a specific auth protocol — coupling
them would bloat a security-critical path).

## Identity

|                |                                                                         |
| -------------- | ----------------------------------------------------------------------- |
| Instance / bus | `polkit` (`io.Astal.polkit`)                                            |
| Unit           | `tinshell-polkit.service` (WantedBy=graphical-session.target)                |
| Windows        | **NONE** — all UI lives in promptd (blur layerrule `promptd` covers it) |
| Launch path    | `tinshell-host.sh start polkit --foreground` (systemd/tinshell-polkit.service ExecStart; this app has no `run.sh`) |
| Log            | `/tmp/tinshell-polkit-debug.log` (fileSink — systemd launch has no tty)      |

## Protocol (polkit 127)

- **Authority**: `org.freedesktop.PolicyKit1` / `org.freedesktop.PolicyKit1/Authority`
  on the **system bus**: `RegisterAuthenticationAgent (sa{sv})ss`,
  `UnregisterAuthenticationAgent (sa{sv})s`.
- **Agent object**: `org.freedesktop.PolicyKit1.AuthenticationAgent` exported at
  `/org/freedesktop/PolicyKit1/AuthenticationAgent` ON THE SAME SYSTEM-BUS
  connection used for registration (polkitd records caller bus name + path;
  it cannot reach a session-bus name). Methods: `BeginAuthentication`
  `(s s s a{ss} s a(sa{sv}))` (action_id, message, icon_name, details, cookie,
  identities) and `CancelAuthentication (s)`.
- **Subject kinds changed in polkit 127**: `"unix-session"` with details key
  `"session-id"` (the old `"session"` kind is REJECTED with "Unknown subject
  of kind"). `unix-process` uses pid/uid/start-time (or pidfd/uid),
  `system-bus-name` uses name.
- **Identity** `(sa{sv})`: kind `"unix-user"`, details `{ uid: u }` — picked
  from the `identities` array (password only; TOTP/fingerprint out of scope).
- **polkit 127 removed the agent→authority secret response.** The
  `AuthenticationAgentResponse`/`2`/`3` methods now require a ROOT caller
  ("Only uid 0 may invoke this method") and carry no password. PAM happens in
  `polkit-agent-helper-1`, which runs as root via the socket-activated
  service `/run/polkit/agent-helper.socket` (the setuid helper is NOT
  installed on this machine — not setuid, so the socket is the only path).
  The agent runs the conversation over the socket:
  - agent → helper: `<user>\n` then `<cookie>\n`
  - helper → agent: `PAM_PROMPT_ECHO_OFF <escaped-prompt>\n` (also
    `PAM_PROMPT_ECHO_ON` / `PAM_ERROR_MSG` / `PAM_TEXT_INFO`)
  - agent → helper: `<password>\n`
  - helper → agent: `SUCCESS\n` or `FAILURE\n`, then the helper (as root)
    calls `AuthenticationAgentResponse3(cookie, identity, subject)` itself.
  - The helper reads the peer uid/pidfd from the socket; the agent must stay
    alive for the conversation (pidfd fails if the caller exits).
- **Cancellation = close the socket without a password**: the helper's PAM
  conversation fails and polkitd ends the auth session deterministically.
  Empty password (cancel / promptd error / timeout) = same via `password: ""`.
- **Promptd call**: `tinshell-route promptd "input <b64>"` with payload
  `{ mode: "masked", title: icon_name || "Authentication required", body:
message || action_id, placeholder: "Password" }`. The base64 is built in
  JS (`GLib.base64_encode`) — one argv token, so no shell quoting is
  involved. The ROUTER, never `ags -i promptd`: in production promptd is a
  LAZY member of the SHELL instance and no `promptd` bus name exists, so a
  direct instance call answers `instance "promptd" is not runnning` and the
  dialog never opens (the notes save-as / files Ctrl+N rule). `tinshell-route`
  probes the live instances shell-first and forwards the dialog's reply on
  stdout. `error:`-prefixed output / empty stdout / exit -2 (timeout) →
  empty-password path. The promptd window needs no focus handling from this
  agent: promptd grabs its entry on the window's `map` signal and holds
  keymode EXCLUSIVE while visible.
- **BeginAuthentication reply is HELD until the outcome is known.** polkitd's
  challenge callback fires on this reply (`authentication_agent_begin_cb`:
  `gained_authorization = session->is_authenticated`, which only the root
  helper's response sets), so replying immediately ends the challenge as
  "FAILED to authenticate" — pkexec returns unauthorized in ~30ms while the
  dialog stays orphaned. The reference agent library keeps the invocation
  pending for the same reason. Reply exactly once: `return_value(null)` when
  the helper conversation ended SUCCESS, else a
  `org.freedesktop.PolicyKit1.Error.Cancelled` (dismissed: cancel, timeout,
  promptd error, no unix-user identity) or `...Error.Failed` (PAM failure)
  D-Bus error — CancelAuthentication replies too.

## Modules

- `app.ts` — `createApp({ instanceName: "polkit", css: "", main: startAgent })`.
  No windows; `css: ""` is deliberate (a falsy css skips apply_css).
- `agent.ts` — core: system-bus connection (single, shared), agent-object
  export (5-arg `register_object`), Begin/Cancel handling, promptd
  subprocess (local helper — needs the proc handle to `force_exit` on
  cancel/concurrent-begin; `runCb` can't, and it spawns through the router),
  the socket conversation (Gio.SocketClient + DataInputStream line loop),
  session resolution (logind: own pid's session, else the user's display
  session), the held BeginAuthentication invocation, register/unregister with
  one retry.
- `commands.ts` — request namespace: `polkit status` / `polkit register` /
  `polkit unregister` / `polkit debug ping`.

## State machine (per cookie)

- `BeginAuthentication` → resolve unix-user identity (uid) → spawn promptd
  `input` (the invocation is held) → on password: resolve username
  (`id -un <uid>`), connect the helper socket, write user+cookie, answer the
  PAM prompt, watch for SUCCESS/FAILURE, then reply the held invocation.
  On cancel/error/timeout: same with an empty password, dismissed reply.
- `CancelAuthentication(cookie)` → force-exit the promptd subprocess, cancel
  - close the helper conversation, `tinshell-route promptd close` to dismiss the
    window, clear state.
- **Concurrent BeginAuthentication** (two `pkexec`) → fail the OLD cookie
  fast (kill prompt + helper, empty-password conversation — promptd rejects a
  second window with `error: busy: another prompt is open`), then serve the
  new one.
- `finalDone` flag per prompt makes every callback path idempotent (a late
  communicate callback after `force_exit` is a no-op; the conversation
  timeout closes the socket).
- No unix-user identity → dismiss the dialog and let polkitd expire the
  session (nothing to auth).

## Integration

- Root `package.json` workspaces, `setup.sh` (unit install via the apps.json
  `unit` field + the hyprpolkitagent disable step + summary), root `AGENTS.md`
  Apps table — all list `polkit`.
- `hyprpolkitagent.service` (packaged unit) is DISABLED by
  setup.sh — two agents must never race the (subject, locale) registration
  slot (only ONE agent per subject+locale; re-registration replaces).
  hyprpolkitagent resolves its session the same way (a session-less
  `user@.service` unit reading logind's `User.Display`); `resolveSessionId()`
  mirrors that order.
- hyprland.lua: nothing (no window, no keybind, no layerrule — promptd's
  window is already blurred). Unit `WantedBy=graphical-session.target` covers
  startup; `Wants=tinshell-promptd.service` + the unit's own `tinshell-bus-wait.sh
polkit` (register-race guard for OUR bus name — NOT promptd's; the wait
  script waits for a name to be FREE, so pointing it at the resident promptd
  name would time out) guarantee promptd is up before any prompt.

## Gotchas

- `Gio.bus_get` async is callback-only in gjs — we use `bus_get_sync` once.
- `register_object` takes 5 args (method closure + nullable property closures).
- **gjs tuple nesting**: pre-built `GLib.Variant` children inside another
  Variant throw "Invalid GVariant signature for type TUPLE" — pass JS
  arrays/objects (values as explicit `GLib.Variant`), as in
  `("((sa{sv})ss)", [subjectArgs, locale, path])`.
- `AsyncReadyCallback` sources are typed `T | null` — annotate callback
  params `| null` or inference breaks.
- `read_line_async` lives on `Gio.DataInputStream`, not `BufferedInputStream`.
- **The subject session must be the session polkitd derives for THIS
  process** — `RegisterAuthenticationAgent` rejects any other with "Passed
  session and the session the caller is in differs. They must be equal for
  now." polkitd derives it from the caller's pidfd/cgroup
  (`sd_pid_get_session`) and, when the process has NO session scope, from the
  caller's uid → the user's ACTIVE graphical session (`sd_uid_get_display`).
  A systemd user service — the dev island unit AND the production shell,
  which is spawned by `tinshell-shell.service` — lives in `user@.service`, so the
  display fallback is the one that answers. `resolveSessionId()` mirrors that
  order: `loginctl show-session self -p Id --value`, else `loginctl show-user
  <user> -p Display --value`. `XDG_SESSION_ID` is NOT in the user-manager
  env (and is not what polkitd reads anyway), and the first row of `loginctl
  list-sessions` is the lingering manager's `manager` session — never name
  that session.
- Never log passwords. Only cookie ids + outcomes.
- **The identity `uid` arrives WRAPPED.** `parameters.deep_unpack()` leaves an
  `a{sv}` value as a `GLib.Variant` (variants are not unpacked recursively),
  so `(identities[0][1] as {uid: number}).uid` is a Variant, not a number —
  `id -un` then gets `[object variant of type "u"]` and every auth fails before
  the helper is even dialled. Unwrap it (`identityUid()`), the way the
  `a(sa{sv})` identity itself is passed as a plain JS array.
- **Never reply to BeginAuthentication before the outcome.** An eager
  `return_value(null)` makes polkitd conclude the challenge immediately (see
  Protocol) — the symptom is a pkexec that fails in milliseconds while the
  promptd dialog stays open.
- promptd `input` returns the password on STDOUT with exit code 0 even on
  cancel — check the `error:` prefix, never the exit code.
- The helper writes prompts to stdout with `g_strescape` escaping — we only
  match prefixes, never parse the prompt text.

## Testing

1. `systemctl --user start tinshell-shell` (production) or `ags -i polkit request "polkit status"`
   (island dev; the island starts via `tinshell-polkit.service` — `systemctl --user start tinshell-polkit`)
   → `agent registered (subject=unix-session:4, locale=…)` — the id must be
   the ACTIVE graphical session (`loginctl show-user <user> -p Display
   --value`), not the manager session.
2. `pkexec /usr/bin/whoami` → themed masked prompt; correct password → root;
   wrong → auth fails (the prompt stays open, promptd's own wrong-password
   handling is NOT in this path — a re-run prompts again); Escape / a
   `promptd close` → `error: cancelled` → pkexec exits 126 `Request dismissed`
   (a PAM failure reports 127 `Not authorized`).
3. `busctl --system tree | grep AuthenticationAgent` shows the agent object
   under the app's unique system-bus name; `pkaction` lists actions.
4. Crash test: `systemctl --user restart tinshell-polkit` → still registered
   (re-register on boot path).
5. `zenity --file-selection` still opens tinshell-portal (no regression).
