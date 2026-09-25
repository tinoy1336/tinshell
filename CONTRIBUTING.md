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
npm run check:palette    # the generated palette carriers match the palette revision this repo pins
```

The palette gate reads the palette from a checkout of its own repository: it
resolves `HOUSE_PALETTE` when that variable is set, and otherwise expects the
checkout beside this tree at `../house-palette`. CI clones it at the revision
`scripts/palette/pin.json` pins; a carrier that is not what that palette renders
fails the check with the file named, and the fix is `node scripts/check-palette.mjs
--write` plus a commit of the re-rendered carriers and their records.

Then the checks CI cannot run, because they resolve the Arch-only `ags` toolchain
and the generated typings (see the header of `.github/workflows/ci.yml`):

```bash
./setup.sh                                     # once, to generate @girs and shim-types
npm run check                                  # biome + shim types + tsc + schema and palette freshness
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

## Paths

No tracked file may name where this checkout happens to live, and none may name a
runtime directory by a fixed uid. A reference is written for its reader: `~`,
`$HOME`, the `__TREE__` / `__HOME__` install-time tokens, the XDG directories,
`/etc`, `/usr`, `/var`, `/tmp`, or a path relative to the repository root. The rule
binds prose as it binds code — a spec sheet, a comment and a fixture are all read
by a stranger, and the gates that select files by extension never open a markdown
file.

```bash
node scripts/check-paths.mjs    # the gate; CI runs it as the `portability` job
```

- RIGHT: `` `common/shell/run.sh` ``, `` `${XDG_RUNTIME_DIR}/tinshell` ``, `__TREE__/apps`,
  `` `~/.cache/tinshell-bundle` ``.
- WRONG: an absolute path into one machine's home directory, a tilde path into a
  development checkout directory, or a runtime path with a uid spelled out.

The one escape hatch is the accept record — [`.portability-allow.txt`](.portability-allow.txt)
at the repository root, one line per accepted reference, the reason on the same
line because it has to arrive in the same diff as the reference it excuses:

```
<path>:<line>|<detector>|<reason>
```

An entry that matches nothing is reported stale, and it goes away with the
reference it excused. A repository whose root is itself machine-specific cannot
keep the record there; `--allow-file=<path>` points the check at the record it
does keep (a repository rooted at the live home directory keeps it at
`.github/scripts/portability-allow.txt`). [README.md](README.md) §Path references
carries the reader-facing version of this rule and the detector list.

## Commits

One commit per landing change: a change that stands on its own, that passes the
checks, and that can be reverted without dragging something unrelated with it. A
change is committed in the same pass that finishes and verifies it — not per file
saved, not once at the end of a long stretch of work. An uncommitted edit has no
history to fall back on, and a pile of them splits into commits nobody can review
in isolation.

- RIGHT: one commit for "resolve the tree from its own location", carrying the
  three scripts, the templates and the fixtures that all follow from that one
  decision, plus the docs that described the old behaviour.
- WRONG: one commit holding a bug fix, a lint sweep and an unrelated rewrite; or
  one fix spread over three commits where only the third one works.
- WRONG: committing a half-finished refactor so it is "somewhere", then
  committing the rest later on top of it.

### Before committing

1. `git status` — read the list. Every entry is a file that belongs in the
   commit; a `git add -A` that swept up an artifact, an editor file or a runtime
   file is undone before the commit, not after it.
