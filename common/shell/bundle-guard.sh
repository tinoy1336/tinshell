#!/usr/bin/env bash
# common/shell/bundle-guard.sh — the bundle build's refusal check.
#
# WHY THIS EXISTS: esbuild is ADVISORY about a named import it cannot resolve
# against a module that has no import/export syntax. It sniffs such a file as
# CommonJS, satisfies the binding with `undefined`, emits `(void 0)(...)` into
# the bundle, and EXITS 0. A zero-byte module — the artifact a power loss
# leaves behind when it interrupts a write — therefore produced a bundle that
# loaded perfectly and threw `TypeError: (void 0) is not a function` the
# moment the imported function ran. The dock mounts its applet loop first, so
# that throw left the applet row unfinalised: one blank disc at the origin,
# no band, no backdrop, no input region, and no error anywhere the user would
# see it. A build that fails loudly costs nothing by comparison.
#
# `ags bundle` owns its esbuild invocation and exposes no log-level or
# warn-as-error flag, so the refusal is implemented here, on the ONE bundler
# wrapper every app and every host shape goes through (common/shell/run.sh;
# the greeter's own build scripts source this file too). The two checks:
#
#   1. bundle_guard_sources     — refuse a source file with no code at all
#                                 (zero bytes, or whitespace/comment-free
#                                 whitespace only) and name it plus its
#                                 importers.
#   2. bundle_guard_diagnostics — promote EVERY esbuild diagnostic to fatal.
#
# COST: both run only when a bundle is actually rebuilt, never on a cache hit.
# One `find` plus one `grep` pass over the importable source set (327 files,
# ~2.5 MB across apps/ + common/): a few milliseconds against a ~0.23 s
# bundle. There is deliberately NO typecheck — esbuild's own diagnostics are
# the signal, and a full tsc pass costs orders of magnitude more than the
# bundle it would guard.

# Extensions esbuild can import. config*.json is read at RUNTIME by the config
# loader and is never imported, so it is deliberately out of scope.
bundle_guard_find() { # <dir>...
  find "$@" -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
    -o -name '*.mjs' -o -name '*.css' \) -print0 2>/dev/null
}

# bundle_guard_sources <label> <dir>...  → non-zero when a source is unusable.
# Prints every offending file, its importer(s), and the reason.
bundle_guard_sources() {
  local label="$1"
  shift
  local bad f why base who
  # -L lists the files in which NO line contains a non-whitespace character:
  # one pass over the whole set, so a zero-byte file and a whitespace-only one
  # are both caught by the same rule.
  bad="$(bundle_guard_find "$@" | xargs -0 -r grep -LE '[^[:space:]]' 2>/dev/null || true)"
  [ -n "$bad" ] || return 0

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -s "$f" ]; then why="whitespace only"; else why="zero bytes"; fi
    base="$(basename "$f")"
    base="${base%.*}"
    # Name the importer too: the offending file is unusable, but the module
    # that asked for a named binding from it is the call site that throws.
    who="$(grep -rlE "[\"'][^\"']*/${base}(\.(ts|tsx|js|jsx))?[\"']" \
      --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
      "$@" 2>/dev/null | grep -vFx -- "$f" | head -n 5 || true)"
    printf '%s\n' "[bundle-guard] $label: SOURCE FILE HAS NO CODE ($why): $f" >&2
    if [ -n "$who" ]; then
      printf '%s\n' "[bundle-guard]   imported by: $(printf '%s' "$who" | tr '\n' ' ')" >&2
    else
      printf '%s\n' "[bundle-guard]   imported by: (no module imports it)" >&2
    fi
  done <<<"$bad"

  printf '%s\n' \
    "[bundle-guard] $label: build REFUSED — an empty module satisfies a named import with 'undefined' and esbuild still exits 0" >&2
  return 1
}

# bundle_guard_diagnostics <label> <logfile>  → non-zero when esbuild warned.
# The log carries the build's combined output; esbuild marks a diagnostic with
# a literal WARNING/ERROR token inside its ANSI-coloured pager block, so the
# match needs no escape stripping.
bundle_guard_diagnostics() {
  local label="$1" log="$2"
  [ -s "$log" ] || return 0

  if ! grep -qaE 'WARNING|ERROR' "$log"; then
    printf '%s\n' "[bundle-guard] $label: build output:" >&2
    cat "$log" >&2
    return 0
  fi

  printf '%s\n' "[bundle-guard] $label: esbuild diagnostics — bundle REFUSED" >&2
  cat "$log" >&2
  printf '%s\n' \
    "[bundle-guard] an unresolved or undefined export bundles without error and throws at mount" \
    "[bundle-guard] (\"TypeError: (void 0) is not a function\") — fix the module named above" >&2
  return 1
}
