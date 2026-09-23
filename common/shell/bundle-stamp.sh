#!/usr/bin/env bash
# common/shell/bundle-stamp.sh — the source fingerprint an artifact was built
# from, and the freshness verdict on that artifact.
#
# WHY THIS EXISTS: every shipped artifact is a SNAPSHOT of the repo inlined at
# build time — the universal bundle, the per-app caches, the greeter login
# bundle and the in-session lock bundle. Nothing about the artifact says which
# source state produced it, so a bundle built before an edit keeps running the
# old code with no signal anywhere, and a deployed copy in /etc/greetd/ is even
# further from the sources it came from. This module records that identity
# (`bundle_stamp_record`) and re-derives it (`bundle_stamp_verify`), so a
# build no-op, a deploy, and `npm run check:builds` all answer the same
# question with the same implementation.
#
# SOURCE SET: `bundle_source_dirs` is the ONE definition of which files an
# artifact is a function of. The universal bundle can import anything, so it
# sweeps apps/ + common/; a per-app bundle sweeps its own dir + common/ PLUS
# every other app dir its own sources name through the `@apps/<app>/…` alias
# (esbuild INLINES that module — apps/portal/window.tsx imports
# `@apps/files/fs`, so an edit there changes the portal bundle).
# `common/shell/run.sh` sweeps exactly this set for its cache key and its
# bundle guard, so cache invalidation, the guard's refusal and the freshness
# verdict cannot disagree.
#
# FINGERPRINT: sha256 over ONE input list (`bundle_fingerprint_inputs`) — the
# source set, the root build files (tsconfig.json, env.d.ts, package.json —
# content, not mtime), the build path's own scripts (run.sh, bundle-guard.sh,
# bundle-stamp.sh: a change in the patch/guard logic changes the artifact) and
# the two non-file inputs (the ags version, the stamp format). That list is
# CAPTURED once per build (`bundle_inputs_capture`) and the fingerprint IS its
# sha256 (`bundle_inputs_fingerprint`): the value an artifact is identified by
# and the per-file list a verdict diffs are therefore one derivation, taken at
# one instant — never a fingerprint from one moment and a source list from
# another. `run.sh`'s cache key IS this fingerprint, so a build and a check
# cannot disagree. Over-invalidate, never under-invalidate: a false "stale"
# costs a rebuild, a false "fresh" ships the wrong code.
#
# STAMP: a JSON sidecar next to the artifact recording the artifact name, the
# destination, the fingerprint, the ags version, the build time and the
# per-input hashes (that is what lets a check NAME the input that changed), plus
# the artifact's own sha256 — so a payload swapped after the build (a restored
# backup, a hand-run `ags bundle`) is caught instead of being trusted. The
# recorded fingerprint and the recorded source list are the SAME capture, and
# the payload hash is of the payload that lands, so the three facts in one
# sidecar describe one artifact; a build interrupted before the sidecar is
# rewritten leaves the previous sidecar against the new payload, which both
# gates read as not current — the cache test IS the gate's own question.
#
# STORE: `bundle_store_dir` is the ONE resolution of the artifact store root
# (`<XDG_CACHE_HOME>/tinshell-bundle`, the user cache by default). The store holds
# every built artifact AND its stamp sidecar, so it is the identity of an
# artifact, not a disposable cache — the bundler (run.sh) writes it, the
# registry (scripts/artifacts.sh) locates artifacts in it, and both gates read
# it. A second spelling of this path is a second store: the build would fill
# one and the check would read the other, and every artifact would then read
# stale no matter how often it is rebuilt. Every consumer resolves it here, and
# every built wrapper carries its own store as `TINSHELL_BUILD_STORE` (written by
# `bundle_stamp_inject`), so a RUNNING bundle can name the store it belongs to
# without spelling it a second time anywhere.
#
# Sourcing this file runs nothing; it also pulls in bundle-guard.sh (the source
# set is defined once, by the guard's extension list).

BUNDLE_STAMP_FORMAT=2

_BUNDLE_STAMP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_BUNDLE_STAMP_ROOT="$(cd "$_BUNDLE_STAMP_DIR/../.." && pwd)"
# shellcheck source=common/shell/bundle-guard.sh
. "$_BUNDLE_STAMP_DIR/bundle-guard.sh"

# bundle_store_dir → the artifact store root. The build path and both
# freshness gates MUST resolve the store through this call, so a build and a
# check cannot look at different stores.
bundle_store_dir() {
  printf '%s/tinshell-bundle' "${XDG_CACHE_HOME:-$HOME/.cache}"
}

