#!/usr/bin/env bash
# common/shell/run.sh — the ONE bundler used by every TINSHELL app.
#
# WHY bundle (not bare `ags run`): `ags run` writes a FIXED shared outfile
# ($XDG_RUNTIME_DIR/tinshell.js) and runs gjs on it. Two apps using `ags run` would
# clobber each other's outfile. `ags bundle` produces a self-contained bash
# wrapper that extracts its JS to a per-app HASHED outfile
# ($XDG_RUNTIME_DIR/<hash>-tinshell.js), so each app owns a distinct runtime file.
# This is the multi-app home's outfile-collision rule (see root AGENTS.md).
#
# BUNDLE CACHE: the esbuild step is cheap (~50-100ms) but pure
# re-work on every start — the bundle only changes when its inputs change. The
# built wrapper is cached in the artifact store (bundle_store_dir, one store
# shared with `npm run check:builds`) and reused while the artifact's STAMP
# sidecar says it is current: the cache-hit test IS the freshness gate's own
# question (`bundle_stamp_verify` over the recorded fingerprint and the
# payload's sha256), so the cache and the gate answer one question with one
# implementation and cannot call the same artifact current and stale. There is
# deliberately no second copy of the identity: a build that is interrupted
# between writing the payload and writing the stamp leaves an artifact the next
# start rebuilds, never one the cache calls current while the gate calls stale.
# The stamp covers the SOURCE SET (bundle_source_dirs: the app dir + common/,
# plus every app dir its sources name), the root build files and the build
# path's own scripts, by CONTENT — a `touch` no longer rebuilds, a real edit
# always does. @girs and the node_modules shim are NOT swept (typings are
# output-neutral and the system ags sources are covered by the version input).
# Escape hatches: TINSHELL_BUNDLE_CACHE=0 (bypass), TINSHELL_BUNDLE_FORCE=1 (rebuild).
# TINSHELL_BUNDLE_WARM=1 (used by tinshell-warm.service at boot) runs the normal
# cache/build logic but exits without launching the app — the bundle cache is
# warm so the real start at login is a cache hit (~0.7s instead of ~3.3s
# cold). A failed bundle NEVER serves the stale cache — it fails loud.
#
# BUNDLE GUARD: every build runs common/shell/bundle-guard.sh first — a source
# file with no code aborts it, and so does ANY esbuild diagnostic. esbuild
# treats a named import it cannot resolve (the empty-module case) as a
# WARNING and still exits 0, emitting `(void 0)(...)` that throws at mount
# and leaves a whole surface dead. See the guard's own header.
#
# BUILD STAMP: a successful build records common/shell/bundle-stamp.sh's
# build fingerprint in a sidecar (<cache>/build-stamp.json) and injects the
# same fingerprint into the wrapper as `TINSHELL_BUILD_STAMP`, so the running app
# can report which source state it was built from (npm run check:builds
# re-derives the fingerprint and names the inputs that changed).
#
# Usage 1 (per-app):  run.sh <app-name>
#   where <app-name> is the app dir under apps (e.g. "promptd", "notes").
#   Resolves the entry to <root>/apps/<app>/app.ts and the wrapper to
#   $XDG_RUNTIME_DIR/<app>-tinshell.wrapper.sh. Rebuilds only when the bundle
#   fingerprint changes (a source edit, a root build-file edit, a change in the
#   build path's own scripts, an ags version bump) — no separate build step.
#
# Usage 2 (universal host entry):  TINSHELL_HOST_ENTRY=<path>
#   TINSHELL_HOST_NAME=<name> run.sh <name> [extra argv...]
#   ONE static bundle (common/host/entry.ts) serves EVERY instance shape —
#   the app set is selected at RUNTIME from TINSHELL_HOST_SET/TINSHELL_HOST_INSTANCE
#   (set by tinshell-host.sh), so no code is ever generated. The cache dir is
#   <bundle_store_dir>/<TINSHELL_HOST_NAME>/ and the source set is apps/ +
#   common/ — the shell sweep, applied to every shape (the fingerprint adds the
#   root build files and the build path's own scripts to it).
#   The wrapper's JS outfile becomes an ENV REFERENCE
#   (${TINSHELL_HOST_INSTANCE:-shared}-tinshell.js) resolved at wrapper RUNTIME, so
#   every live instance extracts to its own file (a kill mid-extraction
#   can't truncate a file another instance is reading) while the wrapper
#   itself stays content-identical and shared. Extra argv is forwarded to
#   the entry's main() (cold-start "open <x>" parity with the per-app path).
#
# Each app also has a 1-line run.sh shim at apps/<app>/run.sh:
#   exec "$(dirname "$0")/../../common/shell/run.sh" <app>
# so the systemd unit's ExecStart stays per-app and absolute.
set -euo pipefail

