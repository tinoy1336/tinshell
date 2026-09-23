# tinshell

[![CI](https://github.com/tinoy1336/tinshell/actions/workflows/ci.yml/badge.svg)](https://github.com/tinoy1336/tinshell/actions/workflows/ci.yml)

A desktop shell for Hyprland, written as a set of AGS (Astal/GTK4) apps with gjs
as the runtime. One codebase runs in two shapes: a single **shell** process that
hosts every app, or one **island** process per app during development.

The apps are the surfaces and services a session needs, and each one is a real
app with its own sources, its own `mount.ts` and its own config trio:

| App | What it is |
| --- | --- |
| `dock` | the dock band: applet discs (volume, brightness, battery, wifi, bluetooth, power, screengrab, workspaces, …) plus the applet backend every other host reads OS state through |
| `launcher` | the launcher, including its `!` bang modes (`!g`, `!p`, `!a`, `!man`, `!epoch`, …) |
| `notifications` | the notification centre and popups, and the `org.freedesktop.Notifications` daemon |
| `keyboard` | the on-screen keyboard and its key/text backend |
| `clipboard` | the clipboard history picker |
| `promptd` | the input/prompt dialog service (askpass, forms, approval windows) |
| `portal` | an `xdg-desktop-portal` FileChooser backend |
| `polkit` | a polkit `AuthenticationAgent` that answers through promptd |
| `notes`, `files`, `annotate`, `media` | the desktop apps: floating notes, a file browser, a screenshot annotator, and a player/image viewer |
| `greeter` | the pre-login login and lock screens, spawned by greetd in their own compositor |

## Requirements

Arch Linux, and honestly: this is built for one machine and one compositor. The
stack it resolves is Hyprland, `gjs`, `gtk4-layer-shell`, the Astal typelibs and
`ags` — the AUR package `aylurs-gtk-shell`, not the older official `ags` — plus
the session services the applets read (NetworkManager, BlueZ, UPower,
WirePlumber, PipeWire, playerctl) and the capture tools (`grim`, `slurp`,
`wf-recorder`). The greeter additionally needs `greetd` and
`libastal-greetd-git`. `setup.sh` lists the full set and installs it.

**The generated typings are not in the tree.** `@girs/` comes from `ags types`,
and `shim-types/` from `npm run gen-shim-types` (which type-resolves the
installed ags/gnim shims under `/usr/share/ags/js`). Both are gitignored because
they are functions of the installed toolchain, so a fresh checkout cannot
typecheck until they are generated — `./setup.sh` does that, and so does the pair
of commands in [Development](#development).

## Install

```bash
git clone https://github.com/tinoy1336/tinshell.git ~/dev/tinshell
cd ~/dev/tinshell
./setup.sh              # packages, npm install, typings, shim types, units, root steps
tinshell-mode shell     # or leave it to tinshell-shell.service at login
```

`setup.sh` is idempotent and re-runnable; it installs the user units, enables
`tinshell-shell.service` and `tinshell-warm.service`, and performs the
root-requiring steps (input group, the battery charge-threshold udev rule, the
greeter deploy) one at a time.

## Two shapes, one codebase

- **Shell** — the production shape. `TINSHELL_HOST_SET=shell` picks the preset,
  and ONE process hosts every app: one instance, one bundle, one warm cache. It
  is what `tinshell-shell.service` starts at login.
- **Islands** — the development shape. Each app runs in its own process
  (`tinshell-mode island <app>`, or `ags run apps/<app>/app.ts` for a debug
  entry), so a reload is targeted and an unstable app cannot take the rest down.

```bash
tinshell-mode                 # status: which instance hosts what
tinshell-mode island          # every long-running app as its own island
tinshell-mode island launcher # just one
tinshell-host start shell     # the distributor underneath both (any set, any name)
```

Both shapes are served by ONE static bundle built from `common/host/entry.ts`;
the set is chosen at runtime, so no code is generated per shape. An island that
hosts an eager app also lazy-loads the apps outside its own set on first request,
exactly as the shell does.

## Addressing a running instance

Every app registers its commands prefixed with its own name, and every instance
answers requests over its bus name:

```bash
ags list                                   # instances that are up
ags -i shell request ""                    # the command namespaces that instance serves
ags -i shell request "launcher toggle"
ags -i shell request "dock config get layout.position"
ags -i dock  request "dock debug state"      # an island, served by the same code
```

Keybinds and scripts do not name an instance. They go through the router, which
finds the first LIVE instance serving that app — map order first (`common/shell/route-map.conf`,
production priority), then any other live instance — and only cold-starts one when
nothing serves it:

```bash
tinshell-route launcher toggle     # routes, or starts the map's first instance
```

## Layout

| Path | Purpose |
| --- | --- |
| `apps/<app>/` | one directory per app: sources, `mount.ts`, `app.ts` (debug entry), config trio, spec sheet |
| `common/` | cross-app infrastructure — the card substrate, applet machinery, config loader, build path, router. Not a workspace; imported through the `@common/*` alias |
| `common/host/` | the universal entry and the static app registry every shape is served from |
| `common/shell/` | `tinshell-host.sh` (the distributor), `tinshell-boot.sh`, `tinshell-route.sh`, `tinshell-mode.sh`, `run.sh` (the bundler) and the bundle stamp/guard |
| `scripts/` | the artifact registry, the schema generator, the build and freshness gates |
| `systemd/` | unit templates (`__HOME__` substituted at install time) |
| `setup.sh` | the machine bootstrap |
| `AGENTS.md` | the root spec sheet: layout, conventions, launch path, addressing, build gates, gjs gotchas |
| `.github/workflows/ci.yml` | what CI can and cannot check here, and why |

Every app has its own spec sheet at `apps/<app>/AGENTS.md`, and the shared
subsystems have one too (`common/applets/AGENTS.md`, `common/shell/AGENTS.md`).
They are the reference for how a piece of this shell is meant to behave — read the
root one first, then the one for the subtree being touched.

## Development

```bash
npm ci                     # toolchain + workspace links
./setup.sh                 # once: @girs typings and shim-types (needs ags)
npm run check              # biome + shim types + tsc + config schema freshness
npx biome check .          # lint + format alone
npm run check:schemas      # the generated config.schema.json files match their sources
npm run build:all          # every shipped artifact, through the one bundler
npm run check:builds       # every artifact against the sources it was built from
```

Bundles are pre-built snapshots of the tree, so a bundle that quietly predates
its sources is the failure the freshness gate exists to catch: `npm run build:all`
is a no-op for an artifact already current, and `npm run check:builds` names every
stale one and the sources that moved. Every instance logs the artifact and store
it booted from, and `<instance> debug build` reports the same stamp.

A change under `apps/` or `common/` is live only after the hosting instance
restarts — a running process serves the bundle it booted.

## Licence

MIT — see [LICENSE](LICENSE).