# bundle_source_dirs <root> <app> → one directory per line.
# <app> = an apps/<app> dir name, or "universal" for the shared host bundle.
bundle_source_dirs() {
  local root="$1" app="$2" dep
  if [ "$app" = "universal" ]; then
    printf '%s\n' "$root/apps" "$root/common"
    return 0
  fi
  [ -d "$root/apps/$app" ] || {
    echo "bundle-stamp: no such app dir: $root/apps/$app" >&2
    return 1
  }
  printf '%s\n' "$root/apps/$app" "$root/common"
  # Cross-app imports: @apps/<name>/… resolves through the npm workspace links
  # and esbuild inlines the module, so that app's dir is part of this
  # artifact's source set.
  grep -rhoE '@apps/[A-Za-z0-9_-]+' "$root/apps/$app" \
    --include='*.ts' --include='*.tsx' --include='*.css' 2>/dev/null |
    sed 's|@apps/||' | sort -u | while read -r dep; do
      [ -n "$dep" ] || continue
      [ "$dep" = "$app" ] && continue
      [ -d "$root/apps/$dep" ] && printf '%s\n' "$root/apps/$dep"
    done
}

# bundle_source_hashes <dir>... → "<sha256>\t<path>" per file, sorted by path.
# The file list is bundle_guard_find's (the importable extension set), so a
# runtime-only file (config*.json, *.md, *.sh) never enters a fingerprint.
bundle_source_hashes() {
  bundle_guard_find "$@" | sort -z |
    xargs -0 -r sha256sum 2>/dev/null |
    awk -F'  ' 'NF==2 {print $1 "\t" $2}' | sort -t$'\t' -k2
}

# bundle_fingerprint_inputs <dir>... → "<sha256>\t<key>" for EVERY input the
# fingerprint is taken over, sorted by key: the source set's files, the root
# build files, the build path's own scripts, and the two inputs that are not
# files (the ags version, the stamp format). ONE list with three consumers —
# bundle_fingerprint below, the stamp's recorded `sources` map and
# bundle_stamp_verify's diff — so an input folded in here is an input the
# verdict can always name.
bundle_fingerprint_inputs() {
  local f
  {
    bundle_source_hashes "$@"
    for f in "$_BUNDLE_STAMP_ROOT/tsconfig.json" "$_BUNDLE_STAMP_ROOT/env.d.ts" \
      "$_BUNDLE_STAMP_ROOT/package.json" "$_BUNDLE_STAMP_DIR/run.sh" \
      "$_BUNDLE_STAMP_DIR/bundle-guard.sh" "$_BUNDLE_STAMP_DIR/bundle-stamp.sh"; do
      [ -f "$f" ] || continue
      printf '%s\t%s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
    done
    printf '%s\ttinshell-version\n' \
      "$(printf '%s' "$(ags --version 2>/dev/null | head -n1 || true)" | sha256sum | cut -d' ' -f1)"
    printf '%s\tstamp-format\n' \
      "$(printf '%s' "$BUNDLE_STAMP_FORMAT" | sha256sum | cut -d' ' -f1)"
  } | sort -t$'\t' -k2
}

# bundle_inputs_capture <file> <dir>... → derive the input list ONCE and keep
# it. This is the list BOTH the fingerprint and the sidecar's `sources` map come
# from, so a build's identity and the evidence a stale verdict names cannot
# describe different instants.
bundle_inputs_capture() {
  local file="$1"
  shift
  bundle_fingerprint_inputs "$@" >"$file"
}

# bundle_inputs_fingerprint <captured-file> → the sha256 of a captured input
# list. The fingerprint rule lives here alone: a captured list and the value an
# artifact is identified by are the same bytes through the same hash.
bundle_inputs_fingerprint() {
  sha256sum "$1" | cut -d' ' -f1
}

# bundle_fingerprint <dir>... → the sha256 the artifact is identified by, for a
# caller that does not need the list itself (the receipt guards, the freshness
# gates): capture once, then fingerprint the capture, so there is one rule.
bundle_fingerprint() {
  local tmp fp
  tmp="$(mktemp "${TMPDIR:-/tmp}/tinshell-inputs.XXXXXX")" || return 1
  bundle_inputs_capture "$tmp" "$@" || {
    rm -f "$tmp"
    return 1
  }
  fp="$(bundle_inputs_fingerprint "$tmp")"
  rm -f "$tmp"
  printf '%s\n' "$fp"
}

# bundle_stamp_inject <outfile> <artifact> <fingerprint> [epoch]
# The built wrapper is a bash script, so the stamp rides INTO the artifact as
# env exports: the app reports it at startup without reading any file, and a
# bundle that was copied somewhere else still carries its own identity —
# including WHICH artifact store it belongs to (TINSHELL_BUILD_STORE), so a running
# process names the store from its own bytes instead of resolving the store a
# second time (a second spelling is what makes a build and a check disagree).
bundle_stamp_inject() {
  local out="$1" artifact="$2" fp="$3" when="${4:-$(date +%s)}" store
  store="$(bundle_store_dir)"
  sed -i "1,/^file=/ s|^file=.*|&\nexport TINSHELL_BUILD_STORE=\"${store}\"\nexport TINSHELL_BUILD_STAMP=\"${artifact} ${fp} ${when}\"|" "$out"
}

