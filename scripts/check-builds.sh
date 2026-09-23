#!/usr/bin/env bash
# scripts/check-builds.sh — the freshness gate for every shipped artifact
# (`npm run check:builds`).
#
# Each artifact records, at build time, the fingerprint of the sources it was
# built from (common/shell/bundle-stamp.sh). This re-derives every fingerprint
# from the CURRENT tree and compares — so a bundle that predates an edit, a
# payload that was replaced after its build, and a /etc/greetd deploy that no
# longer matches the sources are all caught here, by name, before a surface
# runs stale code. The gap in shape to `npm run check:schemas`: that one
# regenerates and compares a generated ARTIFACT in the tree, this one compares
# built artifacts against the sources they claim to be built from.
#
# THE STORE: the cache artifacts live in the artifact store, resolved by
# bundle_store_dir (common/shell/bundle-stamp.sh) — the same call the bundler
# writes through. Every verdict therefore names the store it read, and a
# verdict where NOTHING was built there is reported as such: a build whose
# artifacts landed in another store (an XDG_CACHE_HOME override in the calling
# environment) makes every artifact read stale however often it is rebuilt, and
# a verdict that hides which store it looked at is unreadable.
#
# SAME-RUN VERIFICATION (the boot path only): `build-all.sh` writes the
# artifacts it left current — with the fingerprint each one was verified
# against — to the file named by TINSHELL_BUILD_RECEIPT, a path its caller mints for
# ONE run (tinshell-boot.sh hands the same path to the warm and to this probe), and
# it writes alongside them the universal fingerprint of the whole source tree
# it built from. The receipt is honoured only while this probe's own universal
# fingerprint still equals that one: a source edited anywhere after the warm
# voids the receipt, this probe says so and re-derives every artifact. The skip
# is therefore scoped by construction twice over — no receipt, no skip, and a
# moved tree, no skip — and a check outside that run always re-derives
# everything. What the skip trades on the boot path is the payload checksum for
# artifacts the warm verified moments earlier; the summary states how many
# artifacts were skipped rather than checked.
#
# Exit: 0 all fresh; 1 one or more artifacts stale/unbuilt; the named artifact
# and the named changed sources are printed.
#
# The greeter deploy (/etc/greetd/ags-greeter.sh) is checked when it is
# deployed; a machine that never deployed it is not a failure (the artifact is
# absent, not stale).

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
    --quiet) QUIET=1 ;;
    -h | --help)
      echo "usage: check-builds.sh [--quiet]"
      echo "  --quiet  print the verdict summary only (the boot freshness probe)"
      exit 0
      ;;
    *)
      echo "check-builds.sh: unknown argument '$arg' (see --help)" >&2
      exit 1
      ;;
  esac
done

STORE="$(bundle_store_dir)"
pretty_path() { printf '%s' "${1/#$HOME/~}"; }
short_fp() { printf '%s' "${1:0:12}"; }

# The same-run verification receipt (see the header): a `tree` line carrying
# the universal fingerprint the warm built from, then <name>\t<fingerprint>.
declare -A VERIFIED=()
RECEIPT="${TINSHELL_BUILD_RECEIPT:-}"
if [ -n "$RECEIPT" ] && [ -r "$RECEIPT" ]; then
  receipt_tree=""
  while IFS=$'\t' read -r rname rfp; do
    [ -n "$rname" ] || continue
    if [ "$rname" = "tree" ]; then
      receipt_tree="$rfp"
    elif [ -n "$rfp" ]; then
      VERIFIED["$rname"]="$rfp"
    fi
  done <"$RECEIPT"
  if [ "${#VERIFIED[@]}" -gt 0 ]; then
    # The skip is sound only while the tree is the one the warm built from: the
    # universal sweep covers every input any artifact's fingerprint is taken
    # over, so ONE derivation here answers that for the whole run.
    mapfile -t receipt_dirs < <(bundle_source_dirs "$ROOT" universal)
    if [ "$receipt_tree" != "$(bundle_fingerprint "${receipt_dirs[@]}")" ]; then
      VERIFIED=()
      printf 'check-builds: this run'\''s build-all receipt is void — the sources moved since the warm; re-deriving every artifact\n' >&2
    fi
  fi
