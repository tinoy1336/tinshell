# AGENTS.md — common/shell (the build path and the freshness gates)

`common/shell/` holds the shell scripts the whole home is launched and BUILT
through. The scripts in `scripts/` are the same mechanism viewed from the
artifact side (`scripts/artifacts.sh`, `scripts/build-all.sh`,
`scripts/check-builds.sh`) and are documented here too, because the store, the
stamp and the gates are one contract. The artifact OVERVIEW, the source-set
rules and the deploy gate live in the root `AGENTS.md` (§Pre-built artifacts and
the freshness gate) — read that first; this sheet carries what the code here
must satisfy.

## The artifact store

An artifact's identity is its payload plus its stamp sidecar, kept in the
artifact store. The store root is resolved in exactly ONE place:
`bundle_store_dir` (`bundle-stamp.sh`) — `<XDG_CACHE_HOME>/tinshell-bundle`, the
user cache by default. `run.sh` writes through it, `scripts/artifacts.sh`
locates rows in it, and both gates read it.

NEVER spell the store path anywhere else. A second spelling is a second store:
the build fills one and the check reads the other, every artifact then reads
stale no matter how often it is rebuilt, and the flap looks like a source
problem. Each gate names the store it used, and `check-builds.sh` reports an
artifact with no stamp or no payload there as `unbuilt` / `missing` rather than
`STALE`, so a build that wrote elsewhere is named instead of guessed at.

A built wrapper carries its store with it: `bundle_stamp_inject` exports
`TINSHELL_BUILD_STORE` (beside `TINSHELL_BUILD_STAMP`) into every artifact it stamps, and
the runtime report (`common/host/build-stamp.ts`, `<instance> debug build`)
resolves the sidecar from that value instead of resolving the store a second
time. A bundle built before the export names no store and says so; nothing
re-derives the path from the environment at runtime.

## One recorded identity per artifact

The stamp sidecar (`build-stamp.json`) is the artifact's ONLY recorded
identity: `fingerprint` (the sources it was built from), `sources` (that input
list, per file — what lets a verdict NAME what moved), `payloadSha256`,
`builtAt`, the ags version and the stamp format.

`run.sh`'s cache-hit test IS the gate's own question — `bundle_stamp_verify`
over the recorded fingerprint and the payload's sha256. It keeps no second
fingerprint file: two recorded copies of one fact can disagree, and a build
interrupted between writing the payload and writing the sidecar must not leave
an artifact the cache serves as current while `npm run check:builds` calls it
stale, with no rebuild clearing it. Tests, checks and the cache therefore
answer one question with one implementation.

ONE INSTANT: a build captures its input list once (`bundle_inputs_capture`)
BEFORE the bundle is produced, the fingerprint IS that capture's hash
(`bundle_inputs_fingerprint`), and `bundle_stamp_record <artifact> <outfile>
<stampfile> <captured-file>` writes the sidecar from that same capture plus the
payload's own sha256 — so the recorded fingerprint, the recorded `sources` map
and the payload hash describe one artifact, never a fingerprint from one moment
and a source list from another. `bundle_fingerprint` (capture, then hash) is the
same rule for a caller that does not need the list: the receipt guards and the
gates.

The capture happens BEFORE the bundle is produced (both the normal build and the
`TINSHELL_BUNDLE_CACHE=0` bypass, and the greeter's own build path): the fingerprint
must name the sources the build READ, so a source edited during the build leaves
the artifact correctly marked stale instead of silently accepted.

## The gates

`scripts/build-all.sh` (`npm run build:all`) builds every artifact through the
ONE bundler and reports artifact → source fingerprint → destination plus the
store it wrote to. `scripts/check-builds.sh` (`npm run check:builds`) re-derives
each fingerprint from the current tree, names the store, and exits non-zero
naming every changed, added and removed source; `--quiet` is the boot probe (no
table, but the store, the per-artifact reason and the summary are still
printed).

Nothing here may weaken a check to make a verdict green: over-invalidate, never
under-invalidate. A false "stale" costs a rebuild, a false "fresh" ships the
wrong code.

## The same-run receipt (`TINSHELL_BUILD_RECEIPT`)

`tinshell-boot.sh` mints ONE receipt file for the boot run and hands the same path to
that run's warm and to the freshness probe, removing it when the probe is done.
`build-all.sh` writes the artifacts it left current with the fingerprint each
was verified against, plus the universal fingerprint of the tree it built from.
`check-builds.sh` honours the receipt only while its own universal fingerprint
still equals that one — a source edited anywhere after the warm voids it, which
the probe says out loud before re-deriving everything.

The scoping is the point: no receipt, no skip (a standalone `npm run
check:builds` always re-derives), and a moved tree, no skip. What the skip
trades on the boot path is the payload checksum for the artifacts the warm
verified moments earlier; the probe always states how many artifacts it verified
instead of checking, so the boot log never implies a check that did not happen.
Measured on this home: the probe costs 1647 ms re-deriving and 568 ms on the
receipt path.

`--force` is the only route that rebuilds regardless of the stamp, and the
`/etc/greetd` deploy stays root's (`apps/greeter/install.sh`); a stale verdict
naming the deployed bundle is expected on a machine whose greeter sources moved
and must never be suppressed.
