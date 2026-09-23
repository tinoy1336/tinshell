#!/usr/bin/env bash
# scripts/build-all.sh — ONE command that builds every artifact the repo ships
# (`npm run build:all`).
#
# WHY: the shipped artifacts are snapshots — the universal bundle the shell
# warms, the per-app caches the boot fleet falls back on, the greeter login
# bundle and the in-session lock bundle. Each one used to be built by whatever
# happened to need it, so an artifact could silently predate the sources it
# runs. This builds all of them through the ONE bundler
# (common/shell/run.sh / apps/greeter/build*.sh — the same esbuild invocation,
# the same bundle guard, the same stamp), and every artifact that is already
# built from the current sources is a cheap no-op: nothing is re-emitted unless
# a source, the toolchain or the ags version actually changed.
#
# The privileged half is NOT here: the greeter bundle reaches /etc/greetd/
# through apps/greeter/install.sh, run as root on its own (one approval). This
# script never escalates — it writes only into the artifact store
# (bundle_store_dir) and ./dist.
#
# THE STORE: every cache artifact is built into the store resolved by
# bundle_store_dir (common/shell/bundle-stamp.sh) — the SAME call
# `npm run check:builds` reads through, so a build and a check cannot look at
# different stores. The summary names the store it wrote to.
#
# THE RECEIPT (`TINSHELL_BUILD_RECEIPT`): when the caller mints a path for ONE run
# (tinshell-boot.sh does, and hands the same path to this warm and to the freshness
# probe that follows), the artifacts left current here are written to it with
# the fingerprint each was verified against, plus ONE universal fingerprint of
# the source tree this run built from. The probe of that same run trusts those
# artifacts only while its own universal fingerprint still equals the receipt's
# — a source edited anywhere after the warm voids the receipt and that probe
# re-derives everything. A run that did not mint a receipt writes none and
# nothing reads one, so a standalone check is unaffected; see
# scripts/check-builds.sh for what the skip trades (the payload checksum).
#
# Usage: build-all.sh [--force] [--quiet]
#   --force   rebuild every artifact even when the sources are unchanged
#   --quiet   print failures and the summary only (the boot warm step)

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=common/shell/bundle-stamp.sh
. "$ROOT/common/shell/bundle-stamp.sh"
# shellcheck source=scripts/artifacts.sh
. "$ROOT/scripts/artifacts.sh"

FORCE="${TINSHELL_BUNDLE_FORCE:-0}"
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --quiet) QUIET=1 ;;
    -h | --help)
      echo "usage: build-all.sh [--force] [--quiet]"
      echo "  builds: the universal bundle, every app's bundle cache, the greeter"
      echo "          login bundle and the lock bundle (dist/)"
      echo "  the /etc/greetd deploy is separate: apps/greeter/install.sh (root)"
      exit 0
      ;;
    *)
      echo "build-all.sh: unknown argument '$arg' (see --help)" >&2
      exit 1
      ;;
  esac
done

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }

# Per-build hard ceiling: a bundler that hangs must not hold the build (or the
# boot warm step caller) in the foreground forever.
TIMEOUT_UNIVERSAL=300
TIMEOUT_APP=120
TIMEOUT_GREETER=300

# The stamp file's write time, in nanoseconds: the before/after test below asks
# "did this run re-emit the artifact", and a forced rebuild inside one second
# must not be reported as "up to date".
stamp_written_at() { # <stampfile> → mtime or empty
  [ -f "$1" ] && stat -c %.9Y "$1" 2>/dev/null || true
}
stamp_fp() { [ -f "$1" ] && jq -r '.fingerprint // empty' "$1" 2>/dev/null || true; }
short_fp() { printf '%s' "${1:0:12}"; }
pretty_path() { printf '%s' "${1/#$HOME/~}"; }

