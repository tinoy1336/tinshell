# AGENTS.md — keyboard

The on-screen keyboard surface (OSK): thumb/compact layouts driven by the
SW_TABLET_MODE state. A REAL standalone app (bus `io.Astal.keyboard`); this
directory IS the app.

**READ the repository root `AGENTS.md` FIRST** (multi-app rules: bus
naming, router, launch path, shell aggregation, common modules, onboarding).

## Identity

| | |
| --- | --- |
| Instance / bus | in shell: inside `shell` (`io.Astal.shell`); dev island: `keyboard` (`io.Astal.keyboard`) |
| Unit | none (dev island; production = `tinshell-shell.service`) |
| Window namespace | `keyboard-main` (owned by `identity.ts`) |
| Compositor rule | blur `keyboard-.*` (ignore_alpha 0.2); DATA in `hypr-rules.ts`, rendered into `~/.config/hypr/rules/040-keyboard.lua` by `npm run gen:hypr-rules` |
| Keybinds | **NONE — touch-first by design**: auto-show on tablet mode, summon via the dock applet |
| Router | `route-map.conf`: `keyboard=shell,keyboard` |
| Gate | `keyboard.enabled` (own trio, `apps/keyboard/config.json`) — startup-read only, restart to apply |
| Runtime state | `~/.local/state/tinshell/apps/keyboard/state.json` (the active layout — not config) |

## CONFIG-GATED (the memory guarantee)

`keyboard.enabled` in `apps/keyboard/config.json` (the keyboard surface's OWN
schema-driven trio — `config.{defaults,schema,json}` + `config.schema.ts`,
same shape as every other surface; TRUE on this machine, schema default false).

- When **false**: `keyboard/mount.ts` registers a stub at `["keyboard"]`
  ("keyboard: disabled (keyboard.enabled=false)") and NO keyboard module is
  ever imported — esbuild defers the dynamic imports, so the keyboard's GI
  imports, widget trees and module bodies NEVER execute. That is the memory
  guarantee: a disabled keyboard costs nothing.
- When **true**: the dynamic imports resolve and the full surface mounts.
- Evaluated ONCE at startup — editing `keyboard.enabled` requires a restart
  (no config hot-reload for the gate).

## Sources (what lives here)

- `Main.tsx` — the keyboard surface window (`keyboard-main`
  namespace) + the control object (show/hide/rebuild).
- `keys/` — key definitions + `repeat.ts` (client-side key repeat;
  `stopRepeat()` on quit).
- `layouts/` — layout sets (e.g. thumbs).
- `tablet.ts` — a long-lived helper child in poll mode (python re-reads
  EVIOCGSW + accelerometer every 500ms, emits on change — `spawnHelperStream`
  from `common/tablet`, which refcounts the child per request, so a shell that
  also hosts the dock runs ONE poll loop for the machine switch) →
  edge-triggered show/hide via the shared `createTabletWatchdog` core
  (`fallback: "never-enter"` — garbage accel data never latches tablet mode);
  `startTabletWatchdog()`.
- `style.ts` — dynamic CSS (`refreshCss()` rebuilds the appearance.* tokens).
- `commands.ts` — request handlers (prefixed `["keyboard", …]`).
- `config.ts` — owns the app's config store + facade (`createConfigStore`
  via `common/config/facade.ts`); `keyboardEnabled()` gate (the dock's
  Keyboard applet imports it from here as `@apps/keyboard/config`).
- `Main.tsx` also owns the layout's state store (`createStateStore`, app id
  `keyboard`) — see §Runtime state.

## Config

The keyboard surface's own trio via the facade (`apps/keyboard/config.ts`
owns the store; `apps/keyboard/config.schema.ts` is the authored source,
`config.schema.json` generated):

| Section | Purpose |
| --- | --- |
| `enabled` | the gate (startup-read) |
| `keyScale` | key size scaling |
| `repeat` | key-repeat parameters |
| `appearance` | colours/fonts (dynamic tokens via `refreshCss`) |
| `showMode` | show/hide policy (auto/manual) |
| `autoTextApps` | apps that auto-show the keyboard |

## Runtime state

The active **layout** is NOT configuration: the surface switches it itself (the
`layout` keycap, the dock applet's Mode step, `keyboard layout set|next`), so a
value the app mutates on its own would otherwise dirty the tracked live config
file on every toggle. It lives in the app's state store
(`apps/keyboard/Main.tsx` owns it beside `layoutName`):

| Key | File |
| --- | --- |
| `layout` (`standard`/`thumbs`) | `~/.local/state/tinshell/apps/keyboard/state.json` |

The store is written by the layout setters only; `keyboard layout get` and
`keyboard status` report the live value. There is no `layout` config key — a
pre-store value in the live config is adopted on mount (state, else the
leftover config key, else `standard`) and the key is then pruned from the live
tree, because the closed root schema would make the next `keyboard config
reload` refuse the file.

## Command surface

All registered PREFIXED (`["keyboard", …]`):

| Path | Purpose |
| --- | --- |
| `keyboard toggle/show/hide` | surface visibility |
| `keyboard ping` | alive check (pong) |
| `keyboard rebuild` | rebuild the key rows (layout/keyScale changes) |
| `keyboard status` | state line (layout, showMode, visibility, shift/caps, …) |
| `keyboard key` | inject a key |
| `keyboard repeat get` | repeat state |
| `keyboard layout get/next/set` | layout switching — `get` reads the state store, not config |
| `keyboard show-mode get/set` | show policy |
| `keyboard tablet get/set` | tablet-mode override |
| `keyboard config all/get/set/reload` | live config via facade |
| `keyboard debug css/tree` | introspection |

## Lifecycle

`keyboardMount()` (the shell's universal entry or island `app.ts`) — stub when
disabled. When enabled, in order:

1. Ensure the **ydotool daemon** (uinput backend) is up before any key goes
   out — `systemctl --user is-active ydotoold`, else
   `systemd-run --user --unit=ydotoold --collect ydotoold`.
2. `kbRefreshCss()` — dynamic tokens (config.appearance.*).
3. Build the keyboard window once; expose its control to the dispatcher.
4. `startTabletWatchdog()` — long-lived helper, poll mode (python-side 500ms
   EVIOCGSW + accel re-read loop, emit-on-change; no per-tick spawning).
5. Live config changes: `rebuild()` rows + `refreshCss()` (facade-filtered,
   fires only on KEYBOARD subtree changes).

`keyboardShutdown()` → `stopRepeat()` (client-side key repeat).

## Gotchas

- The gate is evaluated at IMPORT of `keyboard/mount.ts` — the island
  (`ags run apps/keyboard/app.ts`) and shell both respect it.
- Tablet mode needs the `input` group + lingering-manager restart for
  EVIOCGSW read access; manual override via `keyboard tablet set on|off|auto`.
- `ydotoold` must never be killed mid-press (input device vanishes) — it is
  managed as a systemd user unit.