[ $# -ge 1 ] || {
  echo "run.sh: missing app name (e.g. 'notes', 'promptd')" >&2
  exit 1
}
APP="$1"

# Universal host mode (see Usage 2 above): TINSHELL_HOST_ENTRY overrides the
# entry point; everything downstream keys off NAME (cache dir, outfile,
# fingerprint sweep) so the ONE bundle is shared by every instance shape.
HOST_ENTRY="${TINSHELL_HOST_ENTRY:-}"

# Resolve the TINSHELL home (repo root) by walking up until we find apps/.
# run.sh lives at <root>/common/shell/run.sh.
HOME_DIR="$(cd "$(dirname "$0")" && pwd)"
while [ "$HOME_DIR" != "/" ] && [ ! -d "$HOME_DIR/apps" ]; do
  HOME_DIR="$(dirname "$HOME_DIR")"
done
if [ ! -d "$HOME_DIR/apps" ]; then
  echo "run.sh: TINSHELL home not found (no apps/ above this script)" >&2
  exit 1
fi

# The build's refusal check (source integrity + esbuild-diagnostic-as-fatal)
# and the build stamp (the source fingerprint the artifact records).
# shellcheck source=common/shell/bundle-guard.sh
. "$HOME_DIR/common/shell/bundle-guard.sh"
# shellcheck source=common/shell/bundle-stamp.sh
. "$HOME_DIR/common/shell/bundle-stamp.sh"

APP_DIR="$HOME_DIR/apps/$APP"
# The source set — ONE definition, shared with the cache key, the bundle guard
# and the freshness check (bundle_source_dirs): apps/ + common/ for the
# universal host bundle (entry.ts can import anything), the app dir + common/
# + every app dir whose modules this app's sources name. `shell` was the
# universal bundle's name before the host distributor took over.
if [ -n "$HOST_ENTRY" ] || [ "$APP" = "shell" ]; then
  SWEEP_APP="universal"
else
  SWEEP_APP="$APP"
