# AGENTS.md — TINSHELL Greeter

Terminal session context injector. Point a fresh agent here.

Part of the TINSHELL multi-app home. **READ the repository root `AGENTS.md` FIRST** — the
multi-app rules (one app = one explicitly-named bus, launch path via
`tinshell-host.sh` (the universal bundle), `ags -i <app> request` addressing, onboarding, common
modules) apply to everything in this file.

## SPEC MAINTENANCE

- **The spec in this file is the source of truth.** When code changes alter
  behaviour, visuals, architecture, or the deploy flow, update this file as
  part of the change. If the spec and code disagree, the spec is wrong until
  fixed.
- **Give a summary of spec changes** after each code edit that affects the
  spec.

---

## What the user sees

At boot, VT 1 shows a fullscreen TINSHELL login screen: a centred login column
with NO card panel — the clock and the entry fields sit directly on the
compositor's frost, and each field carries its own scrim well
(`.greeter-field`). The column holds a large clock, username + password
fields, a session picker row
(Hyprland / Plasma (Wayland) / Plasma (X11), hyprland-uwsm hidden because
uwsm is not installed), and a submit glyph in the password field (no separate
sign-in button). A dock strip rides BOTTOM-CENTER on the same
surface (login AND lock — see "Greeter dock subset" below). Styling mirrors
the desktop (same `common/shell/theme.css` base, same blur/frost parameters).

Wrong password → the greetd error shows in red and the password field keeps its
text; the card stays up for a retry. Correct credentials → the card shows
"Logging in…", the greeter compositor tree is SIGKILLed by
`greeter-handoff.sh` (spawned by the app), and the last rendered frame
(wallpaper + Logging in…) freezes on the framebuffer until the user session's
Hyprland paints over it — no blank screen, no blinking cursor, no default
background. The real session starts on the same VT (greetd starts it ~1s
after the greeter dies; the local greetd build patches the 5s alarm down and
skips the tty text-mode+clear).

