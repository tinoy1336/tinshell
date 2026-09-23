# Contributing

Read [`AGENTS.md`](AGENTS.md) first. It is the project's spec sheet: the layout,
the two deployment shapes, the launch path, the request router, the shared-module
rules, the build and freshness gates, and the gjs binding gaps that bite. Every
app carries its own `apps/<app>/AGENTS.md` beside its sources; work in an app
starts from that file plus the root one.

## Scope

This is a personal desktop shell for one machine and one compositor: Hyprland on
Arch, running the AGS (Astal/GTK4) stack. It is published so the code can be read
and learned from. Issues and pull requests are welcome where they fix something
that is wrong — a bug, a crash, a stale doc — but there is no promise that a
feature another setup wants will be merged, because every surface here exists to
serve this desktop's layout and workflow.

## Running it

`./setup.sh` bootstraps a machine end to end (packages, typings, units, the root
integration). It is written for Arch and assumes it owns the session; read it
before running it on a machine you care about.

## Before you send a change

Run the same checks CI runs, from the repo root:

```bash
npm ci
npx biome check .        # lint + format
npm run check:schemas    # the generated config.schema.json files match their sources
```

Then the checks CI cannot run, because they resolve the Arch-only `ags` toolchain
and the generated typings (see the header of `.github/workflows/ci.yml`):

```bash
./setup.sh                                     # once, to generate @girs and shim-types
npm run check                                  # biome + shim types + tsc + schema freshness
npm run build:all                              # every shipped artifact, through the one bundler
npm run check:builds                           # every artifact against the sources it was built from
```

A change to an app or to `common/` is only live in a running instance after that
instance restarts — the process serves the bundle it booted. During development
run the app as a dev island (`tinshell-mode island <app>`) so a reload is
targeted and a crash stays out of the production shell.

## Style

Formatting and lint are committed as `biome.json` and enforced by `npx biome check .`;
there is no separate editor config. Prose in code, docs and commit messages states
technical fact: no dates, no discovery story, no history of what a module used to
be. The codebase's own vocabulary is the right one — an app's spec sheet names it.

Commits follow Conventional Commits (`fix(dock): …`, `docs(launcher): …`), one
trailer line for co-authorship where one applies.

## Licence

Contributions are accepted under the MIT licence in [`LICENSE`](LICENSE).