fi

fresh=0
verified=0
stale=0
unbuilt=0
stale_names=""
[ "$QUIET" = 1 ] || printf '%s\n' "artifact         verdict     sources      destination"
while IFS=$'\t' read -r name app out stamp kind; do
  [ -n "$name" ] || continue
  if [ "$kind" = "deployed" ] && [ ! -e "$out" ]; then
    [ "$QUIET" = 1 ] ||
      printf '%-16s %-11s %-12s %s\n' "$name" "not deployed" "-" "$(pretty_path "$out")"
    continue
  fi
  # Verified by this run's build-all: the stamp still carries the fingerprint
  # that was verified, and the payload is still there. No re-derivation here.
  if [ -n "${VERIFIED[$name]:-}" ] && [ -f "$out" ] && [ -f "$stamp" ] &&
    [ "$(bundle_stamp_field "$stamp" fingerprint || true)" = "${VERIFIED[$name]}" ]; then
    [ "$QUIET" = 1 ] ||
      printf '%-16s %-11s %-12s %s\n' "$name" "verified" \
        "$(short_fp "${VERIFIED[$name]}")" "$(pretty_path "$out")"
    verified=$((verified + 1))
    continue
  fi
  mapfile -t dirs < <(bundle_source_dirs "$ROOT" "$app")
  detail=""
  if detail="$(bundle_stamp_verify "$name" "$stamp" "$out" "${dirs[@]}" 2>&1)"; then
    [ "$QUIET" = 1 ] ||
      printf '%-16s %-11s %-12s %s\n' "$name" "fresh" \
        "$(short_fp "$(bundle_stamp_field "$stamp" fingerprint || true)")" "$(pretty_path "$out")"
    fresh=$((fresh + 1))
  else
    # The verdict word is the REASON, not one bucket for every failure: an
    # artifact that is not in this store at all is not a source edit.
    if [ -z "$detail" ]; then
      word="STALE"
    elif printf '%s' "$detail" | grep -q 'PAYLOAD MODIFIED'; then
      word="payload"
    elif printf '%s' "$detail" | grep -q 'NO BUILD STAMP'; then
      word="unbuilt"
      unbuilt=$((unbuilt + 1))
    elif printf '%s' "$detail" | grep -q 'MISSING'; then
      word="missing"
      unbuilt=$((unbuilt + 1))
    else
      word="STALE"
    fi
    [ "$QUIET" = 1 ] || printf '%-16s %-11s %-12s %s\n' "$name" "$word" "-" "$(pretty_path "$out")"
    [ -z "$detail" ] || printf '%s\n' "$detail"
    [ "$kind" = "deployed" ] &&
      printf '  deploy:  %s/apps/greeter/install.sh (root) — it rebuilds and refuses a payload that does not match the sources\n' "$ROOT"
    stale=$((stale + 1))
    stale_names="$stale_names $name"
  fi
done < <(artifact_rows)

# Stated before the verdict: the boot probe's usual outcome is a stale
# greeter-deployed, and how many artifacts were skipped rather than checked must
# not be lost behind an exit code.
[ "$verified" -eq 0 ] ||
  printf 'check-builds: %s further artifact(s) verified by this run'\''s build-all, not re-derived (payload checksum skipped on this path)\n' "$verified"

if [ "$stale" -gt 0 ]; then
  printf 'check-builds: %s artifact(s) not built from the current sources in %s:%s\n' \
    "$stale" "$(pretty_path "$STORE")" "$stale_names" >&2
  [ "$unbuilt" -eq 0 ] ||
    printf 'check-builds: %s of them have no artifact in this store at all — a build whose artifacts landed in another store (an XDG_CACHE_HOME override in the calling environment) reads exactly like this\n' \
      "$unbuilt" >&2
  printf 'check-builds: run `npm run build:all` (the /etc/greetd deploy is a separate root step: apps/greeter/install.sh)\n' >&2
  exit 1
fi
printf 'check-builds: %s artifact(s) built from the current sources in %s\n' \
  "$fresh" "$(pretty_path "$STORE")"