fi
mapfile -t SWEEP_DIRS < <(bundle_source_dirs "$HOME_DIR" "$SWEEP_APP")
ENTRY="$APP_DIR/app.ts"
if [ -n "$HOST_ENTRY" ]; then
  # Absolute or repo-relative entry path (tinshell-host.sh passes the repo-relative
  # common/host/entry.ts; resolve it against the home).
  case "$HOST_ENTRY" in
    /*) ENTRY="$HOST_ENTRY" ;;
    *) ENTRY="$HOME_DIR/$HOST_ENTRY" ;;
  esac
elif [ "$SWEEP_APP" = "universal" ]; then
  # The universal bundle answers to two names: TINSHELL_HOST_ENTRY (every instance
  # shape spawned by tinshell-host.sh) and the `shell` preset name used directly
  # (`run.sh shell`, the pre-distributor spelling that the docs and the
  # freshness workflow still use). Both are common/host/entry.ts — there is no
  # apps/shell app dir.
  ENTRY="$HOME_DIR/common/host/entry.ts"
fi
OUTFILE="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/$APP-tinshell.wrapper.sh"

[ -f "$ENTRY" ] || {
  echo "run.sh: entry not found: $ENTRY" >&2
  exit 1
}

CACHE_DIR="$(bundle_store_dir)/$APP"
# (in host mode APP == TINSHELL_HOST_NAME, passed by tinshell-host.sh — the universal
# bundle caches under tinshell-bundle/universal/)
CACHE_OUT="$CACHE_DIR/$APP-tinshell.wrapper.sh"
CACHE_STAMP="$CACHE_DIR/build-stamp.json"
CACHE_LOCK="$CACHE_DIR/.lock"

# A cache hit is the freshness gate's own verdict on this artifact: the stamp
# sidecar records the fingerprint the wrapper was built from and the payload's
# own sha256, and bundle_stamp_verify asks both. ONE recorded identity with ONE
# reader — a stamp-less, torn or hand-replaced artifact is a miss here exactly
# as it is a failure in `npm run check:builds`.
cache_hit() {
  [ -f "$CACHE_OUT" ] || return 1
  bundle_stamp_verify "$SWEEP_APP" "$CACHE_STAMP" "$CACHE_OUT" "${SWEEP_DIRS[@]}" 2>/dev/null
}

# Patch the wrapper's internal JS outfile to be per-app. `ags bundle` derives
# the JS outfile name from a hash of the bundle content — but every app's
# bundle starts with the same esbuild runtime prelude, so the hash COLLIDES
# across apps (both would write the same dmFyIF-tinshell.js, clobbering each
# other). Override it to a per-app name so each app owns a distinct runtime
# file. The wrapper's first non-shebang line is:
#   file="${XDG_RUNTIME_DIR:-/tmp}/<hash>-tinshell.js"
# In host mode the line becomes an ENV REFERENCE instead of a fixed per-app
# name: the wrapper expands ${TINSHELL_HOST_INSTANCE:-shared} at RUNTIME, so each
# live instance of the shared universal bundle extracts to its own file.
patch_js_outfile() {
  local wrapper="$1"
  if [ -n "$HOST_ENTRY" ]; then
    sed -i '1,/^file=/ s|^file=.*|file="${XDG_RUNTIME_DIR:-/tmp}/${TINSHELL_HOST_INSTANCE:-shared}-tinshell.js"|' "$wrapper"
  else
    local js="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/${APP}-tinshell.js"
    sed -i "1,/^file=/ s|^file=.*|file=\"${js}\"|" "$wrapper"
  fi
}

# One guarded build: source-integrity check → esbuild with its output
# captured → every diagnostic promoted to a failure. Returns 0 only when a
# bundle was actually written to <outfile>.
build_bundle() { # <outfile>
  local out="$1" log rc=0
  log="$(mktemp "${TMPDIR:-/tmp}/tinshell-bundle-log.XXXXXX")"
  bundle_guard_sources "$APP" "${SWEEP_DIRS[@]}" || rc=3
  if [ "$rc" -eq 0 ]; then
    # ags bundle resolves tsconfig paths (the @common/* alias) from the CWD,
    # not the entry file — bundle from the repo root so any caller cwd works.
    (cd "$HOME_DIR" && /usr/bin/ags bundle --gtk 4 "$ENTRY" "$out") >"$log" 2>&1 || rc=$?
    if [ "$rc" -ne 0 ]; then
      if [ -s "$log" ]; then cat "$log" >&2; fi
      rm -f "$log"
      return 3
    fi
    if ! bundle_guard_diagnostics "$APP" "$log"; then
      rm -f "$log"
      return 3
    fi
  fi
  rm -f "$log"
  return "$rc"
}

# Launch the built wrapper — unless TINSHELL_BUNDLE_WARM=1 (boot-time pre-warm:
# build the cache, then exit without starting the app).
launch() {
  if [ "${TINSHELL_BUNDLE_WARM:-0}" = "1" ]; then
    echo "[bundle-cache] $APP: warmed (no launch)" >&2
    exit 0
  fi
  exec "$@"
}

if [ "${TINSHELL_BUNDLE_CACHE:-1}" = "0" ]; then
  echo "[bundle-cache] $APP: bypass (TINSHELL_BUNDLE_CACHE=0)" >&2
  # Captured before the build, never after: the fingerprint must name the
  # sources this build READ, so a source edited during the build leaves the
  # artifact correctly marked stale instead of silently accepted. The capture is
  # also the list the sidecar would record — one instant, one derivation.
  INPUTS="$(mktemp "${TMPDIR:-/tmp}/tinshell-inputs.XXXXXX")"
  bundle_inputs_capture "$INPUTS" "${SWEEP_DIRS[@]}"
  FP="$(bundle_inputs_fingerprint "$INPUTS")"
  if ! build_bundle "$OUTFILE"; then
    rm -f "$INPUTS"
    echo "[bundle-cache] $APP: bundle FAILED — nothing to launch" >&2
    exit 3
  fi
  patch_js_outfile "$OUTFILE"
  # Throwaway build: the wrapper still carries its stamp (so a debug run
  # reports what it was built from), but no sidecar is recorded for it.
  bundle_stamp_inject "$OUTFILE" "$SWEEP_APP" "$FP"
  rm -f "$INPUTS"
  launch "$OUTFILE" "${@:2}"
fi

if [ "${TINSHELL_BUNDLE_FORCE:-0}" != "1" ] && cache_hit; then
  echo "[bundle-cache] $APP: hit" >&2
  launch "$CACHE_OUT" "${@:2}"
fi

# Build (serialized per app — a systemd restart and a keybind cold start can
# race; flock makes one build, the other takes the fresh result).
mkdir -p "$CACHE_DIR"
(
  flock 9
  if [ "${TINSHELL_BUNDLE_FORCE:-0}" != "1" ] && cache_hit; then
    exit 2 # a peer built it while we waited
  fi
  TMP_OUT="$(mktemp "$CACHE_DIR/.wrapper.XXXXXX")"
  # See the bypass path: the input list is captured ONCE here — before the
  # bundle is produced — and its hash is the fingerprint that goes into the
  # wrapper, while the SAME captured list becomes the sidecar's `sources`. An
  # artifact's identity and the evidence a stale verdict names are therefore one
  # derivation from one instant.
  INPUTS="$(mktemp "${TMPDIR:-/tmp}/tinshell-inputs.XXXXXX")"
  bundle_inputs_capture "$INPUTS" "${SWEEP_DIRS[@]}"
  FP="$(bundle_inputs_fingerprint "$INPUTS")"
  if ! build_bundle "$TMP_OUT"; then
    rm -f "$TMP_OUT" "$INPUTS"
    echo "[bundle-cache] $APP: bundle FAILED — stale cache not served" >&2
    exit 3
  fi
  patch_js_outfile "$TMP_OUT"
  bundle_stamp_inject "$TMP_OUT" "$SWEEP_APP" "$FP"
  chmod 755 "$TMP_OUT" # mktemp is 0600; match ags bundle's 755 output
  mv -f "$TMP_OUT" "$CACHE_OUT"
  bundle_stamp_record "$SWEEP_APP" "$CACHE_OUT" "$CACHE_STAMP" "$INPUTS"
  rm -f "$INPUTS"
) 9>"$CACHE_LOCK"
rc=$?

if [ "$rc" -eq 2 ]; then
  echo "[bundle-cache] $APP: hit (built by peer)" >&2
elif [ "$rc" -ne 0 ]; then
  echo "[bundle-cache] $APP: build failed (rc=$rc)" >&2
  exit "$rc"
else
  echo "[bundle-cache] $APP: built" >&2
fi

launch "$CACHE_OUT" "${@:2}"