The SAME app is also the in-session LOCK screen: `TINSHELL_GREETER_MODE=lock` runs
a second bundle (`dist/tinshell-lock.sh`, launched by hypridle's `lock_cmd`) that
acquires a compositor-enforced lock (ext-session-lock-v1 via gi://Gtk4SessionLock)
and unlocks via PAM (gi://AstalAuth). hyprlock is retired (installed, dormant).
Both login and lock cards sit on the user's wallpaper (awww daemon): the lock
reads the live image at lock time; the login reads a synced copy at
`/etc/greetd/tinshell-greeter/wallpaper.png`.

**Both bundles carry GPU-WAKE PINS, because neither is launched by
`tinshell-host.sh`.** The shell and every island inherit the env union of
`common/shell/tinshell-host.sh` — Mesa-only `__EGL_VENDOR_LIBRARY_FILENAMES`, the
Radeon `VK_ICD_FILENAMES` and `GSK_RENDERER=gl` — and that set is what keeps a
GTK startup from enumerating the NVIDIA EGL/Vulkan vendor stacks, opening
`/dev/nvidia*` and holding the dGPU runtime-active for its autosuspend window
(~20s) on a screen with no GPU work. greetd and hypridle exec these bundles
directly, so `build.sh` and `build-lock.sh` inject the same three exports into
the generated `dist/*.sh`. A Performance-applet temperature read is the user-
visible tell: it colours the reading by the dGPU's `power/runtime_status`, so a
lock screen that woke the dGPU paints red for those ~20s while `nvidia-smi`
shows nothing running. Rebuild the bundle — never hand-run it under a bare
`gjs` — or the wake returns.

**Both bundles COMPILE the dock config's key names in, and the pre-login deploy
carries its own copy of the dock trio — so a dock config KEY RENAME must be
followed by a rebuild + redeploy in the same change:** `build.sh` +
`build-lock.sh` (new keys inside the bundles) plus `install.sh`, which deploys
AND refreshes the mirror of the live dock config (`TINSHELL_DOCK_CONFIG`, else
the invoking user's home — see the deploy flow bullet). No hand copy is needed,
and none exists to go stale.
A stale bundle reading a renamed key throws `<key> is undefined` while the strip
mounts; the lock then logs `[lock] applet strip: … composing without the strip`
and paints no applets (the card and the wallpaper still map — lock/surface.ts
composes without the strip rather than dropping the whole backdrop). The lock
bundle reads the LIVE dock config (`source=` in its `[greeter-dock]` log line,
the best signal for which copy is in play); the pre-login greeter reads
`/etc/greetd/tinshell-greeter/dock`.

**A SHARED-MODULE change reaches the login screen only after a rebuild + a
redeploy.** `dist/*.sh` and `/etc/greetd/tinshell-greeter.sh` are SNAPSHOTS of
`common/` + `apps/greeter/` inlined at build time: editing
`common/glyph/*`, `common/applets/*` or any other inlined module changes
nothing on the pre-login screen until `build.sh` runs AND
`sudo ./install.sh` deploys the new bundle (the lock bundle needs only
`build-lock.sh` — hypridle execs `dist/tinshell-lock.sh` directly). A stale
cairo-drawing module fails SILENTLY: an exception raised inside a
`Gtk.DrawingArea` draw func aborts that frame's paint, so a mistyped cairo call
is not a crash but a glyph that DISAPPEARS — the cairo stop API is
`addColorStopRGBA`, which the Canadian-spelling rule must not rename.

Which snapshot is in play is no longer a matter of inference: every build
stamps the bundle with the sources it was built from (`build-stamp.json` beside
it, plus `TINSHELL_BUILD_STORE` — the artifact store the bundle belongs to — and
`TINSHELL_BUILD_STAMP` inside the wrapper, both from `common/shell/bundle-stamp.sh`),
the running app logs that stamp at startup (`[greeter] lock: greeter-lock built
from sources 478f33ff535c …`, `apps/greeter/app.ts`) and answers it as
`ags -i greeter request "greeter debug build"`. The fingerprint and the
sidecar's source list are ONE captured input list (`bundle_inputs_capture` taken
before the bundle is produced, hashed by `bundle_inputs_fingerprint`, recorded
by `bundle_stamp_record <artifact> <outfile> <stampfile> <captured-file>`), so a
stale verdict names real inputs. `npm run build:all` builds both
bundles (plus every other shipped artifact) through the same guarded path, and
`npm run check:builds` exits non-zero naming this app when `dist/` or the
deployed `/etc/greetd/tinshell-greeter.sh` predates the sources — the stale-bundle
failure this section describes is caught before the lock screen runs it.

## Greeter dock — REAL dock applets on the SHARED renderer

A bottom-centre strip hosting the REAL dock applets — the shared classes in
`@common/applets/` (Battery, Brightness, Performance, Media, Power, Volume),
imported directly and run inside the greeter process. There are no greeter-local
copies: the strip MOUNTS THE SHARED APPLET RENDERER
(`common/applets/surface` — the same one the desktop dock mounts) on its own
substrate. Colours, geometry, panel placement, pointer routing, the
hidden/appear contract and the backdrop paint (base glass + the bar's lift, a
hole at every resting disc, a stadium behind every open panel) are the
renderer's; the strip is not a copy of the dock — it is the dock's renderer in
another window.

- **Substrate (`strip/host.ts`):** the `AppletSurfaceHost`
  implementation for an EMBEDDED widget row — the renderer's `Gtk.Fixed`
  becomes the strip container's child, `setExtent` sizes that row, and GTK's
  own pick delivers the pointer (a widget has no wl_surface, so there is no
  input region to set). It declares `captureBand: false`, so the renderer's
  router scopes capture to the discs and the open panels' pills — the
  `pillHeight` band above the icons and the discs' square corners are inert
  (the limitations bullet below). The dock's substrate is the layer-shell
  window (`apps/dock/DockSurface.tsx`); these two are the whole difference.
- **Strip (`strip/Strip.tsx`):** builds the surface, creates the
  applet bindings (`createSurfaceApplet`), mounts the applets, owns the
  visibility policy (below) and the row repack (visible cells placed
  contiguously at `iconSize + spacing`, like the dock row's slot model).
- **Appearance/geometry — the DOCK'S OWN config:** `../../config`
  `dockConfigView()` resolves the dock config DIR through the shared store
  machinery (schema + defaults + live) and logs the source:
  1. the dock's own config dir (dev/preview/lock: the LIVE dock config — the
     exact values the dock paints);
  2. `/etc/greetd/tinshell-greeter/dock` — the deployed copy of the dock config
     trio, the pre-login greeter's only route to the live values
     (`install.sh` deploys the trio and refreshes its `config.json` from the
     live dock config; see the deploy flow item).
  Neither present → the alarm is logged and the strip stays out (the card still
  maps): a bundled-defaults snapshot is deliberately NOT painted, because it
  drifts from the dock silently — the "cheap copy" this strip must never be.
  The applet settings writers are NOT exposed (the strip reads the config; a
  greeter-side applet never writes into a user's home).
- **Frost:** the compositor blur of what is behind the greeter window — the
  greeter compositor's layer rule for namespace `greeter` in login mode, the
  live session's global blur in preview/lock. The window is TRANSPARENT (no
  window-wide veil: the strip's glass must sit on the same background the
  dock's does). The card paints NO panel — `.greeter-card` is layout only —
  so in LOGIN mode that region's alpha is 0, below the greeter compositor's
  `ignore_alpha = 0.2` (/etc/greetd/greeter.lua), and the blur layerrule does
  not engage behind the clock/fields region; the strip keeps its own glass
  and the entry wells their scrims. Never fake a frost with a painted tint —
  see `style.css`.
- **Applets + ORDER:** config knob `dock.applets`: battery → performance →
  media → volume → brightness → power (the deployed list ships from
  `config.defaults.json` via `install.sh`).
- **Applet data — TWO sources, per domain.** The greeter's own domains are bound
  IN PROCESS (`strip/backend.ts`): battery, brightness, cpu,
  system, power-profile and tlp read world-readable sysfs/proc and system-bus
  services that exist BEFORE login — that is what the LOGIN screen runs on,
  where no backend process exists at all (the applet backend is hosted by the
  dock, a user-session process; a fresh boot hands the greeter over before
  anything starts it). The applet backend that DOES live in the user session
  (hosted by the dock — `apps/dock/mount.ts` → `mountAppletsBackend`) is reached
  over its shared-group
  unix socket `/run/tinshell/applets.sock` (`common/applets/backend-socket-client`
  client side, `common/applets/host/socket-server` + `common/applets/socket-protocol`
  server side; the `tinshell-greeter` group and the `/run/tinshell` tmpfiles.d entry come
  from setup.sh's root section) — that path carries the SESSION domains the
  strip needs: `mpris` and `mediaWindow`. The volume cell reads the sink
  through the greeter's OWN in-process `volume` domain (`strip/backend.ts`),
  which lock mode can serve (that bundle runs as the session user) and which
  reports no sink rather than a reading the login screen cannot make. Both hosts
  share one renderer and one applet code path; only the backend object differs.
- **VISIBILITY CONTRACT (no placeholder is ever painted as data):** a DATA cell
  is PARKED — out of the row and out of the pointer — until ONE REAL sample
  exists for it: the socket envelope answers `no-sample` while a push member
  warms up, and the greeter's own probes read the source file, so `ok:true` IS
  "a sample exists" on either path (the client proxy's placeholder, and an
  applet's own seed, never reach the strip). While a cell is held the reason is
  logged once. A cell fed by the greeter's own domains (battery, performance,
  brightness) does NOT depend on the transport — it keeps serving on the login
  screen, and a dropped transport parks only the session-bound cells (media,
  volume). POWER is always present — its actions are direct logind calls
  (`strip/power-logind.ts` implements `backend.power` over
  `org.freedesktop.login1.Manager`) and must work pre-login with no backend at
  all. Volume carries NO visibility rule of its own: its cell FOLLOWS the media
  cell (`FOLLOWS` in `strip/Strip.tsx`), so the two appear and disappear in the
  same step, on the one transport-driven media condition — media's presence is
  the real applet's own no-player despawn path (row stub), gated on the
  transport's first sample. The volume applet itself touches no PipeWire: it
  reads the `volume` domain bound in process here, which resolves its sink on
  the first read.
- **WHAT THE GREETER MAY MUTATE (login AND lock):** the charge-threshold cap.
  `strip/backend.ts` binds the `fs` domain with `available: true` and the real
  `writeFileAsync`, and binds the SAME `chargeThresholdStore` the dock uses, so
  a cap set here is RECORDED, not merely applied. Both targets are root-owned,
  so each write escalates through a scoped `sudo -n tee` rule: the sysfs
  attribute and the machine-level intent file `/var/lib/tinshell/charge-cap`.
  setup.sh creates and seeds that file and installs one rule per account
  (`/etc/sudoers.d/tinshell-battery` for the session user, `/etc/sudoers.d/50-tinshell-greeter-battery`
  for the greeter), each visudo-validated before install; sudoers names those
  exact paths, so the generic `writeFileAsync` cannot escalate elsewhere.
  **The intent file is the whole point:** a greeter-local sysfs reading left the
  limit unrecorded, so the session's drift-heal re-applied its own stale value
  over a cap set at the lock screen seconds after login. The store OBSERVES that
  file (`Gio.FileMonitor`), so a cap set here also reaches a session host that
  booted earlier — the dock displays, and heals towards, the current cap instead
  of the value it loaded at start.
  **The user-file half of `fs` stays refused** (`readUserFileAsync` /
  `writeUserFileAsync` answer false) — those address the owner's HOME, the
  cross-user boundary this host must never cross.
  The socket policy (`common/applets/host/socket-server.ts`) denies the `fs` domain to
  EVERY peer, makes every mutator and the store WRITES (`.set`/`.dump`/`.path`)
  owner-only, and allows the shared group the domain READS — including
  `battery chargeThresholdStore.get`, so a greeter WITH a live backend can read
  the store; the greeter does not need to, it reads the sysfs cap directly.
  `brightness setScreenBrightness` is the one group-allowed mutator on the
  socket; the greeter uses its own logind call instead (below).
- **BRIGHTNESS WRITE (login screen):** `backend.brightness` is the shared
  domain bound in process, so its write goes to logind
  `org.freedesktop.login1.Session.SetBrightness` on `/org/freedesktop/login1/session/auto`
  from the GREETER's own session (pre-login) or the session user's while locked — the
  backend's copy of that call targets the backend's session, which does not
  exist before login. No polkit action named brightness is registered on this
  machine; the method authorizes the active seat session without a prompt.
- **POWER PROFILE (performance applet):** reads are system-bus property reads
  on `org.freedesktop.UPower.PowerProfiles` (tlp-pd, up before login); the
  WRITE is authorized by polkit `…PowerProfiles.switch-profile`, which is
  `allow_active=yes` only — so it depends on the greeter's session being the
  active seat session pre-login. The domain's `writeProfile` now logs a refused
  write instead of dropping it silently. Auto mode reads "on AC" through the
  the `fs` domain's READ path (`/sys/class/power_supply/AC0/online`; the cap
  write is the domain's only mutation) and keeps its
  toggle only in memory pre-login (the greeter user's state dir is not
  writable).
- **COLOUR/FROST PARITY (measured):** the strip's bar and disc tones fit the dock's
  accepted model (`appearance.backdrop`@0.35 base + the `backdropLiftColour` lift; disc
  = 0.10·disc.rgb + 0.9·base) to ≤0.5/255 over the SAME local background, the disc
  composite is byte-identical at rest and inside an open panel, and a step panel's
  unfilled region fits the lift model within 1.6/255. The background behind both probes
  is the BLURRED local mean (the frost signature). Ring geometry is identical too
  (radius 15.75, thickness 2.5, pitch 40) — the ring's colour SEGMENTS differ only
  through the cross-user cap above.
- **KNOWN LIMITATION — lock mode has no compositor frost:** session-lock
  surfaces are blanked by Hyprland (no wallpaper behind them, no blur), so the
  lock surface paints its own backdrop (`window.greeter-lock` + the wallpaper
  picture) and its strip glass sits on that instead. The login screen and the
  preview get the real frost.
- **Known limitations (surface-side only, not applet-side):** capture is
  enforced by the renderer's router over the compiled region
  (`common/applets/utils/row-region.ts`), not by a wl_surface input region, so
  with `captureBand: false` the `pillHeight` band above the discs and the
  discs' square corners are inert while the discs and the open panels' pills
  still capture. The Escape-during-drag panel bail is inert in the LOGIN
  deployment only (the login layer window is created after the strip, so the
  host falls back to the row for the panel-escape controller; lock/preview pass
  the real window).
- **Palette (colours only — NO surface):** every colour is generated in
  `theme.ts` (`greeterThemeCss()`, appended to the app CSS AFTER `style.css`) from
  the suite's own tokens — the dock config's `appearance.menu` (`bg` /
  `rowHighlight` / `rowActive` / `text` / `mutedText` / `accent` / `danger` /
  `glowAlpha`), `appearance.textShadow` and `appearance.glyphColour` — the same
  values the dock's discs, the centred menus and the card family read (schema:
  `common/applets/config.schema.ts`). `style.css` is LAYOUT/SHAPE ONLY: add
  colours in `theme.ts`, never there (one owner per value). The dock config is the
  one already loaded for the strip (`dockConfigView()`); where it is unreadable —
  the pre-login `greeter` user, whose dock trio under /etc/greetd/tinshell-greeter/dock
  is a root copy — `MIRRORED_DEFAULTS` in `theme.ts` reproduces
  apps/dock/config.defaults.json verbatim (the ONE place suite numbers are copied;
  a shared token export in `common/` would remove it). Legibility with no panel
  behind the clock/fields: text over the wallpaper uses `menu.text` plus the
  suite's `textShadow`; `mutedText` is reserved for the field glyphs, which sit on
  the glass; the kept `.greeter-field` wells are the `menu.bg` glass, which is what
  holds the entry text at contrast on a bright wallpaper. **ONE named divergence:**
  the INPUT FIELDS' accent is deliberately OFF-TOKEN — `fieldAccent()` in `theme.ts`
  repoints the fields' focus edge, caret and in-field glyph glow at the off-white
  `menu.text` tone instead of the blue `menu.accent`, so the fields read as one
  piece with the clock/entry text. Every other accent consumer keeps the
  token (session buttons, the shared glow alpha); change it in `fieldAccent()` only.
- Config knobs (`dock` section): `applets`, `marginBottom` (8) — host
  placement only; appearance/geometry come from the dock config (above).
- Composed via `overlayBackdrop(card, strip)` in `login/window.tsx` (login),
  `lock/screen.tsx` (session-lock, per monitor, with its own wallpaper picture)
  and BOTH preview modes in `dev/preview.tsx`. Each GreeterDock instance builds inside
  its own gnim root scope; the sample probes stop on root destroy.

## Architecture — the THIRD app category

Apps in this home come in three categories:

| Category | Examples | Lifecycle |
| ---------- | ---------- | ----------- |
| unit-apps | promptd, portal, polkit (dev units; the surfaces run inside the shell) | systemd user units installed by setup.sh — only tinshell-shell.service + tinshell-warm.service are ENABLED |
| on-demand desktop apps | notes, files, annotate, media | plain Gtk.Window apps, no unit, launched by keybind/bang/desktop entry, quit when idle |
| **boot-level (greetd greeters)** | **greeter** | **owned by greetd (system service, root); runs PRE-login as the `greeter` user inside a minimal Hyprland compositor; NO systemd user unit, NO setup.sh unit-loop/enable-line entry** |

```
boot → systemd → greetd.service (root, VT 1)
        └─ [default_session] user = "greeter"
           └─ start-hyprland -- -c /etc/greetd/greeter.lua   (greeter compositor, VT 1)
              └─ exec-once: awww wallpaper + /etc/greetd/tinshell-greeter.sh
                 │            (NO 'hyprctl dispatch exit' — the app spawns
                 │             /etc/greetd/greeter-handoff.sh on login, which
                 │             SIGKILLs this compositor tree so the last
                 │             frame freezes on screen)
                 │  AstalGreet ⇄ greetd IPC over $GREETD_SOCK
                 └─ authenticated → start_session(cmd, env) → app keeps
                    running ("Logging in…") + spawns the handoff → compositor
                    dies mid-frame → greetd starts the session on the same VT
login succeeds → greetd starts the real session (the session user) on the SAME VT (tty1)
logout         → session exits → greetd respawns the greeter
```

The in-session LOCK mode is a SEPARATE deployment of the same app (no greetd):
`loginctl lock-session` → hypridle `lock_cmd` → `TINSHELL_GREETER_MODE=lock dist/tinshell-lock.sh`
→ Gtk4SessionLock (compositor lock) + AstalAuth.Pam → unlock → app quits.

### Key facts

- `start-hyprland` is an ELF binary that passes everything after `--` to
  Hyprland (its own help text). `start-hyprland -- -c <file>` works; use
  `start-hyprland -- --verify-config -c <file>` to syntax-check a config
  WITHOUT starting a compositor.
- greetd (extra repo) ships `usr/lib/sysusers.d/greetd.conf`
  (creates the `greeter` user) and `/etc/pam.d/greetd` (system-local-login →
  pam_systemd → seat/GPU + XDG_RUNTIME_DIR for the greeter session).
- **The greeter user cannot read the session user's home** — the deployed bundle must be
  self-contained (`ags bundle` inlines everything incl. `common/*`) and all
  config lives under `/etc/greetd/`.
- The AstalGreet `Greeter` object (NOT the one-shot `Greet.login()`) handles
  multi-request PAM flows: `visible-request` / `secret-request` →
  `post_auth()`, `info-message` / `error-message`, `cancelled` →
  `authenticated` → `start_session(cmd, env, cb)` → `start_session_finish(res)`.
  ONE Greeter for the app's lifetime; the signal handlers read a mutable
  `current` holder (user/password/session) that `startAuth` refreshes on every
  submit, so retries post the CURRENT values. Greetd
  reads session env (XDG_SESSION_TYPE, XDG_CURRENT_DESKTOP) BEFORE the PAM
  session opens — it MUST come from the greeter's `start_session` env, never
  `~/.profile` wrappers.
- Auth-error handling: on `error-message` / `cancelled` the card unlocks
  (error text + red mask, password field keeps its text, red clears on the
  first edit). NO auto-restart — retry is USER-initiated (submit re-runs
  `create_session` on the same Greeter with the refreshed `current` values).
- **Lock mode (`TINSHELL_GREETER_MODE=lock`):** `gi://Gtk4SessionLock` (a SEPARATE
  GIR namespace from Gtk4LayerShell — session lock) + `gi://AstalAuth` `Pam`
  (static one-shot `Pam.authenticate(pw, cb)` / `authenticate_finish(res)`
  THROWS on failure). `Pam` defaults: service `astal-auth` (ships its own
  `/etc/pam.d/astal-auth` → `auth include login` → system-auth/faillock),
  username = process owner. Both typelibs are lazy-imported (greet/preview
  never load them).
- **`::unlocked` fires SYNCHRONOUSLY inside `unlock()`, BEFORE the
  `unlock_and_destroy` request is sent** (gtk4-layer-shell v1.3.0 emits the
  signal first, then roundtrips). Quitting inside the handler kills the
  process before Hyprland sees the unlock → the "crashed lockscreen"
  (lockdead) screen. Defer the quit via `GLib.idle_add` so the wrapper's
  internal `wl_display_roundtrip` completes first.
- **Hardware brightness keys work with NOBODY logged in** — once
  `/etc/greetd/greeter.lua` carries the binds; until then the login screen has
  no brightness keys. The greeter
  compositor's own `templates/greeter.lua` binds `XF86MonBrightnessUp` /
  `XF86MonBrightnessDown` to `/usr/bin/brightnessctl set 5%+` / `5%-` — the
  same binary and step as hyprland.lua's binds, so the key behaves identically
  at the greeter and in the session. Both sides carry `repeating` (a
  `HL.BindOptions` field), so a HELD key keeps stepping — a bind without it runs
  once per press and the key looks dead while it is held. The path is ABSOLUTE here and bare in
  hyprland.lua: the greeter's exec environment is minimal (HOME is unset) and a
  bind that cannot resolve its binary at a login screen fails with no visible
  symptom. Nothing else maps those keys on this VT: the
  login window is a keyboard-EXCLUSIVE layer surface (an unmapped key reaches
  the card and is dropped), and hyprland.lua belongs to the USER's compositor,
  which is not running yet. The command runs as `greeter`, so it takes
  brightnessctl's logind path (`Session.SetBrightness` on the greeter's own
  session — the backlight sysfs attribute is root-only), which logind
  authorizes for the owner of the ACTIVE seat session, true while the greeter
  holds VT 1. The binds live in the template and reach the LIVE
  `/etc/greetd/greeter.lua` through a root copy of THAT ONE FILE — a
  config-only change, so `install.sh` is the wrong tool here (it would
  re-deploy the bundle and PAM for one keybind — see "Deploy a config-only
  change" below).
- **The shipped `templates/greeter.lua` PINS THE POINTER VISIBLE** —
  `cursor.hide_on_touch`, `hide_on_tablet` and `hide_on_key_press` all `false`
  plus `inactive_timeout = 0`, beside the existing
  `no_hardware_cursors = false`. Hyprland 0.56 hides the pointer on touch by
  default, and only a POINTER MOTION event clears that flag: on this
  convertible a folded tablet-mode machine has its touchpad suspended, so a
  touch is the only input it can produce — the pointer would hide on that
  touch and never come back, and the login screen would render with no visible
  cursor. **The template is the only place this pin can live durably:** the
  live `/etc/greetd/greeter.lua` is a PAYLOAD file (`install.sh` always
  replaces it — root AGENTS.md, "Deploy writes to live config"), so a pin
  applied to the live file alone is reverted by the next deploy. Two
  consequences: a pin change lands on an already-deployed machine through the
  config-only copy below (atomic temp + rename, never `install.sh` for one
  config value), and any change to the cursor block belongs in the template
  FIRST. `templates/greeter.lua` is the ONLY compositor config in the repo —
  nothing under `systemd/`, `setup.sh` or `common/shell/` writes one
  (`setup.sh` only greps it for the blur rule and the brightness binds, and
  prints the copy command when either is missing).
- **Hardware keys on the LOCK screen are NOT this app's:** they are
  `{ locked = true }` binds in hyprland.lua (brightness up/down + volume
  up/down/mute). While a session lock holds the seat, Hyprland's keybind
  manager SKIPS every bind without that flag and delivers the key to the lock
  surface instead, which has no use for it; the flag only relaxes that gate, so
  the locked screen runs the same dispatcher, binary and step as the unlocked
  one. The bind consumes the key before any surface sees it, so no key
  controller belongs here — and the lock surface's Escape backstop still gets
  Escape (nothing binds it). Volume works under the lock because locking does
  not DEACTIVATE the session; brightness because logind authorizes its owner on
  the active seat.
- **Gio.File.copy(OVERWRITE) unlinks the destination first** — needs write on
  the parent DIRECTORY. To overwrite the world-writable greeter wallpaper
  file (the session user cannot write the greeter-owned /etc/greetd/tinshell-greeter dir), use
  `src.load_contents()` + `dst.replace_contents(bytes, null, false,
  Gio.FileCreateFlags.NONE, null)` (O_TRUNC in place).
- **Login wallpaper must be greeter-readable:** the session user's home is 700, so the
  login screen reads the world-readable `/etc/greetd/tinshell-greeter/wallpaper.png`,
  synced by the wallpaper rotation (`~/.local/bin/wallpapers-sync apply`) and the
  lock screen.

## Repo layout

```
greeter/
├── AGENTS.md              ← this file
├── app.ts                 ← ENTRY: createApp + mode dispatch only (NO JSX — .ts entry)
├── mode.ts                ← the run modes, resolved ONCE from the env
│                             (production / TINSHELL_GREETER_PREVIEW / _HARNESS / _MODE=lock)
├── run.sh                 ← dev shim (the common/shell launcher) — dev ONLY
├── build.sh               ← session-user build → dist/greeter-tinshell.sh (apps/greeter/bundle.sh: guard + stamp)
├── build-lock.sh          ← session-user build → dist/tinshell-lock.sh (the LOCK bundle, same source, TINSHELL_GREETER_MODE=lock)
├── bundle.sh              ← the build BODY both scripts source (guard, outfile patch, GPU pins, stamp,
│                             atomic replace of dist/*.sh) — not executable on its own
├── install.sh             ← ROOT deploy → /etc/greetd/ (rebuilds, refuses a payload whose stamp does not
│                             match the sources, then installs bundle + stamp; via sudo, never automatically)
├── dm-switch.sh           ← spare-TTY DM switch/rollback (NOT from the graphical session)
├── preview.sh             ← DEV windowed prototype launcher (login|lock card + dock, pinned to
│                             workspace 10; TINSHELL_GREETER_PREVIEW=login|lock; never locks anything)
├── @girs → ../@girs       ← symlink (per-app @girs pattern; picks up AstalGreet after `ags types`)
├── config.defaults.json / config.schema.ts → config.schema.json / config.ts
│                          ← config store bound to /etc/greetd/tinshell-greeter (NOT the checkout!)
│                            (+ the `dock` section — see "Greeter dock — REAL dock applets")
├── state.ts               ← last-login username (`/etc/greetd/tinshell-greeter/last-user`)
├── style.css              ← layered on common/shell/theme.css; LAYOUT/SHAPE only
├── theme.ts               ← generated colour layer (suite palette: the dock config's
│                             appearance.menu / textShadow / glyphColour tokens)
├── login/                 ← the greetd login product
│   ├── window.tsx         ← fullscreen layer-shell window (namespace "greeter", wallpaper + card, Escape backstop)
│   ├── auth.ts            ← the AstalGreet/PAM flow (multi-request Greeter, retries, handoff)
│   ├── card.tsx           ← clock + user + password + status + session picker + submit
│   ├── sessions.tsx       ← parses /usr/share/{wayland,xsessions}/*.desktop, hides unavailable
│   └── clock.tsx          ← clock + date; fills labels at construction AND on map, then a plain
│                             1s timeout (NOT grouped timeout_add_seconds — its quantization can
│                             show stale/blank time across suspend/resume)
├── lock/                  ← the in-session session-lock product
│   ├── screen.tsx         ← session-lock surfaces (Gtk4SessionLock + AstalAuth.Pam, wallpaper backdrop)
│   └── surface.ts         ← per-monitor lock-surface builder: card + strip, and a window is
│                             ALWAYS handed to `assign_window_to_monitor` (card-only when the
│                             strip factory throws, a minimal notice when the card throws) — no
│                             throw out of the lock handler may leave an output unassigned
├── strip/                 ← the REAL-dock-applet strip on the shared renderer
│   ├── Strip.tsx          ← bottom-centre strip: mounts the shared applet renderer
│   │                         (common/applets/surface) with the dock's config; applet
│   │                         manifest, the two-source backend + the cell gates live here
│   ├── backend.ts         ← the greeter's OWN domains (battery/brightness/cpu/system/
│   │                         power-profile/tlp + a sysfs `fs` whose only write is
│   │                         the charge cap) and the first-sample
│   │                         probes — the pre-login readings
│   ├── host.ts            ← the embedded-widget AppletSurfaceHost (the substrate)
│   └── power-logind.ts    ← the greeter's `backend.power`: login1 D-Bus calls
│                              (works pre-login, no backend/socket needed)
├── dev/                   ← dev-only, lazily imported by app.ts (off the production path)
│   ├── preview.tsx        ← the windowed login/lock prototypes (TINSHELL_GREETER_PREVIEW)
│   ├── greetd-dummy.py    ← fake greetd IPC server (TINSHELL_GREETER_HARNESS=1 + GREETD_SOCK;
│   │                         password "789")
│   ├── lock-surface.probe.ts ← drives lock/surface.ts with stub windows/compositor
│   └── backend.probe.ts   ← the pre-login data path, checked without a real session
└── templates/
    ├── greetd.config.toml ← installed to /etc/greetd/config.toml
    ├── greeter.lua        ← installed to /etc/greetd/greeter.lua (greeter compositor; also
    │                          carries the hardware brightness binds that work logged out, and
    │                          the cursor pin that keeps the pointer visible at login)
    └── greeter-handoff.sh ← installed to /etc/greetd/ (login handoff: SIGKILLs the
                              compositor tree so the last frame freezes on screen)
```

The app is cut by CONCERN, not by file type: `login/` and `lock/` are the two
products, `strip/` is the shared-renderer applet strip both of them carry, and
`dev/` holds everything that must never run in production (the entry imports it
lazily). There is no `mount.ts` and no `commands.ts` — the greeter is outside the
hosting manifest/registry by design (see "Architecture — the THIRD app category").

Type-check note: JSX only parses in .tsx files — the build entry app.ts must stay
plain .ts (the surfaces in login/, lock/ and strip/ hold the JSX). There is NO
per-app tsconfig.json; the type-check gate is
`npx tsc --noEmit` at the REPO ROOT (the greeter sources are CLEAN — the only
tsc errors repo-wide are the pre-existing `/usr/share/ags/js` shim typings)
plus `ags bundle` compiling for both bundles.

## Build / deploy / test flow

- **Build (as the session user, no sudo):** `./build.sh` → `dist/greeter-tinshell.sh`
  (`ags bundle --gtk 4` — the gtk4 flag is REQUIRED, root-level node_modules
  can't infer; plus the per-app JS-outfile sed, same as common/shell/run.sh —
  and the bundle guard, the same one `run.sh` runs). The build body is
  `apps/greeter/bundle.sh`, shared with the lock bundle: one source, one build.
  Sources unchanged since the last build makes it a no-op (`--force` rebuilds
  regardless; `npm run build:all` drives it with the rest of the repo's
  artifacts and `npm run check:builds` verifies it).
- **AUR (as the session user, when the typelib is missing):** `libastal-greetd-git` needs
  `quarrel` installed first; `libastal-auth-git` (lock mode) does NOT need
  quarrel (deps glib2/glibc/pam) and SHIPS its own `/etc/pam.d/astal-auth`.
  yay's internal sudo can't prompt from an unattended shell —
  build via makepkg as the session user and install the .pkg.tar.zst with a root
  approval (`pacman -U --noconfirm`).
- **Lock bundle (session user):** `./build-lock.sh` → `dist/tinshell-lock.sh`. NOT
  deployed via install.sh — hypridle's `lock_cmd` runs it directly from
  `apps/greeter/dist/` (`<checkout>/apps/greeter/dist/` as an absolute path) as the session user with `TINSHELL_GREETER_MODE=lock`.
  Because hypridle execs that file, the build replaces it ATOMICALLY (build to
  a temp file, rename over it) and skips the build while the sources are
  unchanged.
- **Deploy a CONFIG-ONLY change to `/etc/greetd/greeter.lua`** (a bind, a layer
  rule, a config value — anything whose only target is that file): copy the ONE
  file. Do NOT reach for `install.sh`: it is the BUNDLE deploy, and on the way
  it re-deploys the bundle, both config schemas, the dock trio,
  `templates/greeter.lua`, `greeter-handoff.sh` and `/etc/pam.d/greetd` — i.e.
  code and PAM on this machine's only login path in order to ship one keybind.
  (The LIVE `/etc/greetd/tinshell-greeter/config.json` sits outside that argument:
  `install.sh` seeds it only when it is absent and otherwise PRESERVES it —
  root AGENTS.md, "Deploy writes to live config".)
  `install` truncates the destination IN PLACE, so an interrupted copy (full
  filesystem, cancelled sudo) leaves an empty `greeter.lua` there, and greetd
  starts `start-hyprland -- -c /etc/greetd/greeter.lua`: an unparseable file
  leaves Hyprland's error overlay on VT 1 instead of a login prompt. Write a
  temp file in the same directory and rename over the target instead — a rename
  within one filesystem is atomic, so the old file stays valid until it is
  replaced:

      sudo install -Dm644 <checkout>/apps/greeter/templates/greeter.lua /etc/greetd/greeter.lua.new
      sudo mv -f /etc/greetd/greeter.lua.new /etc/greetd/greeter.lua
      Hyprland --verify-config -c /etc/greetd/greeter.lua   # must print: config ok

  Rollback copies of this file live in `~/.cache/tinshell-greeter-rollback/` (NOT
  /tmp — see the README there).
- **Deploy (root):** `sudo ./install.sh` — installs the bundle +
  config store + templates into `/etc/greetd/`, AND the dock config trio into
  `/etc/greetd/tinshell-greeter/dock/` (`apps/dock/config.{schema,defaults}.json`).
  It REBUILDS the bundle first (the build is unprivileged; `--no-build` deploys
  the artifact already in `dist/`), then verifies it against the sources it was
  built from and REFUSES (exit 3, nothing written under `/etc/greetd/`) when
  the stamp does not match — a stale login bundle cannot be deployed by
  accident. The matching `tinshell-greeter.sh.stamp.json` is installed beside it, so
  `npm run check:builds` reads the DEPLOYED copy, not just `dist/`.
  Idempotent. Does NOT switch the DM. Config safety (root AGENTS.md,
  "Deploy writes to live config"): the LIVE
  `/etc/greetd/tinshell-greeter/config.json` is SEEDED from `config.defaults.json`
  only when ABSENT and otherwise PRESERVED (it holds the deployed dock values
  the login strip reads — the loader merges the defaults UNDER it), with
  `--force` as the explicit re-seed that prints the md5 it DESTROYS;
  `config.defaults.json` / `config.schema.json` / the dock trio are always
  installed (they are the seed); `config.toml`, `greeter.lua` and
  `/etc/pam.d/greetd` are always installed too (payload — greetd, the greeter
  compositor and PAM read them directly, so no defaults channel exists), each
  announced with the md5 it superseded. The pre-login strip also needs the
  dock's LIVE values there: `install.sh` refreshes that mirror in the same run,
  from `$TINSHELL_DOCK_CONFIG` when set and otherwise from the INVOKING user's
  home (`SUDO_USER` — never `$HOME`, which under sudo is `/root`, where the
  readability test fails and the copy is skipped in silence while the deploy
  still reports success and ships the previous mirror). An unreadable source is
  named in the deploy output and repeated in its summary, never skipped without
  a word (without the mirror the login strip paints the dock config DEFAULTS —
  the loader's own values, logged with the source line — while dev/preview/lock
  read the live dock config directly).
- **Preview (dev):** `apps/greeter/preview.sh [login|lock]` (or
  `TINSHELL_GREETER_PREVIEW=1|login|lock <wrapper>`) renders the login OR lock
  card + the real dock applet strip as a plain Gtk.Window pinned to
  workspace 10 in the live session — no greetd IPC, NO session lock, NO PAM
  (lock preview submit just reports status). Pure layout/UX iteration; the
  real lock path and greeter compositor are untouched. AstalGreet is
  lazy-imported, so preview runs even without the typelib installed.
  GOTCHA: a second gjs instance of the same bundle becomes a GApplication
  REMOTE client of the first (same io.Astal.greeter id) and exits printing
  the request dispatcher's empty-argv response — preview.sh kills leftover
  `greeter-tinshell.js` instances first; kill leftovers before manual re-tests
  (use `pkill -f 'greeter-tinshell[.]js'` — an unbracketed pattern matches the
  caller's own cmdline and kills the caller).
- **Live test:** a real logout or reboot — greetd is this machine's ONLY
  display manager (`display-manager.service` → `greetd.service`; no
  plasmalogin/sddm/gdm/lightdm/ly unit is installed), so ending the session
  lands on the greeter. Watch `journalctl -u greetd -f` (the app logs to
  stderr).
- **Harness (dev):** `dev/greetd-dummy.py` + `TINSHELL_GREETER_HARNESS=1` + `GREETD_SOCK`
  → the real AstalGreet flow against a fake greetd (no logout/PAM/faillock).
  Password `789`; state file overridden via `TINSHELL_GREETER_STATE_FILE` (harness
  uses /tmp — the production /etc/greetd/tinshell-greeter/last-user is
  greeter-owned; permission noise if written as the session user).
- **Syntax-check greeter.lua safely:** `start-hyprland -- --verify-config -c /etc/greetd/greeter.lua`
- **Bus:** `io.Astal.greeter` (instance `greeter`) exists only pre-login on
  the GREETER's session bus — `ags -i greeter request` from the user session
  cannot reach it (different session bus). Debugging goes through the greetd
  journal (the app logs to stderr).

## Conventions that bind this app

- **SHARE, NEVER COPY:** the greeter has NO local copies of dock widget,
  binding or panel code. The ONE renderer is `common/applets/surface`
  (`surface.ts` + the `AppletSurfaceHost` port + `createSurfaceApplet`); the
dock mounts it on its layer-shell substrate (`apps/dock/DockSurface.tsx`), the
strip on `strip/host.ts`. Never re-implement rendering, panel
placement or pointer semantics in an app — extend the shared renderer + port.
  The strip CONTAINER's layout (centring, bottom margin) is the greeter's own
  widget composition, not the renderer's.

- Window namespace **`greeter`**; blur in LOGIN mode comes from the greeter
  compositor's layer rule in `/etc/greetd/greeter.lua` (NOT hyprland.lua); the
  lock surface and the preview windows get the live session's GLOBAL blur
  (and the lock is blanked by Hyprland — no frost there, see the strip
  section).
- **NO systemd user unit, NO setup.sh unit-loop/enable-line entry** — but
  setup.sh MUST know the app: chmod list (run.sh/build.sh/build-lock.sh/install.sh) + the
  greeter block (install greetd + libastal-greetd-git, build + deploy, verify
  /etc/greetd/greeter.lua; the DM switch enable/disable is auto-skip guarded).
- package.json workspaces include `"greeter"`.
- Root only (the script is run with sudo); AUR (`libastal-greetd-git`) via yay as the session user
  with a warm sudo timestamp.
- **Recovery when the greeter itself fails:** from a TTY (Ctrl+Alt+F2, log in
  as the session user) restore the pre-restructure bundle and reboot —
  `sudo cp ~/.cache/tinshell-greeter-rollback/greeter-tinshell-pre-restructure.sh /etc/greetd/tinshell-greeter.sh`
  — or start a session by hand with `/usr/bin/start-hyprland` (what
  hyprland.desktop execs). A hand-restored bundle carries no stamp for this
  tree, which is exactly what `npm run check:builds` then reports for
  `greeter-deployed` (a deliberate rollback is reported, not prevented; the
  deploy is what refuses a mismatch, never a plain file copy). There is NO second display manager to flip back to:
  greetd is the only DM unit installed and display-manager.service points at it.
  The persistent rollback copies live in `~/.cache/tinshell-greeter-rollback/`
  (`greeter-tinshell-*` and `tinshell-lock-*`, pre-restructure builds, plus
  `greeter.lua-pre-brightness-binds` for the compositor config itself — see the
  README in that directory) — /tmp is wiped by a reboot, so never keep the only
  copy there.
- pam_faillock is ACTIVE machine-wide (deny=9, user-set; unlock_time=0 =
  locked until `faillock --reset` as root) — the greeter never auto-retries
  auth, so a single wrong password can't trip it.
- **Lock wiring (USER session, not the greeter):** `~/.config/hypr/hypridle.conf`
  `lock_cmd = pgrep -f '[a]gs-lock.js' || TINSHELL_GREETER_MODE=lock <checkout>/apps/greeter/dist/tinshell-lock.sh`
  (hypridle execs the absolute path of this tree's built lock script —
  `$TINSHELL_HOME` when the session's environment already names it)
  (the `[a]` bracket keeps pgrep from matching its own `sh -c`); there is no
  manual lock key — `hyprland.lua` binds none — so locking comes from hypridle
  (the idle listener's `on-timeout` and `before_sleep_cmd`, both
  `loginctl lock-session`) and from the shell's Lock step
  (`common/applets/domains/power.ts`, which raises the session overlay and then
  runs `loginctl lock-session`); `debug.enable_stdout_logs
  = false` in hyprland.lua kills post-login tty1 log spam.
- **Wallpaper sync:** `~/.local/bin/wallpapers-sync apply` picks a random
  `~/wallpapers/*.png`, runs `awww img` (fade), then `cp`s it to
  `/etc/greetd/tinshell-greeter/wallpaper.png` (best-effort); the lock screen also
  syncs it at lock time. Login reads that file; lock queries `awww query`
  live. `awww` is the swww successor (background layer, namespace
  `awww-daemon`); rotation = `wallpaper-cycle.timer` (10 min) →
  `wallpaper-cycle.service` → `wallpapers-sync apply`.

## Out of scope (do not build unless asked)

- On-screen keyboard for tablet login (noted as a stretch goal).
- User-switching UI polish beyond the core login flow.
- Lock-screen fingerprint/MFA (AstalAuth's multi-prompt conversation flow —
  only the one-shot password path is wired).

## greetd local build

- **Display manager: greetd — LOCALLY PATCHED (seamless login handoff).**
  PKGBUILD + seds in `~/aur/greetd/`. Patches: start_session grace 5s→1s;
  session worker skips `kd_setmode(Text)` + `term_clear` (VT keeps last
  frame) — the handoff details in "What the user sees" above ride on these.
- **NEVER restart greetd mid-session.**
- User session launches `/usr/share/wayland-sessions/hyprland.desktop` via
  greetd IPC (the session picker feeds `start_session` with its desktop
  entry).
- `start-hyprland` is a Hyprland watchdog: it restarts Hyprland in
  `--safe-mode` on a non-clean exit.