# One artifact build. Prints nothing on success; the caller attributes
# failures. Keeps a failing artifact from aborting the run — the point of the
# command is a complete, honest picture of every artifact.
build_one() { # <name> <app> <kind>
  local name="$1" app="$2" kind="$3"
  case "$kind:$name" in
    cache:universal)
      timeout "$TIMEOUT_UNIVERSAL" "$ROOT/common/shell/tinshell-host.sh" warm shell
      ;;
    cache:*)
      TINSHELL_BUNDLE_WARM=1 TINSHELL_BUNDLE_FORCE="$FORCE" \
        timeout "$TIMEOUT_APP" "$ROOT/common/shell/run.sh" "$app"
      ;;
    dist:greeter)
      local args=()
      [ "$FORCE" = 1 ] && args+=(--force)
      timeout "$TIMEOUT_GREETER" "$ROOT/apps/greeter/build.sh" "${args[@]}"
      ;;
    dist:greeter-lock)
      local args=()
      [ "$FORCE" = 1 ] && args+=(--force)
      timeout "$TIMEOUT_GREETER" "$ROOT/apps/greeter/build-lock.sh" "${args[@]}"
      ;;
    *)
      echo "build-all: nothing to build for '$name' (kind $kind)" >&2
      return 1
      ;;
  esac
}

built=0
kept=0
failed=""
started=$SECONDS
rows=()
receipt=()
STORE="$(bundle_store_dir)"
RECEIPT_FILE="${TINSHELL_BUILD_RECEIPT:-}"
while IFS=$'\t' read -r name app out stamp kind; do
  [ -n "$name" ] || continue
  [ "$kind" = "deployed" ] && continue
  before="$(stamp_written_at "$stamp")"
  rc=0
  build_one "$name" "$app" "$kind" >/dev/null 2>&1 || rc=$?
  after="$(stamp_written_at "$stamp")"
  fp="$(stamp_fp "$stamp")"
  if [ "$rc" -ne 0 ]; then
    failed="$failed $name"
    rows+=("$(printf '%-16s %-14s %-8s %s' "$name" "FAILED" "rc=$rc" "$(pretty_path "$out")")")
    continue
  fi
  if [ -n "$after" ] && [ "$after" != "$before" ]; then
    state="built"
    built=$((built + 1))
  else
    state="up to date"
    kept=$((kept + 1))
  fi
  rows+=("$(printf '%-16s %-14s %-8s %s' "$name" "$state" "$(short_fp "$fp")" "$(pretty_path "$out")")")
  # Current at this instant, as verified by the build path itself (run.sh and
  # apps/greeter/bundle.sh both ask the freshness gate's own question).
  [ -z "$fp" ] || receipt+=("$(printf '%s\t%s' "$name" "$fp")")
done < <(artifact_rows)

if [ -n "$RECEIPT_FILE" ]; then
  # The universal sweep covers EVERY input any artifact's fingerprint is taken
  # over (each artifact's source set is a subset of apps/ + common/, and this
  # sweep folds in the fixed build files and the build-path scripts), so a probe
  # that finds this value unchanged has proved the tree the warm verified.
  mapfile -t RECEIPT_DIRS < <(bundle_source_dirs "$ROOT" universal)
  tree_fp="$(bundle_fingerprint "${RECEIPT_DIRS[@]}")"
  if [ "${#receipt[@]}" -gt 0 ] &&
    printf 'tree\t%s\n' "$tree_fp" >"$RECEIPT_FILE" 2>/dev/null &&
    printf '%s\n' "${receipt[@]}" >>"$RECEIPT_FILE" 2>/dev/null; then
    say "build-all: receipt for this run's freshness probe: $(pretty_path "$RECEIPT_FILE") (tree ${tree_fp:0:12}, ${#receipt[@]} verified)"
  else
    say "build-all: no receipt written ($(pretty_path "$RECEIPT_FILE"))"
  fi
fi

if [ "$QUIET" != 1 ]; then
  printf '%s\n' "artifact         status         sources      destination"
  for r in "${rows[@]}"; do printf '%s\n' "$r"; done
fi

elapsed=$((SECONDS - started))
if [ -n "${failed// /}" ]; then
  printf 'build-all: FAILED:%s — nothing stale was served (a failed build keeps the last good artifact)\n' "$failed" >&2
  for r in "${rows[@]}"; do
    case "$r" in *FAILED*) printf '%s\n' "$r" >&2 ;; esac
  done
  printf 'build-all: %ss (%s built, %s up to date)\n' "$elapsed" "$built" "$kept" >&2
  exit 3
fi
say "build-all: ${elapsed}s — $built built, $kept up to date in $(pretty_path "$STORE"); the /etc/greetd deploy is separate (apps/greeter/install.sh)"