# bundle_stamp_record <artifact> <outfile> <stampfile> <captured-inputs-file>
# Writes the sidecar atomically from ONE capture: the recorded fingerprint is
# the capture's hash, the recorded `sources` map is that same capture, and the
# payload hash is the payload in place. Never called for a failed or partial
# build.
bundle_stamp_record() {
  local artifact="$1" out="$2" stamp="$3" inputs="$4"
  command -v jq >/dev/null || {
    echo "bundle-stamp: jq required to write $stamp" >&2
    return 1
  }
  [ -f "$inputs" ] || {
    echo "bundle-stamp: no captured input list at $inputs" >&2
    return 1
  }
  local tmp fp payload
  tmp="$(mktemp "${stamp}.XXXXXX")" || return 1
  fp="$(bundle_inputs_fingerprint "$inputs")"
  payload="$(sha256sum "$out" | cut -d' ' -f1)"
  if ! jq -R -s --arg artifact "$artifact" --arg out "$out" --arg fp "$fp" \
    --arg ver "$(ags --version 2>/dev/null | head -n1 || true)" \
    --arg payload "$payload" --argjson builtAt "$(date +%s)" \
    --argjson format "$BUNDLE_STAMP_FORMAT" '
        [splits("\n") | select(length > 0) | split("\t")
         | {key: .[1], value: .[0]}] | from_entries as $files
        | {artifact: $artifact, out: $out, fingerprint: $fp,
           tinshellVersion: $ver, format: $format, builtAt: $builtAt,
           payloadSha256: $payload, sources: $files}' \
    <"$inputs" >"$tmp"; then
    rm -f "$tmp"
    echo "bundle-stamp: could not write $stamp" >&2
    return 1
  fi
  chmod 644 "$tmp"
  mv -f "$tmp" "$stamp"
}

# bundle_stamp_field <stampfile> <field> → value, empty when absent.
bundle_stamp_field() {
  local stamp="$1" field="$2"
  [ -f "$stamp" ] || return 1
  jq -r --arg f "$field" '.[$f] // empty' "$stamp" 2>/dev/null
}

# bundle_stamp_verify <artifact> <stampfile> <outfile> <dir>...
# 0 = the artifact matches the current tree; non-zero = stale/unknown, with
# the artifact, the reason and every changed input named on stderr.
bundle_stamp_verify() {
  local artifact="$1" stamp="$2" out="$3"
  shift 3
  local recorded payload current now rec_tmp cur_tmp
  if [ ! -f "$stamp" ]; then
    echo "$artifact: NO BUILD STAMP — $out was not built by this repo's build path (or predates stamping)" >&2
    return 1
  fi
  if [ ! -f "$out" ]; then
    echo "$artifact: MISSING — $out is not there (stamp $stamp)" >&2
    return 1
  fi
  payload="$(sha256sum "$out" | cut -d' ' -f1)"
  recorded="$(bundle_stamp_field "$stamp" payloadSha256 || true)"
  if [ "$payload" != "$recorded" ]; then
    echo "$artifact: PAYLOAD MODIFIED — $out does not match its own stamp (replaced after the build)" >&2
    return 1
  fi
  now="$(bundle_fingerprint "$@")"
  recorded="$(bundle_stamp_field "$stamp" fingerprint || true)"
  if [ "$now" = "$recorded" ]; then
    return 0
  fi
  echo "$artifact: STALE — inputs changed since it was built:" >&2
  rec_tmp="$(mktemp "${TMPDIR:-/tmp}/tinshell-stamp-rec.XXXXXX")"
  cur_tmp="$(mktemp "${TMPDIR:-/tmp}/tinshell-stamp-cur.XXXXXX")"
  jq -r '.sources // {} | to_entries[] | "\(.value)\t\(.key)"' "$stamp" 2>/dev/null |
    sort -t$'\t' -k2 >"$rec_tmp"
  bundle_fingerprint_inputs "$@" >"$cur_tmp"
  awk -F'\t' '
    NR == FNR { rec[$2] = $1; next }
    { cur[$2] = $1 }
    END {
      for (p in cur) {
        if (!(p in rec)) print "  added    " p
        else if (rec[p] != cur[p]) print "  changed  " p
      }
      for (p in rec) if (!(p in cur)) print "  removed  " p
    }' "$rec_tmp" "$cur_tmp" | sort -k2 >&2
  rm -f "$rec_tmp" "$cur_tmp"
  return 1
}