2. The checks have actually run and passed, not just been read about: the ones in
   [Before you send a change](#before-you-send-a-change), which is the same set CI
   runs.
3. The change works in the shape it ships in. An edit under `apps/` or `common/`
   is live only after the hosting instance restarts, so a change verified in
   place is not yet a verified change.
4. Nothing from [Never committed](#never-committed) is staged, and no credential
   is anywhere in the staged diff or the message.

### Message

```
type(scope): imperative subject

Why the code changed, stated in terms of the code: the constraint that was
violated, the failure the change removes, and the decision taken instead.
Wrap the body at 72 columns. Name the files and symbols that moved.
```

| Part | Rule |
| --- | --- |
| type | one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert` |
| scope | the app or subsystem the change lands in (`dock`, `launcher`, `setup`, `ci`, `portability`); omitted only for a genuinely repo-wide change |
| subject | imperative, lowercase after the colon, no trailing period, at most 100 columns |
| body | required — the reasoning, never a restatement of the diff, which already shows what moved |
| co-authorship trailer | at most one, and only where the change was written with machine assistance: `Co-Authored-By: Pi (<model-id>)`, the id of the model that did the work |

RIGHT:

```
fix(greeter): name the dock-config mirror's source instead of skipping it

The pre-login deploy mirrored the live dock config into the greeter's own
directory, but the copy sat behind a readability test on $HOME with no else
branch. A deploy started through sudo resets HOME, so the test failed, the copy
was skipped, and the deploy still reported success while shipping the previous
mirror — the login strip then rendered dock values that no longer matched the
desktop.

Resolve the source explicitly instead: the configured override where it is set,
otherwise the home of the account that invoked sudo, through SUDO_USER, so the
copy no longer depends on HOME at all.

Co-Authored-By: Pi (deepseek-flash)
```

WRONG, one line each:

- `fix: stuff` — no scope, and a subject that names nothing.
- `fix(dock): fixed the thing.` — past tense, trailing period, no body.
- `Update AGENTS.md` — not a Conventional Commits subject at all.
- a body that walks the diff file by file and leaves the reason out.
- two or three `Co-Authored-By` lines, or a `Generated with …` line: the trailer
  is one line naming one model, never a roster.

### Never in a message

- An absolute home path (`/home/…`, `/Users/…`), a hostname, or an account other
  than the org in the remote. The portability gate reads tracked files for the
  same rule; a commit message is not covered by it, so there the rule is on the
  author. Write `~`, `$HOME` or a path relative to the repository root instead.
- A credential of any kind, in any form, including a partial or redacted-looking
  prefix: a message is permanent and public from the first push.
- A date, a story of how the problem was found, or a phase number. State the
  constraint the code has to satisfy.

### Never committed

A file is committed when it is a source of truth. Anything a build, an install or
a running session derives does not belong in the history, and
[`.gitignore`](.gitignore) is that rule's executable form:

| Not committed | Because | It lives in |
| --- | --- | --- |
| `node_modules/` | installed from the lockfile with `npm ci` | the working tree |
| `@girs/`, `apps/greeter/@girs` | generated from the installed toolchain by `ags types` | the working tree |
| `dist/`, bundle wrappers (`*-tinshell.js`, `*-tinshell.wrapper.sh`) and stamp sidecars | built artifacts: a snapshot of the sources they were built from | the bundle store under `~/.cache/tinshell-bundle/`, and `/etc/greetd/` for the deployed greeter |
| an app's live `config.json` | the values the running desktop holds — machine state, not a source file | the XDG config dir the loader reads (`~/.config/tinshell/<app>.json`) |
| `$XDG_RUNTIME_DIR` state, `~/.local/state/tinshell/`, `/tmp` output | re-created by the next boot or the next session | where it already is |
| editor and tool state (`.pi/`, `.pi-subagents/`, `.zcode/`, `*.log`) | local to the machine that produced it | untracked |

The generated `apps/<app>/config.schema.json` is the deliberate exception: it is
written by the schema generator and it IS committed, so a checkout restores a
complete config trio without a regeneration step. It is never edited by hand —
edit `config.schema.ts`, run `npm run gen:schemas`, and let
`npm run check:schemas` prove the pair still matches.

A file that is wanted but ignored, or ignored but wanted, is fixed in
`.gitignore` in the same commit as the change that made it so, never by
`git add -f`.

### Branches and releases

`main` is the only long-lived branch, and this working copy is the deployable:
the installer renders the checkout's own path into every unit and desktop entry
it writes, so there is no artifact to version, tag or publish. A pull request may
come from a short-lived branch or a fork; it lands on `main` and the branch goes
away.

The message conventions are not aspirational. CI checks the shape of every commit
a push or pull request adds — subject, body, trailer and the paths a message must
not name — so a message that breaks them is caught where it is written rather
than on the next read of the log.

## Licence

Contributions are accepted under the MIT licence in [`LICENSE`](LICENSE).
