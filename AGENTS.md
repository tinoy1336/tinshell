# AGENTS.md — TINSHELL multi-app home

This repository is a multi-app TINSHELL home structured as a **monorepo with
workspaces**. Every app is a REAL standalone app in `apps/<app>/` — its
own sources, its own `app.ts`, its own shared `mount.ts`, its own config
namespace. **TWO deployment shapes, one codebase:**

- **Shell (PRODUCTION, default)** — the shell PRESET (bus `io.Astal.shell`,
  unit `tinshell-shell.service`, ENABLED): ALL
  apps in ONE process. One instance,
  one bundle, one warm cache, ~half the resident memory of N islands.
  No own sources — the preset is `TINSHELL_HOST_SET=shell` served by the ONE
  universal bundle (`common/host/entry.ts`).
- **Islands (DEV)** — every app runs standalone (`ags run apps/<app>/app.ts`
  or its per-app unit): isolated restarts, an unstable app can't take down the
  others, fast per-app rebuilds. The **five shell surfaces are five real
  apps** (dock, launcher, notifications, keyboard, clipboard).

## Status — early polish

The tree is in its early polish stage. A repo-wide pass has removed dead and
outdated references — stale comments, tombstones of removed modules, provenance
chatter, deprecated API mentions. New code must not reintroduce these patterns
(comments state technical fact only, no dates or history).

The shell instance aggregates every app's `mount.ts`; islands call the same
mount from their own `app.ts`. `common/app/mode` (`isShell` — legacy name;
`TINSHELL_SHELL=1` is set by tinshell-host.sh for EVERY instance with an eager member
— the shell AND every resident island, not just the shell unit) gates the
lifecycle differences: quit-on-close is disabled in resident instances
(closing the last notes window must never kill the shared process), per-app
log sinks are skipped there (one global sink `/tmp/tinshell-debug.log`).
The PRODUCTION shell instance is identified by `TINSHELL_HOST_INSTANCE=shell`.

A RESIDENT instance is LAZY for the standalone apps it hosts but that are
NOT in its own set (notes/files/annotate/media):
they are NOT imported or mounted at startup — no windows, no CSS, no MPRIS,
no GStreamer until first use. That covers the production shell AND every dev
island/combo — the universal entry wires `registerLazyApps(lazyNotInSet)`
(common/host/registry.ts) in ANY resident instance with an eager set, so a
dock island lazy-loads notes/files/annotate/media on the first request
naming them, exactly like the shell does. `common/app/lazy` loads one on
the first request naming it (the `common/app/start` request pre-step).
Notes/files/
annotate unload after an idle grace once their last window closes (default
60s); PLAYER unloads on the same 60s grace. Each lazy app's
`mount.ts` exports `unmount` (resets module-scope state; per-window refs
die with the windows). Command trie nodes stay registered FOREVER (esbuild
caches modules — top-level side effects never re-run on re-load;
`mount()` re-arms state);
`registry.ensureNamespace` pre-declares each lazy prefix so the router probe
lists it from boot. Two invariants hold in the shared lazy/unload path
(`common/app/lazy.ts` + `common/host/registry.ts`):

1. `graceMs` is uint32-clamped — a larger value overflows GLib's timeout
   interval, so `scheduleUnload` throws INSIDE the window close-request
   handler and aborts closes mid-teardown. Non-finite/<=0 = never unload.
2. The unload promise lives in a module map (`unloadPromises`), NEVER in the
   lazy state: a settled promise kept in the state re-arms `.then` on every
   `ensureLoaded` = infinite microtask recursion = JS-heap OOM runaway.
CSS providers are applied ONCE per lazy app and NEVER removed while the
process lives (removal after window close triggers a GTK restyle storm).
Boot-restore is NOT shell-only. Every resident instance that lazy-registers
apps persists WHICH lazy apps are loaded in a PER-OWNER file under
XDG_RUNTIME_DIR — the shell keeps `lazy-loaded.json`; every other resident
instance keeps `lazy-loaded-<instance>.json` (islands must never read each
other's — or a stale shell's — set, and N writers must never clobber one
shared file). `restoreLoadedApps` brings the persisted set back at host
start (crash-loop guard: two consecutive load failures drop an app). Each
app's durable `restoreIf` signal (e.g. notes' state file via the registry
predicate) is the BACKSTOP: unconditional in the shell, but in a resident
island it fires ONLY when that island's own memory file is absent. `restoreIf`
reads state that is GLOBAL, not per-instance, so the backstop is arbitrated by
an exactly-once restore claim — `restore-claim-<app>` in the same runtime dir,
created with an exclusive open and carrying the owner instance + pid. Without
it, N resident instances booting with no memory file each adopt the same open
note (N windows, N writers on one .md). A claim whose pid is dead is
reclaimed, a genuine unload releases it, and a failed load keeps none — so a
crash can never strand an app for the rest of the login. Pure-lazy singleton
islands register no lazy apps → every function here no-ops for them (they
spawn per request).

**READ THIS FILE FIRST for any TINSHELL work.** Every app's AGENTS.md references
this file — multi-app rules (bus naming, launch path, addressing, onboarding,
shared modules) apply to every app. New sessions: read this + the app's
AGENTS.md before touching anything.

## Layout

```text
<repo>/
├── package.json     workspaces: ["apps/*"] (every app is an @apps/<app> workspace
│                    package; common/ is NOT a workspace — plain dir, imported
│                    via the @common alias; devDeps biome+typescript only, ags/gnim
│                    stay as manual node_modules shims)
├── tsconfig.json    base compilerOptions (strict, Bundler, jsxImportSource:ags/gtk4)
│                    + paths @apps/* → ./apps/* and @common/* → ./common/* (the
│                    two repo-root import aliases; the bundler resolves the same)
├── env.d.ts         ambient decls (ONE copy — module CSS, inline, gi://AstalWp)
├── typing-fixes.d.ts  GI typing augmentations (type-only)
├── node_modules/    ags+gnim shims → /usr/share/ags/js (manual, re-created by
│                    setup.sh AFTER npm install — npm prunes undeclared links)
│                    + npm workspace links @apps/*
├── common/          cross-app infrastructure — NOT a workspace, plain dir; imported
│                    via the @common/* alias (tsconfig paths — see below), never
│                    relative up-walks
├── @girs/           ONE set of GI typings, regenerated by `ags types` at root
├── setup.sh         bootstrap script (packages, npm install, girs, units, root steps — see below)
├── systemd/         canonical unit TEMPLATES (setup.sh substitutes __TREE__
│                    with the tree's install location, __HOME__ with the home)
├── (config trios live per-app: apps/dock/config.*, apps/launcher/config.*, …)
│                    — each surface owns its schema-driven trio (see below)
└── apps/            the apps — every app is an @apps/<app> workspace package here
    (no shell/ app dir — the shell is a PRESET of the universal bundle,
     TINSHELL_HOST_SET=shell)
    ├── dock/        dock surface (io.Astal.dock) — REAL app
    ├── launcher/    launcher surface (io.Astal.launcher) — REAL app
    ├── notifications/  notifications surface (io.Astal.notifications) — REAL app
    ├── keyboard/    on-screen keyboard (io.Astal.keyboard) — REAL app, config-gated
    ├── clipboard/   clipboard picker (io.Astal.clipboard) — REAL app
    ├── promptd/     the prompt/input dialog service
    ├── media/       media player + inline image viewer (io.Astal.media)
    ├── portal/      xdg-desktop-portal FileChooser backend (io.Astal.portal)
    ├── polkit/      polkit AuthenticationAgent (io.Astal.polkit)
    ├── annotate/    screenshot annotation editor (io.Astal.annotate)
    ├── notes/       floating desktop notes (io.Astal.notes)
    ├── files/       files browser (io.Astal.files)
    └── greeter/     greetd login/lock screens (boot-level, SEPARATE user+compositor —
                     NEVER part of shell; an island forever)
```

## Apps

| App | Sources | Instance / bus | Unit | Spec |
| ----- | ----- | ---------------- | ------ | ------ |
| Shell (ALL apps, production) | — (preset; no own sources, universal bundle) | `shell` (`io.Astal.shell`) | `tinshell-shell.service` (ENABLED) | this file |
| Dock | `dock/` (surface, applet manifest, commands, config, screengrab, utils) | inside shell; island `dock` (`io.Astal.dock`) | none (dev) | `dock/AGENTS.md` |
| Launcher | `launcher/` (sources, combiner) | inside shell; island `launcher` (`io.Astal.launcher`) | none (dev) | `launcher/AGENTS.md` |
| Notifications | `notifications/` (Centre, Popups, Notifd) | inside shell; island `notifications` (`io.Astal.notifications`) | none (dev) | `notifications/AGENTS.md` |
| Keyboard | `keyboard/` (windows, keys, layouts) | inside shell; island `keyboard` (`io.Astal.keyboard`) | none (dev) | `keyboard/AGENTS.md` |
| Clipboard | `clipboard/` (capture, Picker, store) | inside shell; island `clipboard` (`io.Astal.clipboard`) | none (dev) | `clipboard/AGENTS.md` |
| Promptd | `promptd/` | inside shell; island `promptd` (`io.Astal.promptd`) | `tinshell-promptd.service` (DEV) | `promptd/AGENTS.md` |
| Portal | `portal/` | inside shell (owns impl name `org.freedesktop.impl.portal.desktop.tinshell-portal`); island `portal` (`io.Astal.portal`) | `tinshell-portal.service` (DEV) | `portal/AGENTS.md` |
| Polkit | `polkit/` | inside shell; island `polkit` (`io.Astal.polkit`) | `tinshell-polkit.service` (DEV) | `polkit/AGENTS.md` |
| Notes | `notes/` | inside shell; island `notes` (`io.Astal.notes`) — on-demand desktop app; LAZY in shell (load on first request, unload after 60s grace) | none — by design | `notes/AGENTS.md` |
| Files | `files/` | inside shell; island `files` (`io.Astal.files`) — on-demand desktop app; LAZY in shell | none — by design | `files/AGENTS.md` |
| Annotate | `annotate/` | inside shell; island `annotate` (`io.Astal.annotate`) — on-demand desktop app; LAZY in shell | none — by design | `annotate/AGENTS.md` |
| Media | `media/` | inside shell; island `media` (`io.Astal.media`) — on-demand desktop app; LAZY in shell, MULTI-INSTANCE (one window per pipeline; stills render inline as a viewer, MPRIS routed to the active transport instance) | none — by design | `media/AGENTS.md` |
| Greeter | `greeter/` | boot-level: greetd spawns it pre-login as user `greeter` in a minimal Hyprland compositor on VT 1 | none (boot-level by design) | `greeter/AGENTS.md` |

Window namespaces are UNCHANGED (`dock-.*`, `launcher`, `notifications-.*`,
`keyboard-.*`, `clipboard-picker`, plus the desktop apps' float rules) —
Hyprland blur/float layerrules still match.

## Shared config (the five surfaces)

Each shell surface owns its OWN schema-driven trio in its app dir
(`apps/dock/config.{defaults,schema,json}`, `apps/launcher/config.*`, …).
The SCHEMA is authored as TypeBox in
`apps/<app>/config.schema.ts` (builder helpers `common/config/schema-build.ts`,
devDep typebox) and `config.schema.json` is a GENERATED artifact — edit the
.ts, never the .json; regenerate via `npm run gen:schemas` (or `npm run
check:schemas` to verify staleness). The per-app `Config` TS type derives from
`Static<typeof schema>`. Every app OWNS its config store: its
`config.ts` calls `createConfigStore(appConfigDir(name))` and exposes the store
through `common/config/facade.ts` (stable mirror +
get/set/applyToLive/queueWrite/onConfigChanged). No module knows the surface
list;
cross-surface reads import the owning app (`@apps/keyboard/config` for
`keyboardEnabled()`). In shell five
stores coexist in one process — each writes its own config file atomically;
cross-surface writes are not one file transaction (writes are rare +
user-driven). In dev, each island loads only its own store (+ any app it
imports, e.g. the dock island pulls the keyboard store for the Keyboard
applet gate). The OTHER apps (notes/files/…) keep their own per-app trios the
same way.

## Command surface (request paths)

Every app's commands are registered PREFIXED with the app name, so the
process-global registry never collides (files `open` vs media `open`):
`notes ping`, `files open <path>`, `promptd askpass <b64>`, `polkit status`,
`media toggle`, `annotate save`, and the five surfaces `dock …`,
`launcher …`, `notifications …`, `keyboard …`, `clipboard …`. The prefix is
applied in BOTH modes — islands serve `ags -i notes request "notes open foo"`
too.

## The `common/` package

`common/` is the cross-app infrastructure dir. It is NOT an npm workspace and has NO
node_modules link — code imports it through the **`@common/` path alias**
(`@common/app/start`, `@common/log/logger`, …): `@common/* → ./common/*` in
tsconfig `paths`, and the bundler honours tsconfig paths, so the alias
resolves from ANY depth (apps at `apps/<app>/deep/…` and common-internal
sibling imports alike). Relative `../../../common/...` up-walks are never
used. Exception: `apps/*/config.schema.ts` keep
relative `../../common/…` imports — those modules run
under the plain-Node schema generator (`npm run gen:schemas`), which has no
tsconfig-paths mapping.
`common/shell/` holds the shared shell scripts (tinshell-host.sh distributor,
tinshell-boot.sh boot orchestrator, run.sh bundler, tinshell-route.sh
router, unit helpers); apps import each other as `@apps/<app>/...` (npm
workspace links):

| Module | Purpose |
| -------- | --------- |
| `common/app/start` | `createApp({ instanceName, css, main, onQuit? })` — wraps
`app.start`, wires the request dispatcher + normalizer + the lazy-app request
pre-step. The `<instanceName> quit` request command is registered for EVERY
instance unless the app already owns that path with its own handler (the
dock's fading `dock quit`) — `tinshell-host stop`, and therefore the whole
mode-switch path (`tinshell-mode shell`, `restart-shell.sh`, tinshell-host's shim
retirement), stops an instance by sending `<instance> quit`, so an instance
without it is UNSTOPPABLE. `onQuit` is optional and only adds teardown to
that command (reply `quitting` →
teardown on an idle callback → `app.quit()`): the shim's quit
(`App.quit` → `g_application_quit` → `exit(code)`) hard-exits before
GApplication emits `::shutdown` and the shim holds the application so a
last-window close never shuts it down either — the request surface is the
quit path |
| `common/app/lazy` | the on-demand loader: `registerLazyApp` / `ensureLoaded` / `scheduleUnload` / `unloadNow` / `unloadAll` / `restoreLoadedApps` (host-start restore: PER-OWNER XDG_RUNTIME_DIR loaded-set memory — the shell keeps `lazy-loaded.json`, every other resident instance `lazy-loaded-<instance>.json` — UNION each app's durable `restoreIf` signal as backstop: unconditional in the shell, in a resident island only when that island's own memory file is absent — notes reopens off its durable state file even when the runtime loaded-set is missing. `restoreIf` reads GLOBAL app state, so every restore candidate must take an exactly-once `restore-claim-<app>` (exclusive create, owner instance + pid; dead-pid reclaim, released on genuine unload, dropped on failed load) — without it every resident instance booting with no memory file mounts its own copy of the same note. Crash-loop guard drops an app after two consecutive restore failures); per-app CSS via a `Gtk.CssProvider` on `Gdk.Display` (`applyAppCss`: applied once per app and never removed while the process lives — the host entry reuses it for an in-set lazy member the loader never sees). Wired in the shell AND every resident island (`registerLazyApps(lazyNotInSet)` in the universal entry — a resident island lazy-loads not-in-set apps on first routed request); a pure-lazy singleton island registers nothing, and every registered lazy app answers `<app> quit` with an unload (tear the app down, keep the host process alive). `lazy status` request = side-effect-free loaded-apps probe (status tooling) |
| `common/app/mode` | `isShell` — true when `TINSHELL_SHELL=1` (set by tinshell-host.sh for every eager-member instance: shell AND resident islands; pure-lazy singletons unset it); gates quit-on-close. `isProductionShell` — true only when `TINSHELL_HOST_INSTANCE=shell`; gates per-app log sinks (the shell owns the one global sink) |
| `common/app/request` | `normalizeRequestArgv(argv)` — request-token normalization (shared by every app) |
| `common/commands/registry` | `register(path, handler)` / `ensureNamespace(path)` (handler-less pre-declaration for lazy prefixes) / `has(path)` (is a HANDLER registered there — namespace stubs do not count; lets `createApp` leave an app's own `<instance> quit` in place) / `dispatch(tokens, res)` — hierarchical command trie |
| `common/config/loader` | `createConfigStore(dir)` — schema-driven three-file (defaults+schema+live) loader: atomic reload, dotted get/set, deepMerge, serialized write chain, `onConfigChanged`, tier metadata. `setDottedPath(root, path, value)` — the ONE dotted-path setter (creates intermediate objects, `false` when an intermediate is a non-object): `setLive` walks the live tree through it, and so does the dock's detached-clone batch commit (`apps/dock/config-clone.ts` — `safeClone`, the detached copy the dock stages before `dock.queueWrite`, shared by the move-mode snap persist and the `config set|update` batch commit). Also `appConfigDir(name)` → `apps/<name>` |
| `common/config/facade` | `createConfigFacade(store)` — the app-facing store wrapper (stable `config` mirror, filtered onConfigChanged, validated set/applyToLive/reload). Every app's `config.ts` owns its store; no module knows the surface list |
| `common/config/app-store` | `createAppStore(appName, opts?)` — per-app config facade over `createConfigStore` (dir `apps/<name>`): get/all/set (schema-checked, `{ok,error}`)/reloadConfig; `opts.onReject` overrides the rejection sink (media logs via `common/log/logger`). Non-surface apps' `config.ts` are thin re-exports of one instance |
| `common/config/schema-build` | TypeBox schema-builder adapter for `config.schema.ts` sources (obj/openObj/mapOf/arr/enumOf, `Type`/`Static` re-export). DevDep typebox; never bundled into app runtime (config.ts imports the derived type type-only) |
| `scripts/gen-config-schemas.ts` | schema generator: imports every `apps/<app>/config.schema.ts`, prunes loader-unreadable keys, merges the `tiers` sidecar as `x-tier`, emits `config.schema.json` (npm `gen:schemas`) or verifies staleness (`check:schemas`) |
| `scripts/artifacts.sh` | THE artifact registry (`npm run build:all` / `check:builds` both read it): one row per shipped artifact — universal bundle, every app's bundle cache, the greeter login bundle, the lock bundle, the deployed `/etc/greetd/tinshell-greeter.sh` — with its source app, output path, stamp sidecar and kind (cache \| dist \| deployed). Locates the store through `bundle_store_dir` (`ARTIFACTS_CACHE`) — the same call the bundler writes through, never a second spelling of the path |
| `scripts/build-all.sh` | `npm run build:all` — builds every artifact through the ONE bundler (`tinshell-host.sh warm shell`, `run.sh <app>`, `apps/greeter/build.sh`, `build-lock.sh`), each under a hard `timeout`; an artifact already built from the current sources is a no-op. Prints artifact → source fingerprint → destination plus the store it wrote to, and records the same-run receipt (`TINSHELL_BUILD_RECEIPT`) for the boot warm. Never escalates: the `/etc/greetd` deploy stays `apps/greeter/install.sh` under root |
| `scripts/check-builds.sh` | `npm run check:builds` — the freshness gate: re-derives each artifact's fingerprint from the current sources and exits non-zero naming every stale artifact AND every changed/added/removed source, in a verdict that also names the store it read and the REASON (`STALE` moved inputs, `payload` a payload replaced after its build, `unbuilt`/`missing` no artifact in this store at all) and prints the same-run verified count before the verdict. Honours a build's same-run receipt only while the tree it built from still matches. `--quiet` = no table (the boot freshness probe); store, per-artifact reason and summary still print |
| `common/commands/config-commands` | `registerConfigCommands(prefix, api, opts?)` — the standard `<prefix> config get\|set\|reload\|all` handlers (`all` only when `api.all` given) + canonical `coerceValue` + `createArrayAwareCoerce(get)`, the ONE coercion for paths whose value is an array (a JSON array argument parses, anything else falls back to the raw string; every other path delegates to `coerceValue`) — keyboard and notifications pass it as `opts.coerce`; unified replies (`error: usage: …`, `error: unknown path: …`, JSON values, `reloaded`); `opts.onSet(path)` hook for post-set side effects (files' live-tier refresh) |
| `common/log/logger` | `log(msg)` / `logTo(path, msg)` — pluggable sink (`fileSink` per app, stderr default) |
| `common/log/debug-log` | sets the ONE shell-process sink (file /tmp/tinshell-debug.log, no prefix — surfaces add their own tags) |
| `common/window/popup-dismiss` | shared popup dismissal (Escape / click-outside / focus-loss) — launcher + clipboard picker |
| `common/card/*` | the card substrate every card app is built on. `frame.ts` — `createCardFrame({ app, appId, title, defaultWidth, defaultHeight, modal?, header?, keys? })` → `{ win, root, present, close, setTitle }`: the card toplevel itself (a plain XDG `Gtk.Window`, no titlebar, 520x360 minimum, the app CSS class, the appId override, `app.add_window`) plus the vertical root, the header slot and the window key backstop. `header.ts` — the header primitives (`GLYPH` MDI codepoint map, `headerBox`, `glyphButton` with the ink-measured optical centring, `headerButton`) and `createCardHeader({ spacing?, leading?, title?, trailing? })`, the declarative header row. `path-bar.tsx` — `createCardPathBar({ onNavigate, onCommit })` → `{ widget, setPath, beginEdit, endEdit }`, the segmented horizontally scrolling path bar: breadcrumb buttons by default, and an edit mode that swaps the same row for a `Gtk.Entry` (`beginEdit` from the host's Ctrl+L binding or a click on the bar's empty tail right of the last segment, Return through `onCommit`, Escape out, the breadcrumbs for the current path back on the way out) — the edit entry carries the shared path type-ahead (`createPathAutofill` gated on `isPathShaped`: Tab / Shift+Tab cycle the completion as a selection, a `*`/`?` last segment previews that directory's matches). `status-bar.tsx` — `createCardStatusBar()` → `{ widget, setText }`, the `card-statusbar` line. `keys.ts` — `installCardKeys(win, { escape?, bindings })`, the window-level `Gtk.EventControllerKey` backstop with tri-state modifier matching. `app-css.ts` — `cardAppCss({ app, style, appearance, extra? })` + `cardPalette(appearance)`: the whole mount-time CSS assembly and the derived ink tokens. `dir-list.ts` — `createCardDirList({ cssPrefix, rowType, name, meta, compare, onActivate, onOrderChanged, onSelectionChanged, status, cells?, hiddenButton, visibleColumns?, nav })` → `{ view, selection, area, status, setRows, rows, selected, updateStatus, setFreeSpace, setHiddenVisual, navigate, back, forward, canGoBack, canGoForward, up, commitTypedPath, dispose }`, the DIRECTORY-LISTING scaffold of a card window in one parameterized factory: the ColumnView over a Gio.ListStore behind one SingleSelection, the scroller + empty-state label in a list area, the icon+name and meta cell factories, the per-column sorters and the header-click read-back, the status/error line, the hidden-entries toggle's glyph pair (`HIDDEN_TOGGLE`) and the navigation history; the host supplies its row class, its columns' glyphs and text, its order policy (`compare`), what a row activation does, where a directory is shown (`nav`) and its own per-cell visuals (`cells`, portal's multi-pick) — files and portal both build their listings through it. `chrome-override.ts` — `applyChromeOverride(app, css)`: the app's chrome-override provider at `STYLE_PROVIDER_PRIORITY_USER`, added once per app per process and never removed (GTK compares provider priority before specificity, so a rule that must out-rank the shared `card-chrome` cannot live in an app sheet; files' and annotate's denser headers use it). Files and portal build their listings through `createCardDirList`; files, portal, annotate and images all build their windows through `createCardFrame` |
| `common/window/app-id` | `setAppId(win, id)` — set a window's Wayland app_id, so a card window hosted inside the shell instance still matches its own Hyprland window rule |
| `common/session` | `runSessionTransition(kind, action)` — the frosted full-screen announcement of a session transition (“Locking...” / “Logging out...”), raised by the session-side power path (`common/applets/domains/power.ts`, the `lock` and `logout` cases) BEFORE the action it announces, so the scrim covers the logind → hypridle → lock-bundle handover (the ext-session-lock surface then renders above every layer surface). INPUT IS BLOCKED for its whole life: one layer-shell OVERLAY window per monitor, anchored on all four edges, keymode EXCLUSIVE plus an input region that is never narrowed — the compositor hands an exclusive-interactivity layer surface every key and a full-screen surface with a full input region swallows every pointer event over its monitor, so no keystroke and no click reaches the window behind; the FROST is the compositor's (the `session-overlay` namespace carries a Hyprland blur layer rule — app CSS only tints the glass and sizes the label). ORDERING is map + one frame-clock tick (the compositor asks for frames only of mapped surfaces), never a sleep. DISMISSAL is bounded: a thrown action or a non-zero exit dismisses at once (`common/subprocess/run` with a checked exit — a bare spawn would report nothing), a `lock` poll on `hyprctl -j locked` dismisses the moment the lock surface is up (a scrim left mapped through a locked session would be revealed again by the unlock), and a 20s linger bounds the whole transition, so an action that never took the session away cannot strand an input-blocking scrim over the desktop. No module-scope state: each transition owns its windows and timers |
| `common/subprocess/run` | `run(argv, opts)` (Promise) + `runCb(cmd, cb, timeoutMs)` (callback/shell) + `spawnDetached` — non-blocking Gio.Subprocess runner; `common/subprocess/quote` (`shq` — single-quote a string for a `bash -c` command) |
| `common/applets/*` | the applet machinery every applet host shares: `shared/` (`create-applet-core` — the AppletWindow binding core: draw/layout/panel/hover state machine; `create-continuous-applet` / `create-step-applet` factories; `draw-utils` — disc/glyph/ring cairo primitives; `elapsed` — `formatElapsed`, the ONE elapsed seconds→text formatter (the power applet's uptime face and the battery applet's fully-charged counter both read through it); `battery-colour` — `batteryRingColour` + `isPluggedIdle`, the ONE battery colour policy and the ONE spelling of the plugged-and-idle state: charging while sysfs status reads Charging, `plugged` while AC is present with the pack neither filling nor draining (status `Full` or `Not charging`), else the level's warn / low / ok from `appearance.ringColours.battery` + `appearance.thresholds` — the applet's ring, the clock's charge notches and the counter all consult it), `types.ts` (the applet type surface: `AppletMount`, `DrawIcon`, `Panel`, `PanelHandle`, `Dial`, power/TLP unions), `layout.ts` (dock geometry: position string → `DockGeometry`, the single auditable directionality core), `panel-hub.ts` (panel open/close hub shared with applets/commands), `backdrop.ts` (the stadium backdrop painter), `panel-framework.tsx` (the continuous-slider + step-selector panels: pill growth, drag, corner-cancel, panel escape), `utils/` (UI-only helpers: `row-region` — the CAPTURE REGION of the shared surface: one shape list (discs / panel stadiums / the row band) compiled into BOTH the wl_surface input region and the router's point test, every stadium oriented through the geometry's axis pair (`CaptureAxes` = row/grow → real surface x/y, so a left/right dock lays its band and panels along the vertical axis; `row-region.probe.ts` asserts the boxes at all 12 positions), `appear`/`smoother` — frame + animation helpers (`runFrames` lives in `common/anim/run-frames`), `drag` — dial accumulator, `reactive` — value container, `geo-log`), `store-paths.ts` (`storeFilePath(domain, store)` + `CHARGE_CAP_FILE` — the ONE mapping from an applet store to the durable file it lives in, shared by the domains that write it and the client that reads it), `tablet-panel-close.ts` (`startTabletPanelClose({ tablet, closeMs })` — the host-owned tablet-mode auto-close: while tablet mode is on and a panel is open, a `timing.tabletCloseMs` timer simulates a cursor-leave across every applet window, re-arming while a guard keeps the panel open). Consumed by the applet mounts in `common/applets/<key>/` and by every host; the machinery reads host config through `common/applets/config` and OS calls through `common/applets/backend` |
| `common/applets/surface/` | the SHARED applet ROW renderer — ONE renderer for every applet host, substrate-free and host-agnostic (the live config arrives as a parameter). `surface.ts` = `createAppletSurface({ geometry, config, host })`: the entry table (icon/overlay/panelOh/regionOh/hidden/suppressed/slot), the segmented pill-backdrop paint (base glass + the lift, holes at every resting disc, never under an open panel), the row band engine (computeBand/`provisionSlot` eager-extend / `settle` lazy-shrink / `collapseToSlot` + `setBandFrozen` for move mode), the input region/capture build (`compileCaptureRegion` over the disc + panel-stadium + (host-opted) row-band shapes — ONE compilation serving the substrate's wl_surface region and the router's capture test) and the geometric pointer router (enter/leave/motion/press, capture lock, open-suppression grace, pending-enter promotion, indicator latching, stale-hover re-evaluation on settle). `host.ts` = `AppletSurfaceHost`, the ONLY substrate seam: mount the row widget, extent/row-start application, input region application, the `captureBand` model, bounds, the pointer source, host repaint. `applet.ts` = `createSurfaceApplet(surface, name)`, the ONE per-applet binding factory (icon + surface entry + panel attach/detach + hidden/parked visuals + birth intro) over the shared `createAppletBinding` state machine. The dock mounts it on its layer-shell band (`apps/dock/DockSurface.tsx` = the substrate), the greeter strip on its embedded container |
| `common/applets/render-state.ts` | the per-applet render state: ONE plain object per binding (`AppletWindow.render`), written by the applet core, the appear animation, the open panel and the host row; the icon's draw trampoline reads it. Unset fields stay `undefined` so each reader's `?? fallback` keeps its own resting value |
| `common/applets/applet-window.ts` | the applet-facing binding contract: the `AppletWindow<TRow>` interface, `AppletRowLike`, `AppletGeometry` and the substrate-independent state machine (`createAppletBinding`: open/teardown/hidden flags, appear channel, can-target seeding, attach/detach orchestration). Its surface-backed `AppletBindingPort` implementation (`common/applets/surface/applet.ts`) is the ONE implementation — the dock and the greeter strip both build their per-applet bindings with it |
| `common/applets/<key>/` | one directory per applet, named after the applet's config/manifest KEY (`battery`, `lockSession`, `screengrab`, `wifi`, …) — lowercase, like every other directory under `common/`: `index.ts` plus `menu.tsx` for the applet's own GUI and `commands.ts` for its request surface (an applet may keep its own modules beside them — `wifi/scan-bridge.ts` decouples the wifi menu's scan state from the applet's scan glyph, `battery/charge-counter.ts` owns the fully-charged counter the battery glyph paints, `battery/threshold-store.probe.ts` probes its charge-cap store — and a `.probe.ts` beside a module is that module's runnable probe). `index.ts`'s DEFAULT export is the applet's mount — `export default function mount(ctx: AppletContext): void` (type `AppletMount`) — called with the host's context (`port`, `hooks`, `config`, `store`, `backend`); the path names the applet, the export names the operation, and each host aliases the import where it needs the distinction (`import mountBattery from "@common/applets/battery"`). Every piece of per-instance state lives in the closure mount creates, so one module serves the dock and the greeter independently |
| `common/applets/config` | the applet config contract: the `AppletConfig` type re-export and `AppletConfigSource` (the `store` member of `AppletContext` — a `ConfigFacade` satisfies it directly: `config` is its live mirror, plus `onConfigChanged` / `applyToLive` / `getDefaults` / `queueWrite` for the applet settings menus). Each host supplies its own source in the mount context; there is no bound global |
| `common/applets/config.schema` | the applet-facing schema slice (`layout`, `fonts`, `timing`, `appearance`, `screengrab`) + the `AppletConfig` type; `apps/dock/config.schema.ts` composes it, so the dock keeps owning the generated `config.schema.json` |
| `common/applets/backend` | the OS-call contract: `AppletBackend` (one domain per service: battery, wifi, mpris, screengrab, …). Each host supplies the domains its applets call in the mount context; the domains are the `common/applets/domains/*` modules (type-only imports bridge their signatures), plus the dock-owned screengrab domains — with ONE exception: `volume` is an OPTIONAL domain, because it is session bound (the greeter binds it in process for the lock screen, whose bundle runs as the session user, and a process with no session would report no sink rather than a reading) |
| `common/applets/host/` | the applets BACKEND, hosted by the dock (`apps/dock/mount.ts` → `mountAppletsBackend`): `mount.ts` registers one handler per domain under the `applets` namespace and brings up the socket, the tablet watchdog and the persisted sleep inhibit; `in-process.ts` = `createInProcessBackend()`, the binder the dock's own applets read the 17 domain namespaces through; `transport.ts` derives the member table + invocation rules from the domain modules; `socket-server.ts` serves those same members over `/run/tinshell/applets.sock` (same envelope, `<id>`-correlated lines) with the read/owner traffic policy (`fs` unreachable for every peer, store writes and mutators owner-only, unknown member tokens fail closed). The dock adds its two capture domains (`apps/dock/screengrab`) to the binder in `apps/dock/applets.ts`. Process-bound state (logind inhibit fd, D-Bus subscriptions, the tablet helper child) lives and dies with the dock process |
| `common/applets/backend-client` | the transport proxy for a host that does NOT own the backend: `createAppletBackendClient()` returns the same `AppletBackend` shape (minus the dock-owned capture domains and the OPTIONAL session-bound `volume` domain) backed by the router (`tinshell-route.sh applets …` — the dock hosts the namespace, so no instance name can be assumed). Promise members are transported per call, reactive members are fed by a client-side poll on the CALLER's interval, sync members answer a memoized/refreshed value, callback members poll the matching snapshot; a host that cannot reach the backend gets the documented placeholder AND a log line (never a silent zero). `createAppletBackendClient({ transport, storeRead })` swaps the transport and how store members read; the greeter uses the socket transport + `storeRead: "transport"` for the session domains it needs (`mpris`, `mediaWindow`), binding its own read domains in process (`apps/greeter/strip/backend.ts`); `backend-client.probe.ts` is its probe |
| `common/applets/backend-protocol` | the wire format of the `applets` request surface, shared by the backend (`common/applets/host/`) and the client: the line syntax, the `base64(JSON)` argument codec and the reply envelope (`{ok:true,value}` / `{ok:false,error:{kind,message}}`). `APPLETS_NAMESPACE` is the request namespace, not an instance name |
| `common/applets/socket-protocol` | the line grammar of the backend's SECOND surface, the unix socket a different-user client needs: `<id> hello <proto>` / `<id> applets <domain> <member> <b64arg>…` in, `<id> <envelope>` back, plus the socket path (`/run/tinshell/applets.sock`, `TINSHELL_APPLETS_SOCKET` override), the proto version and the byte bound. Same envelope, same argument codec — the `<id>` is the one addition (a stream carries several polls at once) |
| `common/applets/backend-socket-client` | `createSocketBackendTransport()` — the client half of that surface: async connect + `hello` handshake (a proto mismatch degrades instead of guessing), `<id>` correlation, one serialized write chain, a bounded retry window while down, and `onStateChange(up)` so a host gates its surfaces on a VERIFIED transport |
| `common/applets/hooks` | `AppletHooks` — the host-policy surface an applet calls instead of reaching into a host row: park/restore, deactivate, attention, dock visibility. The dock implements it over its DockRow (`apps/dock/applet-hooks.ts`); the greeter implements the two it needs and no-ops the rest |
| `common/menus/*` | the centred-menu shell every applet GUI builds on (`menu-framework.tsx`: one layer-shell window per open menu, single-open hub, row builders, scrim, the row-width closure `attachRowWidth` each row builder hands the panel sizer, and `createBusyWatchdog` — the failsafe that clears a row's busy latch when its backend action hangs; `spinner.tsx`: the loading glyph). Applet menus live with their applet (`common/applets/<key>/menu.tsx`) |
| `common/path/autofill` | `createPathAutofill({ extract })` — blind Tab-cycling path completion over `common/path/complete` (`completePath`/`expandPath`/`isPathShaped`; a `*`/`?` pattern in the last segment is answered by `isGlobQuery`/`globPath` — newest-first matches of that one directory, capped, prefix queries unchanged); the launcher's `!p`/`!a`/`!code` bangs, promptd's `input` dialog (and its form fields), the dock's screengrab save-location row and the card path bar's Ctrl+L entry (`common/card/path-bar`) all wire it, each with its own UI. `isPathShaped` is the ONE path-shape rule they gate on. The `!p`/`!a` bangs' DISPATCH resolves their argument through the same `expandPath`/`globPath` — `pathTargets(query, opts)` (`launcher/sources/bangs.ts`) is that ONE resolution rule, and `refusalRow(verb, query, error)` the single refusal row both bangs show when it resolves to nothing, while `launcher/sources/xdg-row.ts`'s `xdgOpenRow({ target, tag, description, icon, category })` is the ONE `Open — <target>` row they both spawn through (`xdg-open` argv, spawn budget, tagged non-zero-exit log line, hide-after-opening) — so the rows they offer and their Tab cycle cannot disagree about a path (`!p` takes any media kind or a URL, `!a` keeps only still images; `!code` merely expands its argument with `expandPath`). See `launcher/AGENTS.md` §Bangs |
| `common/text` | `fuzzyScore(query, text)` / `rank(items, scoreOf)` — the ONE subsequence matcher with scoring (prefix / contiguous-run / word-boundary / early-hit bonuses); the launcher's app search and its emoji mode both rank through it |
| `common/emoji/*` | the surface-agnostic emoji layer: `data.ts` (the table), `search.ts` (`searchEntries`/`recentEntries`/`topEntries`), `recency.ts` (the usage store at `~/.local/state/tinshell/apps/emoji/state.json` — the ONLY access to it), `insert-plan.ts` + `insert-plan.probe.ts` (the pure insertion ladder + its probe), `insert.ts` (the runtime glue: target capture, post-hide scheduling, guarded clipboard restore). Reads NO config — the surface that owns the store passes `InsertSettings`. The launcher's emoji mode is its only surface today |
| `common/media/*` | the ONE owner of "decode a file and show or play it": `classify.ts` — `mediaKind(path)` → `image \| animated-image \| audio \| video \| other` (one extension table whose image set is the VERIFIED-decodable one) + `isStillImage(path)` for the display gate; `decode.ts` — `loadStill(path)` → `{ path, texture, width, height, surface() }`, the `Cairo.ImageSurface` built lazily through a temp PNG (never `Gdk.Texture.download()`, which returns without throwing and silently yields an empty surface); `paintable.ts` — `NullIntrinsicPaintable`, the zero-intrinsic-size wrapper a bound media paintable needs so its picture never resizes the toplevel after map; `pipeline.ts` — `createMediaPipeline({ pollIntervalMs })` → a self-contained playbin3 instance (queue + event bridge + position poll; `Gst.init` behind the first play, never at module scope); `details.ts` — `fileDetails(path, kind, still?)` → ordered `{label, value}` rows for the pane's detail block (size, modified and content type from one `query_info`, plus dimensions/megapixels for a decoded still and a per-kind note); pure and GTK-free, never throws — an unreadable item yields the rows the kind alone can state, and there is no pipeline, so no duration or codec; `divider.ts` — `attachPaneDivider({ paned, pane, display, session })` → the host's detach, the shared wiring of a host's `Gtk.Paned` divider to the shared preview width: it seeds the divider from the stored width (on the display's `map`, and whenever the pane comes back on screen), judges a drag on EVERY position change rather than only on the settled one — a drag under the pane's floor is HELD at it (`PREVIEW_MIN_WIDTH`: the position stops at the pane's own edge, so the pane keeps the floor's slot whatever the pointer does past it), and only a drag asking for less than `PREVIEW_SNAP_SHUT_WIDTH` folds the pane shut (the window's switch turns OFF, and no width is written) — stores the side-slot width from a drag that settles at or above the floor (a settled allocation still under the floor folds the same way, as the window that cannot host the pane), and reserves the paned's handle strip out of the list side (`divider.probe.ts` is its probe); `pane.tsx` — `createMediaPane({ appearance, mode, onOpen })` → `{ widget, setItem, setLayout, dispose }`, the shared preview surface (a still rendered inline and top-aligned, its file details below it, a kind glyph + an explicit open action for everything it does not render) that follows a selection through `setItem(path)`; `preview.ts` — the ONE preview preference shared by every pane host: `previewSettings()` / `previewEnabled()` / `setPreviewEnabled` / `setPreviewMode` / `setPreviewWidth` / `togglePreview` / `onPreviewChanged`, persisted in its OWN `createStateStore` state store (app id `media-preview` → `~/.local/state/tinshell/apps/media-preview/state.json`, never a host's config), OFF when nothing is stored, with a per-process `Gio.FileMonitor` on that file so a flip in one process reaches the subscribers of another. The stored `enabled` value is the LAST APPLIED setting, NOT a live broadcast: `createPreviewSession()` is ONE HOST WINDOW's switch (`enabled` / `setEnabled(enabled, remember?)` / `toggle` / `subscribe` / `dispose`), seeded from that value and writing a flip back as the memory a NEW window starts from, so a flip in one window never moves another open window's pane — `mode` and `width` stay shared (the divider's drag writes the one side-slot width), and `PREVIEW_MIN_WIDTH` is the pane's firm floor — the lower bound a STORED width must satisfy (`setPreviewWidth` rejects anything under it) and the width the shared divider holds a DRAG to — while `PREVIEW_SNAP_SHUT_WIDTH` is the drag-time-only width a drag has to travel under before the pane folds shut; `types.ts` — `MediaKind`, `StillImage` and the transport contract (`MediaPipeline`, `MediaEvent`, `MediaStatus`, `PlaylistEntry`). No window, no MPRIS and no config: the consumer supplies the poll period, the geometry/ink and owns its chrome and identity. The pane is SURFACE-ONLY — it claims no MPRIS identity, starts no playback and holds no pipeline, so a video the user merely arrowed past cannot take the transport or the speakers — and every paintable it binds is wrapped in `NullIntrinsicPaintable`. Consumers: files + images + the launcher's `!a` bang (classify), images + annotate (decode), player (pipeline + paintable), files + portal (pane + divider, reading the shared preview preference) |
| `common/colour` | `hexToRgba(hex)` — config colour → rgba tuple for the Cairo painters |
| `common/css/card-theme` | `cardThemeCss(appearance)` — the shared card-family CSS (dark scrim tokens, `CardThemeAppearance`) |
| `common/css/card-chrome` | `cardChromeCss(appearance)` — the shared card-window chrome: header bar + hairline, `card-btn` / `card-path-btn` / `card-path-entry` / `card-pathscroll` / `card-pathbar` / `card-path` / `card-statusbar` / `card-action` / `card-primary` rules. Every card app emits it, so the family's toolbar language cannot drift (files/AGENTS.md §chrome) |
| `common/css/tokens` | the TS half of the design-token layer — the runtime carrier of a token whose CSS carrier is the `--tinshell-*` custom property in `common/shell/theme.css`, for consumers that read no stylesheet (a Cairo painter, a `Pango.FontDescription`, a config fallback string). `FONT_FAMILY`, `INK`, `INK_MUTED`, `ACCENT`; a token the stylesheet alone can serve (every surface or geometry token below) has no constant here. A token is named for the ROLE the value plays, never for the value: two apps read one role (the suite accent, the muted ink), while a value two sites happen to share can be two different decisions (media's white seek-slider fill is a control fill, not label ink) and stays spelled at the site. Those two files are the only ones allowed to spell a token's value — the audit's `literal-duplicated` class allowlists the pair, so a re-spelling elsewhere is reported |
| `common/anim/run-frames` | `runFrames(widget, step, framerate?)` — per-frame tick callback + timeout fallback + cancel() |
| `common/anim/easings` | `easeQuadInOut` / `easeCubicInOut` / `easeOutCubic` — the shared easing curves; a tween imports the curve it steps by |
| `common/glyph/hover-glyph` | `hoverGlyph({...})` — Cairo glyph with radial-glow hover (colours as plain rgba tuples) |
| `common/glyph/spinner` | `createSpinnerGlyph({...})` — rotating Cairo glyph; ease-back-to-upright optional |
| `common/glyph/password-eye` | `passwordEye({ getEntry, box?, fontSize?, rest?, glowAlpha?, maskedClass?, emojiHidden?, emojiShown?, onToggle? })` → `{ widget, isMasked() }` — the show/hide password toggle: the shared `hoverGlyph` carrying the eye/eye-slash pair and flipping `Gtk.Entry` visibility at click time (promptd's askpass, the greeter's login card, the dock's wifi password entry) |
| `common/hyprland/*` | `dispatch` — `launchPinned(cmd, ws?, float?)` / `focusWorkspace(id)` / `focusWindow(addr)` / `activeWorkspaceId()` / `hyprctlJson(subcmd)`, the Lua-eval hyprctl wrapper (`cmd` is a shell command line: `hl.dsp.exec_cmd` runs it through `sh -c`); `lua-string` — `luaStringLiteral(s)`, the ONE encoder of a runtime string into a Lua short-string literal (double-quoted; escapes `\`, `"` and every control character as `\ddd`) |
| `common/clipboard` | `copy(text)` — GDK4 `set_content` (no `set_text` in GDK4) |
| `common/fs/files` | `ensureDir` / `writeFileAsync` / `writeFileSync` (the synchronous ensure-dir + atomic write owner) (Gio callback idiom) / `resolvePath` (tilde expansion — the shared `expandTilde` primitive of `common/path/complete`) — one impl each; apps re-use instead of re-rolling (`common/fs/bytes.ts` also owns `bytesToUtf8`/`b64encode`) |
| `common/state` | the ONE shared runtime-state store: `createStateStore({ app, version, keys })` — a versioned `state.json` under the XDG state dir `~/.local/state/tinshell/apps/<app>/` (NOT config), in-memory mirror, per-key validation, sync ATOMIC writes (GLib.file_set_contents temp+rename — serialized by construction, no async chain needed for tiny files), sync `reload()` for mount-time freshness + `appStateFilePath(app)` canonical-path helper used by boot restoreIf predicates (registry.ts must not import lazy apps). Unifies the dock row's mode store (`apps/dock/dock-row.ts`), the applet-setting stores in `common/applets/domains/*`, notes' session store and the launcher's emoji recents (`common/emoji/recency.ts`) — ONE state-store implementation across every app |
| `common/local-index/**` | the ON-DISK INDEX for a local key→payload dataset: the format, the read path, the builder, and the SHIPPED artifact. Artifact = the directory `~/.local/share/tinshell/local-index/wordnet-3.0/` (`manifest.json`, `keys.idx`, `rows.dat`, `LICENSE.txt`) — installed read-only data under the XDG data dir, NEVER the bundle store (that store is evictable and holds build artifacts of this tree); no module knows that path (the reader takes a directory as an argument) and no consumer is wired. `format.ts` = the contract: an index DIRECTORY of `manifest.json` + `keys.idx` (sorted keys) + `rows.dat` (payload sidecar), both data files sharing ONE layout (magic, `formatVersion` uint32 LE, entryCount, an `(entryCount + 1) × uint32 LE` offset table, then the blob), keys compared by RAW UTF-8 BYTE ORDER; FORMAT VERSION 2 made the `dataset` descriptor REQUIRED — `keyRule` and `payloadEncoding` are checked against `KNOWN_KEY_RULES` / `KNOWN_PAYLOAD_ENCODINGS` and any other value is refused (a structurally valid artifact built from another corpus, or from this corpus under another key rule, is therefore never served as the installed one), while corpus, release, licence and source url/bytes/sha256 are recorded provenance, shape-checked but never compared — a reader cannot enumerate the corpus releases that exist; `parseManifest` still refuses every other format version instead of guessing (a sha256 proves the bytes, not their shape); `normaliseLemmaKey` is the ONE spelling of the `lemma-lowercase-marker-stripped` rule (case-folded, WordNet's `(a)`/`(p)` markers dropped) and `keyForQuery(dataset, query)` applies the manifest's rule to a query. `encode.ts` = `encodeLocalIndex(entries, dataset, hash, files?)`, the writer half (sorts by the same byte order, rejects duplicate/empty keys, records the caller's descriptor verbatim, hasher injected so the module stays `gi://`-free) + `manifestJson`; encoding is DETERMINISTIC — no timestamp, a total sort — so one input produces byte-identical files and two builds are comparable by hash. `build-wordnet-index.mjs` = the ONE builder for the shipped artifact: `node --experimental-strip-types common/local-index/build-wordnet-index.mjs --source <WordNet-3.0.tar.gz> --out <dir>` REFUSES a source unless its byte length AND sha256 match the pinned pair (11537239 B, `640db279c949a88f61f851dd54ebbb22d003f8b90b85267042ef85a3781d3a52`), performs no network access (the tarball is an input path and the artifact is a function of those bytes), reads the four `dict/data.*` files and `LICENSE` out of the tarball in memory, keys every distinct lemma through `normaliseLemmaKey`, and writes one row per key (one line per sense, gloss and synonyms separated by a TAB, synonyms space-joined and deduplicated, senses in a fixed noun/verb/adjective/adverb order) — refusing a missing member, an unparsable synset line, a tab in a gloss, or a key count other than the corpus's 147,318. `reader.ts` = `openLocalIndex(dir, openSource)` → `{ manifest, lookup(key), stats(), openStreams(), close() }`: binary search at TWO reads per step (one 8-byte offset-table window giving an entry's start AND the next entry's start, then the bytes it addresses) on ONE PERSISTENT TRANSPORT PER FILE — `ByteSource` is the module's only seam (gjs exposes no file API without a `gi://` import, so a host hands in a `Gio.FileInputStream` opener and the probe a `pread` one) and the opener is called only while OPENING, never during a lookup, so the open-per-lookup shape that grows a host's memory cannot reappear. Open checks each file's byte length and its own header against the manifest; the manifest's sha256 belongs to the artifact host's install-time verification, never to the read path. `local-index.probe.mjs` = the probe beside it (JS rather than TS because the root typecheck program deliberately carries no Node types — `scripts/tsconfig.json`: Node's ambient globals shadow the gjs runtime's own declarations; the probe header states the two-part change that restores typed coverage): a generated 147,806-key fixture in the temp dir, every refusal case — the fixture's manifest AND, with `LOCAL_INDEX_PROBE_REAL=<dir>`, the installed artifact's own manifest mutated into an unknown format version / key rule / payload encoding — the no-reopen invariant (opener counted AND cross-checked against `/proc/self/fd`), hit/miss latency at mean/median/p95/worst, and resident growth under sustained lookup load at the artifact's real key count |
| `common/tablet` | shared tablet-mode core: `createTabletWatchdog({ fallback, onEffectiveChange })` (latch state machine, listeners, 500ms enter-debounce — all state in the factory closure), `helperPy(accelDevice)` python helper (long-lived: EVENT mode = evdev read loop when the switch device advertises EV_SW, `poll:<sec>` mode = python-side EVIOCGSW+accel re-read with emit-on-change for devices that can never emit events — one permanent child, NEVER a fresh interpreter per tick), `spawnHelperStream({ device, mode, onLine })` (shared pipe streaming + 1s respawn), `probeSwitchDevice` / `findAccelDevice`. Dock (events-or-poll helper + panel timer, `fallback:"switch-only"`) and keyboard (poll-mode helper, `fallback:"never-enter"`) keep ingestion app-side; each app's watchdog STATE stays in its factory closure, while the ingest child is REFCOUNTED per identical request — two apps in one process share one helper child instead of each spawning its own |
| `common/shell/theme.css` | shared CSS primitives every app imports FIRST: the `--tinshell-*` token block declared on `*`, so every widget carries the value itself (GTK custom properties are inherited and GTK has no document element for a browser's `:root`) — `--tinshell-font-family`, the ink tokens (`--tinshell-ink`, `--tinshell-ink-emphasis`, `--tinshell-ink-muted`, `--tinshell-ink-faint`, `--tinshell-accent`), the surface tokens (`--tinshell-panel`, `--tinshell-wash`, `--tinshell-row-selected`, `--tinshell-hairline`) and the geometry/type tokens (`--tinshell-panel-radius`, `--tinshell-row-radius`, `--tinshell-row-padding`, `--tinshell-font-size-body`). A `var()` resolves across providers, so a per-app sheet added at its own priority consumes them. Then the `entry` base and the thin-pill scrollbar family (white). A token a consumer CSS cannot reach (a Cairo painter, a `Pango.FontDescription`, a config fallback string) has its second carrier in `common/css/tokens` |
| `common/shell/tinshell-bus-wait.sh` | ExecStartPre bus-name-free waiter (parameterized by bus name) |
| `common/shell/tinshell-host.sh` | the ONE distributor — `tinshell-host start\|warm\|stop\|list\|status\|env`; any instance shape (island/combo/shell) from `apps.json` + the universal bundle; applies the session env union + the TINSHELL_SHELL rule to EVERY shape |
| `common/shell/tinshell-boot.sh` | boot orchestrator — `boot` = tinshell-shell.service ExecStart (warm the universal bundle → spawn the shell → probe → wait; the remaining artifact warm (`build-all.sh --quiet`) and the freshness probe run in the BACKGROUND while the shell initialises; the warm and the probe share ONE per-run receipt (`TINSHELL_BUILD_RECEIPT`), removed when the probe returns, and the probe's verdict is relayed in BOTH outcomes; unhealthy → fallback fleet → exit 0, so the unit is never left `active` without a shell in it), `fleet` = the OnFailure oneshot path (manifest unit dispatch, no-double-spawn guard). Every fleet app runs in its OWN unit (manifest `unit`, else an `tinshell-<app>` transient unit) — never a forked child of the boot script |
| `common/shell/notify-failed.sh` | dual-channel failure notice (notify-send + `hyprctl notify`; self-resolves HYPRLAND_INSTANCE_SIGNATURE from `$XDG_RUNTIME_DIR/hypr/`) |
| `common/shell/apps.json` | the app manifest — per app: css/mount/unmount export names, `lazy`, `unit`; single source of truth for tinshell-host/tinshell-mode/boot fleet |
| `common/host/entry.ts` | the static universal entry — set picked at RUNTIME from `TINSHELL_HOST_SET`; eager members imported at TOP LEVEL (portal ownName-before-Gtk-init rule); lazy members registered for on-demand load; a lazy IN-set member (pure-lazy island, combo) mounts through its registry `boot` hook and gets its own stylesheet via the loader's provider mechanism (`applyAppCss`), never through the entry's `cssParts` string |
| `common/host/registry.ts` | the static import map mirroring apps.json (constant specifiers; island boot parity + the quit-path unmount for eager lazy members; per-app `restoreIf` durable boot-restore predicates, e.g. notes' state-file check via `common/state` `appStateFilePath`). Every resolved module is checked by `common/host/registry-exports` — a declared `mount`/`css`/`unmount` name that does not exist logs the named `RegistryExportError` (the app and the missing export(s)) and that app is SKIPPED, instead of silently resolving `undefined` (the request path would otherwise answer `ok` with no window): the instance still boots and every other app works |
| `common/host/registry-exports` | `assertModuleExports(app, decl, mod)` (throws) / `resolveModuleExports(app, decl, mod, log)` (logs and returns null, so the host skips exactly that one app) + the named `RegistryExportError` — the guard that turns a misdeclared `mount`/`css`/`unmount` export name into a named failure instead of a silent `undefined`; pure (no `gi://` imports), so a plain-Node probe can import it (`registry-exports.probe.ts` is its probe) |
| `common/shell/tinshell-route.sh` | the generic request router (see Addressing) |
| `common/shell/route-map.conf` | route-priority + cold-start map for the router (`<app>=<prod>[,<dev>…]`); live routing probes reality beyond the map. An app with no entry (`applets`) is live-scan only: it is never cold-started |
| `common/shell/ensure-launcher-toggle.sh` | mod+Space keybind wrapper → `tinshell-route launcher toggle` |
| `common/shell/ensure-launcher-emoji.sh` | mod+. keybind wrapper → `tinshell-route launcher emoji` |
| `common/shell/ensure-screengrab.sh` | the Print-key handler — routes a region capture into the live instance that hosts the screengrab applet (its Annotate action is an in-process handler, so the capture must run in that process); never cold-starts a bundle, and reports the miss on both channels |
| `common/shell/restart-shell.sh` | mod+SHIFT+B wrapper — restart the live instance (shell or island) |
| `common/shell/tinshell-mode.sh` | mode switcher — `tinshell-mode shell\\|island\\|toggle\\|status`; symlinked to `~/.local/bin/tinshell-mode` by setup.sh. Thin preset layer over tinshell-host: island mode = the long-running set (manifest non-lazy apps) via tinshell-host transient units + promptd/portal/polkit dev units; status table probe-based (per-app host-instance, all hosts listed when multi-hosted) |
| `common/shell/run.sh` | the bundler (`ags bundle` → hashed outfile; `TINSHELL_BUNDLE_WARM=1` = build-only; `TINSHELL_HOST_ENTRY/TINSHELL_HOST_NAME` select the universal host mode). ONLY the boot-fleet fallback + debug path — the launch path is tinshell-host.sh. Every build runs `bundle-guard.sh` first (below); the store and the recorded identity come from `bundle-stamp.sh` (`bundle_store_dir`, `bundle_inputs_capture`), and the per-app CACHE HIT IS the gate's own test (`bundle_stamp_verify` over the recorded fingerprint and the sha256 of the payload) — so a build and `npm run check:builds` cannot disagree about whether an artifact is current |
| `common/shell/bundle-guard.sh` | the bundle build's refusal check, sourced by `run.sh`: `bundle_guard_sources` aborts on a source file with no code at all (zero bytes / whitespace only), naming it plus its importers, and `bundle_guard_diagnostics` promotes EVERY esbuild diagnostic to a build failure — esbuild is advisory about a named import it cannot resolve (a module with no import/export syntax), satisfies it with `undefined`, emits `(void 0)(...)` and still exits 0, so the bundle throws at mount instead of failing the build |
| `common/shell/bundle-stamp.sh` | the ONE input-set + fingerprint + stamp implementation every build path shares (sourced by `run.sh`, `apps/greeter/bundle.sh`, `apps/greeter/install.sh`, `scripts/artifacts.sh`, `scripts/build-all.sh` and `scripts/check-builds.sh`): `bundle_store_dir` is the ONE resolution of the artifact store root — never spelled anywhere else, because a second spelling is a second store, `bundle_source_dirs` defines which FILES an artifact is a function of, `bundle_fingerprint_inputs` is the ONE input list (those files + the root build files + the build path's own scripts + the ags version + the stamp format), `bundle_inputs_capture` freezes that list to a file BEFORE the bundle is produced and `bundle_inputs_fingerprint` hashes the capture, `bundle_stamp_inject` writes the fingerprint into the wrapper as `TINSHELL_BUILD_STAMP` and the store as `TINSHELL_BUILD_STORE`, `bundle_stamp_record` writes the `<artifact>.stamp.json` sidecar FROM that same capture plus the payload's own sha256 (one instant: the recorded fingerprint, the recorded `sources` map and the payload hash describe one artifact) and `bundle_stamp_verify` re-derives it and names every changed input — an artifact stale in the fingerprint is therefore always nameable in the diff. See "Pre-built artifacts" |
| `common/shell/new-app.sh` | `new-app.sh <name> [--desktop]` — scaffolds `apps/<name>/` and wires the two hosting sources of truth (manifest + registry) in the same command, then prints the integration checklist (setup.sh hooks, Hyprland rule, route-map) |

Per-app code (UI, applet/menu logic, app-specific backends, command handlers,
the tier→rebuild/redraw RESPONSE) stays in the app directory.

## Conventions for shared code

The table above is the inventory; these are the rules a module under `common/`
must satisfy. They hold because `common/` is imported by EVERY app in EVERY
host shape (shell, island, combo, the pre-login greeter).

**What belongs here, what stays in an app dir.** A `common/` module is
host-agnostic: no app's widget tree, no app's chrome. Where two hosts
genuinely differ, that difference is a small explicit SEAM and everything
above it is shared — `common/applets/surface/host.ts` ("every member here is
something those two genuinely do differently") is the model, and the hidden/
intro VISUALS a host owns stay in that host's port
(`common/applets/applet-window.ts`). Ingestion likewise stays app-side:
`common/tablet` owns the state machine and the refcounted ingest child, each app keeps its own watchdog state.

**No app import.** Shared code must not import an app — the machinery never
reaches into an app for state or policy. Verified exceptions: the universal
entry names apps by design (`common/host/registry.ts`), and four applet seams
wrap an app's own facility — `common/applets/keyboard/index.ts` reads the
owning app's gate (`@apps/keyboard/config`),
`common/applets/screengrab/capture-run.ts` notifies through the notifications
app's in-process daemon, `common/applets/battery/index.ts` notifies through that
same in-process send (`@apps/notifications/Notifd` → `notify`, the owner's
no-action entry point beside `notifyWithAction`) when the battery crosses its low
level — the warning has to be sent from the applet that observes the descent, and
the alternates were a second in-process send site or a shell-out, both worse —
and `common/applets/backend.ts` takes the dock's
screengrab domain signatures type-only. Do not add a fifth casually.

**The consumer owns its config, transport and state.** A shared module comes
up empty and is handed what it needs: the applet machinery and applet mounts
"never reach for a bound global" and each host supplies its own config source
in the mount context (`common/applets/config` — the dock passes its facade, the
greeter a frozen defaults object); each app builds its own facade and no module
knows the app list (`common/config/facade`); a host supplies its OS
implementations at mount time, so "the frontends stay free of any app"
(`common/applets/backend`); the shared renderer takes its host as a plain
parameter (`common/applets/surface/host`). Three consequences:

- **Common code reads no config of its own** — `common/` owns no config trio
  (`common/emoji/insert.ts`: "this module reads no config of its own (common/
  has no config owner)"); a surface that owns a store passes the values in. A
  shared schema SLICE is fine, but the generated artifact stays with the owning
  app (`common/applets/config.schema.ts` is composed by
  `apps/dock/config.schema.ts`).
- **One setting shared by several apps is not any app's config.** The preview
  preference lives in its own `common/state` store (app id
  `media-preview`), never in a host's config, because two hosts reading two
  config files would be two owners of one setting; a per-process monitor makes
  a flip in one island reach the other (`common/media/preview`). Config is the
  user's schema-driven trio; machine/UI state is the state dir
  (`common/state`).
- **Per-instance state lives in the factory closure, never module scope** —
  two apps share ONE shell bundle, so module-scope state collides across them
  (`common/tablet`: "ALL state lives in the factory closure"). A
  shared module exports a factory the app calls once with its own schema.

**Reach `common/` only through the `@common/*` alias.** It resolves from ANY
depth (`@common/* → ./common/*` in tsconfig `paths`, and `ags bundle` resolves
tsconfig paths from the repo root, which is why `common/shell/run.sh` bundles
from there), so a relative up-walk is never needed and is banned: it encodes a
depth that breaks the moment a file moves. Relative imports into `common/`
exist on exactly one path — the plain-Node one: `apps/*/config.schema.ts` (and
`common/applets/config.schema.ts`) import
`../../common/config/schema-build.ts`, because the schema generator runs under
plain `node --experimental-strip-types` with no tsconfig-paths mapping; the same
reason gives those imports their `.ts` extension. A `./sibling` import within
one directory is fine; crossing a directory inside `common/` uses the alias,
the two exceptions being that schema source and a plain-Node probe
(`common/hyprland/lua-string.probe.ts`).

**`common/` is not an npm workspace.** Root `package.json` declares
`workspaces: ["apps/*"]` only, so npm creates no `node_modules/common` link and
`common/` has no dependencies of its own. Apps import each other through the
`@apps/<app>/...` alias over the npm workspace links (`node_modules/@apps/<app>`
→ `apps/<app>`) — that is the sanctioned cross-surface read
(`@apps/keyboard/config` for `keyboardEnabled()`), not a `common/` module.

**One implementation per primitive, re-used instead of re-rolled.** When a
second app needs a primitive it imports the existing one — `common/path/complete`
states it ("ONE implementation: every tilde expansion in the repo goes through
here"), `common/fs/files` keeps the single `ensureDir` / `writeFileAsync`,
`common/text` is the ONE matcher, `common/hyprland/lua-string` the ONE
encoder of a runtime string into a Lua literal, `common/clipboard` the ONE
clipboard write, `common/applets/shared/battery-colour` the ONE battery colour
policy (the battery applet's ring and the overflow clock's charge notches both
render a reading through it, and its `isPluggedIdle` is the ONE spelling of the
plugged-and-idle state that ring and the applet's fully-charged counter share). A re-roll is the failure mode the rule exists to prevent: the
copies drift and a fix lands in one of them. Re-use is not reaching into — a
thin local wrapper is fine when it names the local need
(`apps/dock/screengrab/capture.ts`'s `expandPath` is an alias over
`@common/fs/files`' `resolvePath`).

## The applets backend

The OS-call implementations the applet layer runs on are
`common/applets/domains/*` — one module per OS domain, host-agnostic, no app
import. They are a SHARED library because two hosts bind them: the dock, which
hosts the user-session backend, and the PRE-LOGIN greeter
in process. `common/applets/backend.ts` is the contract they satisfy
(`AppletBackend`, type-only imports bridge the signatures); the runtime path for
every other host is a proxy (`common/applets/backend-client` over the request
surface, `common/applets/backend-socket-client` over the socket).

**A host that does not BIND the domains reaches them through a proxy.**
`backend-client` and `backend-socket-client` pull in no domain code (their
domain imports are `import type`), so such a bundle carries no OS-call
implementation. Exactly two hosts bind them in process — the dock, which owns
the backend, and the pre-login greeter, which runs before any session exists
(see below); adding a third is a deliberate act, not an import.

**The user-session backend is hosted by the DOCK — no backend instance, no
manifest entry and no registry entry: it comes up with the dock.**
`apps/dock/mount.ts` calls `mountAppletsBackend()`
(`common/applets/host/mount.ts`) and `apps/dock/applets.ts` builds its domains
with `createInProcessBackend()`: the 17 domain modules are the SAME module
namespaces the backend serves, so a dock applet call is a direct function call
with no round trip. The backend's two surfaces are:

- the REQUEST namespace `applets` in whichever instance hosts the dock — the
  shell in production (`ags -i shell request "applets <domain> <member>"`), a
  dock island in dev. It is registered like any app's namespace, so the router
  reaches it by the live-instance namespace scan; it has NO route-map entry and
  therefore no cold-start target (routing `applets` must never spawn a dock);
- the shared-group unix socket `/run/tinshell/applets.sock`
  (`common/applets/host/socket-server.ts`, directory + group installed by
  setup.sh's root section) for clients that cannot reach the dock's D-Bus
  instance.

The PRE-LOGIN greeter is the exception in TRANSPORT, not in shape: it
runs as another user before any session exists, so it uses
`common/applets/backend-client` with the SOCKET transport
(`common/applets/backend-socket-client`) and
`storeRead: "transport"`, and the socket serves the same request body and
envelope as the request surface. The greeter binds the domains that
need no session IN PROCESS (battery, brightness, cpu, system, power-profile, tlp
+ an `fs` whose only permitted writes are the battery charge cap and its
machine-level intent file (`/var/lib/tinshell/charge-cap`), both through scoped
`sudo tee` rules — `apps/greeter/strip/backend.ts`), because the
login screen runs before any session exists; the socket carries the SESSION
domains (`mpris`, `mediaWindow`), and the Power applet's actions call logind
directly (`apps/greeter/strip/power-logind.ts`). The charge-cap store OBSERVES
that file (`Gio.FileMonitor`), so a cap set on the lock screen reaches the
session host instead of being displayed, and healed against, as a stale value.
The socket surface keeps
`fs` unreachable for EVERY peer, makes store WRITES (`.set`/`.dump`/`.path`) and
every mutator owner-only (peer uid), denies a member token that does not resolve
(fail closed), and otherwise serves the shared group the domain READS — the one
deliberate exception is `brightness setScreenBrightness`, which a group peer may
call (the login screen's own slider goes through its logind session instead).

Everything the backend holds is PROCESS bound and dies with the dock process:
the sleep-inhibit logind fd, the D-Bus subscriptions, the tablet helper child
and the applet state stores' single owner. The dock's mount re-arms the tablet
watchdog and re-applies the persisted inhibit (`restoreInhibitState`) at every
start, so a dock restart resumes the machine-wide ingest and the sleep lock
without a host remount. Each dock-hosting process arms its OWN tablet watchdog
(the domain's start latch is per process).

Request surface (wire format in `common/applets/backend-protocol.ts`, served by
the dock instance):

- One path per EXPORTED domain function, derived from the modules themselves —
  `applets battery batteryState`, `applets wifi scanWifiNetworks`,
  `applets battery chargeThresholdStore.get chargeThreshold`. A member may also
  be named by the unique `<domain word><member>` form (`battery state`,
  `bluetooth status`) or by a single camelCase word (`wifi scan`).
- Every argument is `base64(JSON)`, one token each: the request surface splits
  on whitespace, so a raw JSON argument breaks on any space or quote.
- The reply is ALWAYS one JSON envelope — `{"ok":true,"value":…}` or
  `{"ok":false,"error":{"kind":…,"message":…}}`. A failed OS call answers the
  structured error, never a bare null. Kinds: `unknown-path`, `bad-arg`,
  `call-failed`, `no-sample`.
- Callback-style members are driven by the backend's collector (`PUSH_MEMBERS`
  in `common/applets/host/transport.ts`): a STREAM member is subscribed once and
  answers its latest payload, a ONE-SHOT member is re-invoked per request.
- Reactive members (`batteryState`, `brightnessState`, `cpuUtilization`, …)
  answer their current value; the backend subscribes for them, so the
  subscriber-gated `createPoll` domains actually tick.

The applets backend has no config trio — it reads no config of its own
(host policy reaches it as request arguments), so there is no generated
`config.schema.json` and no `gen:schemas` entry.

| Module | Purpose |
| -------- | -------- |
| `common/applets/domains/*` | one module per OS domain, keeping the exported surface the applet seams bind: `battery` (BAT0 sysfs poll), `bluetooth` (BlueZ D-Bus), `brightness` (backlight + logind), `cpu`/`system` (sysfs/proc samples), `fs` (sysfs/proc read + sudo-tee write), `media-window` (hyprctl client match) / `mpris` (MPRIS D-Bus: status + title/artist snapshot + the owner-only `playPause`/`next`/`previous` transport actions), `network` (interface counters), `power` (systemctl actions + logind idle-inhibit), `power-profile`/`tlp` (platform profiles), `power-supply-events` (power_supply uevents), `tablet` (tablet-mode watchdog), `volume` (default sink level + mute + device class via AstalWp, resolved on the first read so an import never connects — the sink's own property notifications are the event path and the caller's poll the safety net; `available:false` when the process has no default sink OR WirePlumber has not bound its node yet, the gate `sinkReady` reading the endpoint's id and its per-channel volumes: both the unenumerated endpoint and a bound node whose volume parameter has not landed answer `available:false` instead of a 0 %/muted reading, so a consumer that means "silent" tests `available` with `muted` and never the level alone), `wifi` (NetworkManager D-Bus), `workspaces` (hyprctl + socket2). Host config is read through `common/applets/config`; a persisted applet setting lives in the store the module that owns it creates with `@common/state` — never an `@apps/*` import. The battery charge cap is the ONE exception: its intent is machine-level at `/var/lib/tinshell/charge-cap` (the pre-login greeter runs as another user and cannot read the session user's state dir), written through the scoped `sudo tee` rules and created by setup.sh |
| `common/applets/host/{mount,in-process,transport,socket-server}.ts` | the HOSTABLE side of that surface (see the section above), mounted by the dock |

**Glyph convention:** Nerd Font glyphs are literal escapes + name comments — `"\ue73c" // dev-python` — never import a glyph dataset into an app bundle (the ~290 KB 10,995-glyph table must not be esbuild-inlined). **A codepoint above the BMP needs the brace form** — `"\u{f024b}" // md-folder`: unbraced, JS consumes only the first four hex digits and renders the rest as literal text (the whole MDI set lives in plane 15 PUA). Pick / verify / audit glyphs via the pi `nf` tool (`search`, `sheet`, `audit` — audit flags both unassigned PUA codepoints and that malformed unbraced shape). **Glyph buttons centre themselves:** GTK centres a label's logical box, and MDI artwork overflows the 0.6 em monospace cell (md-eye +27% of the advance, md-reload +23%, md-home +20%, md-arrow_up only +5%), so the icon reads off-centre. `common/card/header.ts`'s `glyphButton()` measures ink against logical extents with Pango at map time and adds a trailing margin — pick the right glyph, never a hand-tuned padding.

## Launch path

**One distributor: every instance shape —
singleton island, arbitrary combo, or the full shell — launches via
`tinshell-host.sh`** (common/shell/, symlinked to `~/.local/bin/tinshell-host`). An
instance = a SET of apps + one bus name; the set is selected at RUNTIME from
env (`TINSHELL_HOST_SET`) and served by the ONE static universal bundle
(`common/host/entry.ts` + `registry.ts`, cached at
`~/.cache/tinshell-bundle/universal/`) — no code generation anywhere. The app
manifest is `common/shell/apps.json` (export names, `lazy`, `unit`).

- `tinshell-host start <set> [--name N] [--foreground] [--if-absent]` — spawn an
  instance (transient systemd unit `tinshell-<name>`, Restart=on-failure,
  journalctl logs; duplicate-host guard; combo default name = sorted set
  joined with `.`). The guard refuses an app a live instance already serves,
  with ONE exception: a **single-app shim** — an instance serving exactly one
  app, which is what the D-Bus activation file brings up (and what `tinshell-mode
  island <app>` creates) — is RETIRED when the incoming set is larger,
  because a host serving the app as part of a set supersedes it. Without
  that exception the boot-time portal shim made every `tinshell-host start shell`
  refuse and stranded the desktop in island mode. `--if-absent` turns the
  refusal into a no-op success (exit 0); the resident dev units use it so a
  unit whose app a live host already serves goes inactive instead of
  crash-looping. `tinshell-host warm|stop|list|status|env` round it out.
- `tinshell-mode` is a thin preset layer over tinshell-host (see Switching modes).
- Boot: `tinshell-shell.service` ExecStart = `tinshell-boot.sh boot` — warms the
  universal bundle, spawns the shell as a foreground child, health-probes
  within `PROBE_WINDOW_S` (45s), then blocks on the child (exit code
  propagates to Restart=on-failure). The window is a CEILING, not a timeout:
  the child's own exit is the fast failure signal (a shell that cannot start
  is caught in well under a second), and the window only bounds a live child
  that is still initialising — a cold boot can spend 25s inside Gtk init on
  the `org.freedesktop.portal.Settings` D-Bus timeout while the portal
  backend starts; a window tighter than that ceiling reports a healthy shell
  as dead and falls back to the islands. Unhealthy → fallback island fleet;
  crash-loop exhaustion → `OnFailure=tinshell-islands-fallback.service` (same
  fleet, no-double-spawn guarded). Restarting this unit more than twice
  inside 60 s exhausts `StartLimitIntervalSec=60`/`StartLimitBurst=3`: the
  unit reports `start-limit-hit`, `OnFailure` engages the fleet, and the
  fleet then holds the app names — clear it with `systemctl --user
  reset-failed tinshell-shell.service` before the next restart.
- **Boot fallback leaves the unit INACTIVE, never `active` with no shell:**
  once tinshell-boot.sh has dispatched the fallback island fleet it EXITS 0. It
  must not stay alive as the unit's MainPID — `active` on a stale boot script
  makes every `systemctl --user start tinshell-shell.service` (the login
  autostart, `tinshell-mode shell`, the polkit recovery) a SILENT no-op, and
  `tinshell-mode shell` has already stopped the islands by then, so the desktop is
  left with NO TINSHELL surface at all. Exit 0 is a success result, so
  Restart=on-failure does not re-run boot and the fleet stands; every fleet
  app runs in its OWN unit (manifest `unit`, or an `tinshell-<app>` transient unit
  from tinshell-host or the per-app-bundle path), so it survives the teardown of
  the shell unit. A later `start` (or `restart`) re-runs the whole path —
  warm → spawn → probe → fleet — and the no-double-spawn guard makes that
  safe. Tell: after a fallback the unit reads `inactive (dead)` while the
  fleet islands serve it, and `tinshell-mode` reports `mode: island (dev)`.
- Per-app bundles via `common/shell/run.sh` remain ONLY as the boot-fleet
  fallback path + debug tooling; `apps/portal/run.sh` is KEPT as the manual
  per-app entry, and no session-bus activation file Execs it — a second
  claimant for the portal impl name cannot exist (see the portal spec).
- **No app uses bare `ags run` in production contexts** — per-app `app.ts`
  files stay as debug entries + per-app tsc targets, never the launch path.

`tinshell-warm.service` (user oneshot, WantedBy=default.target, needs
`loginctl enable-linger`) pre-builds every user-buildable artifact at boot
(`scripts/build-all.sh --quiet`) so the login-time start is a warm cache hit
(~0.7s instead of ~3.3s cold). `tinshell-boot.sh` warms only the universal bundle
before it spawns the shell and runs the same `scripts/build-all.sh --quiet`
in the BACKGROUND while the shell initialises — the per-app caches and the
greeter login and lock bundles are not dependencies of the spawn. A login
that follows a boot warm re-finds every artifact current (a cache-hit no-op),
and a genuine overlap between the two runs is serialized per artifact by the
bundler's build lock. Installed from `systemd/tinshell-warm.service` by setup.sh.

## Crash log (ONE file)

Every instance's stderr — gjs uncaught exceptions (`JS ERROR:` lines),
unhandled promise rejections, and other fatal prints from ANY app — tees
into **`/tmp/tinshell-crashes.log`**. The tee is applied by tinshell-host.sh at BOTH
spawn paths (the foreground exec and the transient-unit bash
wrapper), and re-emits to stderr so `journalctl --user -u tinshell-shell` (or
`-u tinshell-<instance>`) keeps its copy. Boot (tinshell-boot.sh spawns
`tinshell-host start shell --foreground`) is covered by the foreground path.
Check with pi: read/grep `/tmp/tinshell-crashes.log` for the last `JS ERROR:`
block + stack. Fallbacks NOT covered by the tee: bare `ags run
apps/<app>/app.ts` debug entries (journal only) and the greeter (boot-level,
separate user + compositor — see its AGENTS.md). The file is truncated on
reboot (/tmp); rotate or archive it if a crash needs post-reboot diagnosis.

## Addressing

- `ags -i shell request "..."` / `ags -i shell quit` — the PRODUCTION instance.
  Command paths are namespaced per app: `notes …`, `promptd …`, `files …`,
  `media …`, `annotate …`, `polkit …`, and the five surfaces
  `dock …`, `launcher …`, `notifications …`, `keyboard …`, `clipboard …`.
  `ags -i shell request ""` lists the top-level namespaces.
- Islands (dev): `ags -i dock|launcher|notifications|keyboard|clipboard|
  promptd|portal|polkit|notes|files|annotate|media request "..."` — SAME
  prefixed paths.
- **The router: `tinshell-route.sh <app> <command...>`** (common/shell/)
  — routes any request to the first LIVE instance hosting <app>: map-listed
  instances (`route-map.conf`) are probed FIRST in map order (production
  priority — a dev island never hijacks a keybind while the shell is up),
  then any OTHER live instance (dynamic combos route with zero map edits;
  first servable hit wins). Only when no live instance serves `<app>` does it
  cold-start the map's first instance via `tinshell-host` (the spawn is
  `flock`-serialized on that instance). Keybinds,
  ensure-*.sh wrappers and the promptd CLI clients all go through it. The
  map decides ROUTE PRIORITY + cold-start target only — live routing always
  probes reality. EXIT CODE: a reply whose FIRST LINE starts with `error:` is
  exit 1, because `ags -i <instance> request` exits 0 for EVERY reply,
  `error: …` included, and the router is the one client path keybinds,
  wrappers and CLIs share — so a caller tests `$?` instead of parsing stdout.
  The test is exactly the first line and exactly that prefix, and every other
  reply keeps the CLI's own exit code. JSON ENVELOPES ARE DELIBERATELY NOT
  MAPPED: `tinshell-route applets …` answers `{"ok":true,…}` / `{"ok":false,…}`
  and its clients parse the envelope only on exit 0
  (`common/applets/backend-client.ts`), so an unmapped structured error keeps
  travelling as `ok:false` on exit 0.
- `ags list` — enumerate running instances.
- Bare `ags request` / `ags quit` (no `-i`) target the default `ags` instance,
  which NO app uses — they error `instance "ags" is not runnning` (intended:
  every app is always addressed explicitly).

## Onboarding a new app

Run `common/shell/new-app.sh <name> [--desktop]` — it scaffolds the app dir
AND wires the two hosting sources of truth (manifest + registry) in one
command. Manual equivalent:

1. Create `apps/<app>/` with `mount.ts` exporting `mount()` (+ optional
   `css` export; lazy apps also `unmount`), and a thin `app.ts`
   calling `createApp({ instanceName: "<app>", css, main })` (debug entry
   only — never the launch path); pass `onQuit` there when the app has
   teardown to run on `<app> quit`.
2. Add the manifest entry to `common/shell/apps.json` (export names, `lazy`,
   optional `unit`) AND the registry entry to `common/host/registry.ts`
   (constant import specifier — esbuild requirement), plus the app name in the
   registry's `LAZY_APPS` list for an on-demand desktop app — a missing entry
   there means the app registers no namespace and every request answers
   `unknown command`. new-app.sh writes all three; a missing manifest entry =
   app not hostable.
3. Add `<app>/config.defaults.json` + a TypeBox `config.schema.ts` (source;
   `config.schema.json` generated via `npm run gen:schemas`) + a
   `<app>/config.ts` that OWNS its store + facade:
   `createConfigFacade(createConfigStore(appConfigDir("<app>")))`. If the app
   also ships an `install.sh` that writes a config into a live location, use the
   shared helpers in `common/shell/deploy-config.sh` — see "Deploy writes to
   live config".
4. Register every command PREFIXED: `register(["<app>", ...], handler)` —
   the registry is process-global in shell, so the prefix prevents collisions.
5. Lifecycle: gate any quit-on-close on `isShell` (resident instances never
   quit with their last window) and skip the per-app log sink in the
   PRODUCTION shell only (`isProductionShell` — `TINSHELL_SHELL=1` alone is NOT a
   shell discriminator; dev islands must keep their file sink). On-demand
   desktop apps are `lazy: true` — the shell's
   lazy loader handles them via the registry (mount/unmount/css resolved
   there); their `mount.ts` exports an `unmount` that resets module-scope
   state (windows, timers, bus subscriptions, CSS provider).
6. Add the DEV unit to `systemd/` only if it needs one (copy an existing
   template; ExecStart = `tinshell-host.sh start <app> --foreground`; on-demand
   desktop apps skip it). **Only `tinshell-shell.service` and `tinshell-warm.service` are ENABLED.**
   setup.sh MUST know the app too (dev-unit loop if any); a missing entry
   silently breaks fresh-machine bootstraps.
7. Add a Hyprland blur layerrule for the app's window namespace (or a
   windowrule for desktop windows: `notes-float`/`files-float`/`portal-float`/
   `annotate-float` classes).

Collisions to respect: each app owns its own window-namespace prefix and its
own Hyprland blur rule (`dock-.*`, `launcher`, `notifications-.*`,
`keyboard-.*`, `clipboard-picker`; promptd uses `promptd`; notes/files/
annotate/media/portal are regular WINDOWS with float rules in hyprland.lua).
One-owner names: `org.freedesktop.Notifications` (notifications surface —
never shell + notifications island together; setup.sh disables the packaged
`swaync.service`, whose daemon would be a second claimant), the polkit agent slot
(the packaged `hyprpolkitagent.service` is disabled for the same reason — a
second agent silently replaces the first), the portal impl name.

## setup.sh

`setup.sh` bootstraps the home onto a fresh machine (same hardware): installs
pacman/AUR package deps, runs `npm install` (workspaces `apps/*`), creates the
root `node_modules` shims + links AFTER npm install (npm prunes undeclared
links and walks inside in-project symlink targets), regenerates
`@girs/` via `ags types`, installs ALL unit templates, ENABLES only
`tinshell-shell.service` + `tinshell-warm.service` (per-app units stay installed for dev),
disables the packaged daemons that would race a name this home owns
(`swaync.service` for `org.freedesktop.Notifications`, `hyprpolkitagent.service`
for the polkit agent slot),
installs the portal backend files, installs every `apps/*/tinshell-<app>.desktop` entry — the four desktop apps
(annotate, files, media, notes) ship one — into
`~/.local/share/applications` and points every mime type those entries declare at
them (driven by each entry's own `MimeType` line, so file and association cannot
drift apart; the entries are `__TREE__`/`__HOME__` templates like the systemd unit
templates, with `__TREE__` substituted for the tree's install location and
`__HOME__` for the real home at install time by
setup.sh, which REFUSES to install an entry whose token survived substitution),
regenerates the VSCode entry because it ships claiming only its
own workspace type and so cannot receive source files at all, installs the
applets-socket root bits
(the `tinshell-greeter` group + the `/run/tinshell` tmpfiles.d entry the pre-login greeter
reads applet data over), verifies the Hyprland integration, and runs
the root-requiring hardware steps (input group, asus_nb_wmi modprobe option,
battery charge-threshold udev rule) via sudo with auto-skip for already-done
steps; each of those three config writes goes through `deploy_config_line`
(marker-gated append — an existing modprobe.d/udev/sudoers file keeps its other
lines, and a sudoers merge is visudo-validated before install).
Idempotent and re-runnable.

**The greeter deployment is REFRESHED on every run, never skipped.** The
greeter deployment is a snapshot of the sources — the bundle, the greeter config
trio, the dock trio, the compositor templates and `/etc/pam.d/greetd` — so
"`/etc/greetd/tinshell-greeter.sh` exists" answers nothing about whether the
rest is current: as a skip test it left the deployed dock config, the schemas
and PAM frozen at their first-install state while the sources moved on. The
block therefore asks the freshness gate's OWN verifier
(`bundle_stamp_verify`, the same implementation `npm run check:builds` runs for
its `greeter-deployed` row) whether the deployed bundle still matches the
sources it was built from — its verdict names every input that moved and is
printed as the reason — and then runs the deploy through the documented path
either way: `apps/greeter/build.sh` as the INVOKING user (a root rebuild would
leave root-owned artefacts in the checkout) followed by `sudo
./install.sh --no-build`, which verifies its own stamp and REFUSES a payload
that does not match the sources. The deploy is the only privileged step, so a
refused or unavailable `sudo` is reported as an error naming the exact command
to run — the previous deployment is never left in place in silence.

## Deploy writes to live config

A deploy NEVER silently reverts a config the user has set. Every `install.sh` /
`setup.sh` site that writes a config uses the shared helpers in
`common/shell/deploy-config.sh` — source it, never paste its logic into a
script (set `TINSHELL_DEPLOY_SUDO=""` only for a destination the calling user owns):

| destination | rule | helper |
| --- | --- | --- |
| LIVE member of a defaults+live pair (e.g. `/etc/greetd/tinshell-greeter/config.json`) | seeded when ABSENT; PRESERVED when it exists — the loader merges `config.defaults.json` UNDER the live file, so the overwrite buys nothing | `deploy_seed_config <src> <dst>` |
| the shipped defaults + schema mirror of that pair | always replaced — it IS the seed the live file merges over | plain `install -Dm644` |
| PAYLOAD a daemon reads directly (`/etc/greetd/config.toml`, `/etc/greetd/greeter.lua`, `/etc/pam.d/greetd`) | always replaced, and the line names the md5 it superseded. No defaults/merge channel exists for these, so the shipped file is the only route a repo change has to the machine — a guard here would stop shipping PAM/compositor fixes in silence | `deploy_payload_config <src> <dst>` |
| ONE line added to a config edited in place (`/etc/modprobe.d/…`, `/etc/udev/rules.d/…`, `/etc/sudoers.d/…`) | marker-gated, idempotent APPEND — the file is never truncated and existing lines survive byte-for-byte; a `validator` (e.g. `visudo -c -f`) runs against the MERGED file before install | `deploy_config_line <file> <line> <marker> [mode] [validator …]` |

SEED and PAYLOAD are different things, not an asymmetry to "fix": a seed has a
merge channel, so preserving it costs nothing; a payload has none, so preserving
it costs a shipped fix. Guard the seeds, announce the payload.

`--force` (`TINSHELL_DEPLOY_FORCE=1`) is the ONLY way `deploy_seed_config` replaces an
existing live config; it prints the md5 of what it destroyed. Without the flag
the deploy prints the preserved path and the command that overrides it.

## Switching modes

- **→ production (shell):** `tinshell-mode shell` (= stop islands, `systemctl
  --user start tinshell-shell.service`; boot goes through tinshell-boot.sh →
  tinshell-host). Keybinds route via `tinshell-route.sh` / `ensure-*.sh` so nothing
  else changes.
- **→ dev (islands):** `tinshell-mode island` (stop shell, start ALL
  long-running islands — surfaces via tinshell-host transient units,
  promptd/portal/polkit via their dev units) or `tinshell-mode island <app>`
  for just one (lazy apps spawn as pure-lazy quit-on-close islands). The
  same keybinds keep working (the router probes map order first, then any
  live instance; if NOTHING is live it cold-starts shell — the system
  recovers itself).
- **`tinshell-mode` (common/shell/tinshell-mode.sh, symlinked to `~/.local/bin`):**
  `tinshell-mode shell` / `tinshell-mode island [app]` / `tinshell-mode toggle` /
  `tinshell-mode` (status: per-app HOST-INSTANCE + unit state, probe-based —
  dynamic combos included; an app hosted by MULTIPLE live instances lists
  all of them comma-joined, unit state evaluated on the first host).
  UNIT-STATE: systemd state for the shell + manifest-unit apps, `transient`
  for tinshell-host transient units (`tinshell-<instance>.service`), `run.sh` for
  out-of-systemd launches. App list comes from `apps.json` (non-lazy =
  long-running set); island logs land in `journalctl --user -u
  tinshell-<instance>`. A resident island lazy-loads NOT-in-set apps on first
  routed request (universal entry `registerLazyApps(lazyNotInSet)`), so a
  lazy app can end up hosted inside a surface island instead of its own
  pure-lazy island — multi-host rows in the status table are the tell.
- **AGENT DEV PROTOCOL:** before ANY dev work on this home, ensure island
  mode (`tinshell-mode island`, or `tinshell-mode island <app>` for just the target) —
  reloads stay isolated + targeted and crashes don't bubble into production
  surfaces. Switch back (`tinshell-mode shell`) ONLY when work is finalized and
  confirmed stable. On boot the machine defaults to shell mode — agents must
  flip to island mode explicitly.

## Agent edit protocol

- **Island mode first** — the agent dev protocol above governs; the two rules
  below assume it has already been honoured.
- **Restart after every edit under `apps/` or `common/`** — the running
  instance serves the bundle it booted, so an edit is live only after
  `systemctl --user restart tinshell-shell` (the production instance; if the shell
  is down, `ags run apps/<app>/app.ts` for the island you edited). Broadcast
  the restart first, then verify the instance is up AND its request surface
  answers. This never waits for permission.
- **This tree is a git repository**, but uncommitted work is still
  unrecoverable: `cp -r . /tmp/tinshell-backup-$(date +%F)` before any structural
  or delete edit.

## Committing

One commit per landing change, made in the same pass that finishes and verifies
it. [`CONTRIBUTING.md`](CONTRIBUTING.md) §Commits is the normative rule set; the
parts that bite hardest:

- **Shape:** `type(scope): imperative subject`, then a body that states why the
  code changed in terms of the code. At most one co-authorship trailer, and only
  where machine assistance applies: `Co-Authored-By: Pi (<model-id>)`.
- **Never staged:** build artifacts and bundle caches (`dist/`, `*-tinshell.js`,
  the stamp sidecars), `node_modules/`, the generated `@girs/` typings, an app's
  live `config.json`, and anything under `$XDG_RUNTIME_DIR` or
  `~/.local/state/tinshell/`. The generated `apps/<app>/config.schema.json` is the
  exception — committed, regenerated, never hand-edited.
- **Never in a message:** an absolute home path, a hostname, an account outside
  the org in the remote, a credential, a date, or the story of how the change was
  found.
- **`main` is the only long-lived branch**, and nothing is tagged or versioned:
  the tree installs itself from the working copy, so the checkout is the
  deployable. An edit under `apps/` or `common/` reaches a running instance only
  once that instance restarts.
- CI checks the shape of every commit a push or a pull request adds.

## gjs binding gaps (all bite)

- `Graphene.Rect.contains_point` DOES NOT throw (manual + compute_bounds
  rects, `init(x,y,w,h)` or `{origin,size}` construction; Rect has NO
  x/y/width/height props — `translate_coordinates` stays for
  widget-relative hit-testing).
- `GLib.dir_open` NOT a function (use Gio enumerate_children).
- GOutputStream `write_async` needs GLib.PRIORITY_DEFAULT + GLib.Bytes, AND
  allows ONE outstanding write — serialize write chains (next line in the
  previous write's finish callback).
- GtkGestureDrag: `get_device()`, never `get_last_event()` (null at
  drag-begin); GestureClick on the same widget rejects sibling drag
  gestures — **but `group()` does NOT stop `GestureClick::released` from firing
  when the drag wins the sequence**: a pen drag then pushes TWICE (once in
  `drag-begin`, once in `released` at the release point). annotate drew a
  phantom dot stroke per drag, so the first undo appeared to do nothing and the
  second removed the visible stroke. Gate the click handler on a flag set in
  `drag-begin` and cleared on the click's `pressed`.
- GtkGestureClick has NO `clicked` signal (gir exposes pressed/released
  only — connect `released`); Gtk.Window has NO `is_destroyed` — track
  teardown with your own flag set from the window's destroy signal.
- gjs cairo: camelCase methods only (`moveTo`/`setSourceRGB`/`writeToPNG` —
  capital PNG; snake_case throws), `new Cairo.Context(surf)`,
  `ImageSurface.createFromPNG` YES but `createForData`/`getData` NO
  (texture→pixbuf→tmp PNG round-trip instead); PangoCairo.create_layout(cr)
  + show_layout works for text.
- **GDK cannot put an IMAGE on the clipboard here:**
  `Gdk.ContentProvider.new_for_bytes("image/png", bytes)` +
  `clipboard.set_content(provider)` leaves the clipboard with NO selection owner
  (`wl-paste --list-types` lists nothing, though the provider is built without
  error). Text through `new_for_value` is fine. Images go out via
  `wl-copy -t image/png < file` — `common/clipboard`'s `copyImageFile`.
- AstalNotifd daemon has NO `notify()` (gir 0.1) — in-process:
  `new AstalNotifd.Notification()`,
  `n.add_action(new AstalNotifd.Action({ id, label }))` — the constructor takes
  a PROPERTIES OBJECT; positional args throw ("should be a plain JS object with
  properties to set") and the throw aborts the whole notification, so nothing is
  ever sent,
  `AstalNotifd.send_notification(n, cb)`; action presses intercepted in
  invokeAction via `registerActionHandler` (n.invoke() round-trips to the
  dead sender for own notifications).
- **Gio file reads:** `Gio.InputStream.read` and `read_all` are NOT CALLABLE from gjs — both abort with `argument 'buffer' is not introspectable because it has a type not supported for (out caller-allocates)` for a `Uint8Array`, a plain array, and a subarray view alike — so `read_bytes` is the ONLY synchronous byte read on a file stream. A `GLib.Bytes` returned by `read_bytes` is RETAINED by gjs: a per-read transport over the shipped 147,318-key index (34 reads per hit) grew ~7 KiB per lookup, ~35 MiB over 5,000 hits, and `System.gc()` did not reclaim it, while the same reader reading the same file through `GLib.MappedFile` (one mapping per file, `get_bytes().get_data()`, subarray reads) stayed flat and released the mapping at close. Never call `unref()` on a `GLib.Bytes` the JS side still holds — it segfaults.
- **GLib.KeyFile:** `get_keys` returns `[array, length]` tuple, NO
  `has_key`; `get_string` THROWS on missing key (try/catch).
- **Gio async = CALLBACK-ONLY** (the @girs Promise overloads lie):
  `enumerate_children_async` needs 5 args, `next_files_async` 4,
  `launch_default_for_uri_async` 4 with finish
  `launch_default_for_uri_finish` (NOT `..._async_finish`).
- `GLib.idle_add` needs BOTH args (`GLib.idle_add(priority, fn)`;
  single-arg throws "At least 2 arguments required").
- Reuse `common/fs/files` promisified patterns.

## Pre-built artifacts and the freshness gate

Every shipped artifact is a SNAPSHOT of the repo: the universal bundle
(`~/.cache/tinshell-bundle/universal/`, shared by every instance shape), each app's
bundle cache (`~/.cache/tinshell-bundle/<app>/`, the boot fleet's per-app fallback),
the greeter login bundle and the in-session lock bundle
(`apps/greeter/dist/`). Building is PRE-BUILT by design: boot warms the
artifacts, and a bundle that quietly predates the sources it runs is the
failure this section exists to make impossible to miss.

- **`npm run build:all`** (`scripts/build-all.sh`) builds all of them through
the ONE bundler — `common/shell/run.sh` / `apps/greeter/build.sh` /
`build-lock.sh`, i.e. esbuild + the bundle guard + the stamp, never a second
build path. An artifact already built from the current sources is a no-op, so
the command is cheap to run after every edit; `--force` rebuilds regardless.
It prints artifact → source fingerprint → destination plus the store it
wrote to, and records the same-run receipt (`TINSHELL_BUILD_RECEIPT`, below) for the
boot warm. Never escalates: the `/etc/greetd` deploy stays a separate root step
(`apps/greeter/install.sh`, one approval).
- **`npm run check:builds`** (`scripts/check-builds.sh`) is the freshness gate
(gap in shape to `check:schemas`: that one regenerates an artifact IN the tree,
this one compares built artifacts against the sources they claim). For each
artifact it re-derives the fingerprint from the current tree and exits
NON-ZERO naming the artifact and every changed, added or removed source, the
store it read, and the REASON its verdict carries (`STALE` for inputs that
moved, `payload` for a payload replaced after its build, `unbuilt`/`missing`
for an artifact that store never held — a build whose artifacts landed in
another store reads exactly like that, which is why the store is named). The
same-run verified count prints before the verdict so an exit code cannot hide
it. Run it before relying on an artifact, after a merge, or from any deploy
script.
- **The store.** An artifact's payload and stamp sidecar live in ONE store root,
resolved in exactly ONE place — `bundle_store_dir`
(`common/shell/bundle-stamp.sh`) — which `run.sh` writes through, which the
registry locates rows in, and which both gates read. A second spelling is a
second store: the build fills one, the check reads the other, every artifact
then reads stale however often it is rebuilt, and the flap looks like a source
problem. A stamped wrapper carries its store, so the runtime report
(`<instance> debug build`) reads the sidecar from `TINSHELL_BUILD_STORE` instead of
resolving the store a second time; a wrapper built before the export names no
store and says so.
- **The stamp.** A build records the fingerprint it used in a sidecar
(`<artifact>.stamp.json`) AND injects it into the wrapper as `TINSHELL_BUILD_STAMP`,
so: `npm run check:builds` reads the sidecar, the running process reports the
injected value, and a bundle copied elsewhere (the deployed
`/etc/greetd/tinshell-greeter.sh` plus its `.stamp.json`) still carries its own
identity. The sidecar also records the artifact's own sha256, so a payload
replaced after its build is caught instead of trusted.
  - **THE INPUT SET** (`bundle_source_dirs` + `bundle_fingerprint_inputs`): the
    SOURCE SET is apps/ + common/ for the universal bundle (entry.ts can import
    anything); the app dir + common/ + every app dir whose modules the app's own
    sources name through `@apps/<app>/…` (that alias is INLINED by esbuild —
    `apps/portal/window.tsx` imports `@apps/files/fs`) for a per-app bundle.
    The FINGERPRINT is taken over that set PLUS the root build files
    (tsconfig.json, env.d.ts, package.json), the build path's own scripts
    (run.sh, bundle-guard.sh, bundle-stamp.sh) and two non-file inputs (the ags
    version, the stamp format) — all by CONTENT, one list, and that same list is
    what the stamp records and what a stale verdict diffs. `run.sh`'s cache-hit
    test IS the gate's own question — `bundle_stamp_verify` over the recorded
    fingerprint and the payload's sha256 — so cache invalidation, the guard's
    refusal and the freshness verdict cannot disagree: an artifact is current if
    and only if its recorded identity matches the identity of the same inputs
    computed now and its payload still hashes to the recorded value, and the
    changed input is always named.
  - **WHAT IT REPORTS AT RUNTIME:** every instance logs one startup line naming
    the artifact, the sources it was built from and the store it came from — the
    store travels with the bundle, so a boot running an artifact built into
    another store says so on that first line, and a bundle carrying no store
    says that (`common/host/entry.ts` for
    the shell and every island, `apps/greeter/app.ts` for the login screen and
    the lock), and `<instance> debug build` answers with the same stamp plus
    whether the cached stamp on disk has moved on since (a newer build waits
    for a restart): `ags -i shell request "shell debug build"`, `ags -i greeter
    request "greeter debug build"`.
  - **THE DEPLOY IS GATED:** `apps/greeter/install.sh` REBUILDS the bundle,
    then refuses (exit 3, before touching `/etc/greetd/`) a payload whose
    stamp does not match the sources it was built from; it installs the stamp
    beside the payload so `check:builds` can read the deployed copy
    (`--no-build` deploys the artifact already in `dist/` and is refused the
    same way when it is stale — how `setup.sh` deploys: it builds as the
    invoking user first, so no root rebuild leaves root-owned artefacts in the
    checkout).
- **THE SAME-RUN RECEIPT:** `tinshell-boot.sh` mints ONE receipt file for the boot
  run and hands the SAME path to that run's warm and to its freshness probe
  (`TINSHELL_BUILD_RECEIPT`), removing it when the probe returns; `build-all.sh`
  records in it the artifacts it left current with the fingerprint each was
  verified against, plus the universal fingerprint of the tree it built from;
  `check-builds.sh` honours the receipt only while its own universal
  fingerprint still equals that one and the payload and stamp are still in
  place, and says so when a source moved anywhere after the warm voids it. No
  receipt is no skip, a moved tree is no skip, so a standalone
  `npm run check:builds` always re-derives. What the skip trades on the boot
  path is the payload checksum for the artifacts the warm verified moments
  earlier, and the probe states how many it verified instead of checking, so
  the boot log never implies a check that did not happen.
- **BOOT WIRES IT:** `tinshell-boot.sh` warms the universal bundle (the one artifact the shell
  spawn depends on) *before* spawning, and runs the remaining artifact warm
  (`scripts/build-all.sh --quiet`, each artifact under a hard timeout) plus the freshness
  probe in the BACKGROUND while the shell initialises — they are not dependencies of the
  spawn, and in front of it they cost more than the shell's own start. Both log into
  `tinshell-shell.service`'s journal: the artifacts it could NOT build, and the deployed
  greeter bundle (root's — the one artifact this user cannot rebuild), so a stale deploy is
  named at boot rather than discovered on the lock screen. The warm and the probe
  share ONE per-run receipt (above), and the probe's verdict is relayed in BOTH
  outcomes — what it verified as well as what it did not. Neither is load-bearing: a
  failed warm leaves the last good artifact in place and only costs a cold build, and a
  failed freshness probe only logs.

## Bundle cache details (per-app bundles)

Per-app bundles via `common/shell/run.sh` cache at
`~/.cache/tinshell-bundle/<app>/` (hashed outfile). Env toggles:
`TINSHELL_BUNDLE_CACHE=0` (skip the cache read), `TINSHELL_BUNDLE_FORCE=1` (rebuild
even on cache hit), `TINSHELL_BUNDLE_WARM=1` (build-only). NEVER stray
`ags run` in production contexts (see Launch path).

Every build runs `common/shell/bundle-guard.sh` (`bundle_guard_sources` +
`bundle_guard_diagnostics`) BEFORE it is allowed to write a wrapper; a guard
failure exits 3 and never serves the stale cache. esbuild exits 0 on a named
import it cannot resolve — it sniffs the module as CommonJS, satisfies the
binding with `undefined`, emits `(void 0)(...)` — so a source file with no
content ships a bundle that throws `TypeError: (void 0) is not a function` at
mount (a zero-byte module left by an interrupted write cost the dock its
whole applet row: one blank disc, no band, no input region, no error). The
guard is cheap (one `find` + one `grep` pass, ~15 ms over the full apps/ +
common/ set) and runs ONLY when a bundle is actually rebuilt — a cache hit
skips it. The cache hit test is the artifact's recorded identity
(`bundle_stamp_verify`: its fingerprint AND its payload sha256), not an mtime
sweep: a `touch` rebuilds nothing and a content or payload edit always rebuilds,
and the same rule answers `npm run check:builds`, so a change to the guard (or
any other build-path script) is both a rebuild reason and a named line in a
stale verdict — the `|5` CACHE FORMAT literal this replaced is gone because the
guard's own content is an input.

A successful build also records `common/shell/bundle-stamp.sh`'s source
fingerprint (`build-stamp.json` in the artifact store beside the wrapper, and
`TINSHELL_BUILD_STAMP` plus `TINSHELL_BUILD_STORE` inside it) — see "Pre-built artifacts
and the freshness gate" above for the source set, the runtime report and the
gate. A refused build advances neither:
the guard exits before the wrapper is moved into place, so the cache keeps the
last good bundle and the stamp still describes it, and the next start re-runs
the guard.
