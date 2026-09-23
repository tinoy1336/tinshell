#!/usr/bin/env bash
# scripts/artifacts.sh — THE artifact registry: every artifact the repo ships,
# where it lands, and the stamp sidecar recording the sources it was built
# from. Sourced by scripts/build-all.sh and scripts/check-builds.sh so a build
# and a freshness check cannot disagree about what exists.
#
# Rows: <name> <source-app> <output> <stamp> <kind>
#   source-app  = the app whose source set defines the artifact's fingerprint
#                 ("universal" for the shared host bundle); see
#                 bundle_source_dirs in common/shell/bundle-stamp.sh.
#   kind        = cache | dist | deployed. cache+dist are built in this
#                 checkout by build-all.sh; deployed is the greeter bundle
#                 installed into /etc/greetd/ by apps/greeter/install.sh (root,
#                 never built here — the deploy writes the same stamp beside
#                 the installed payload, and check-builds.sh reads it there).
#
# The cache rows live in the artifact store, resolved by bundle_store_dir
# (common/shell/bundle-stamp.sh) — the SAME call the bundler writes through, so
# the gate and the build cannot look at different stores. This file requires
# common/shell/bundle-stamp.sh to be sourced first (both gates do).

ARTIFACTS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS_CACHE="$(bundle_store_dir)"
ARTIFACTS_GREETER="$ARTIFACTS_ROOT/apps/greeter/dist"
ARTIFACTS_DEPLOY="/etc/greetd/tinshell-greeter.sh"

# The manifest is the single source of truth for the app list (tinshell-host.sh
# reads the same file for the same reason).
artifacts_manifest_apps() {
  jq -r 'keys[] | select(startswith("$") | not)' \
    "$ARTIFACTS_ROOT/common/shell/apps.json"
}

artifact_rows() {
  command -v jq >/dev/null || {
    echo "artifacts.sh: jq required (reads common/shell/apps.json)" >&2
    return 1
  }
  printf '%s\t%s\t%s\t%s\t%s\n' "universal" "universal" \
    "$ARTIFACTS_CACHE/universal/universal-tinshell.wrapper.sh" \
    "$ARTIFACTS_CACHE/universal/build-stamp.json" "cache"
  local app
  while read -r app; do
    [ -n "$app" ] || continue
    printf '%s\t%s\t%s\t%s\t%s\n' "$app" "$app" \
      "$ARTIFACTS_CACHE/$app/$app-tinshell.wrapper.sh" \
      "$ARTIFACTS_CACHE/$app/build-stamp.json" "cache"
  done < <(artifacts_manifest_apps)
  printf '%s\t%s\t%s\t%s\t%s\n' "greeter" "greeter" \
    "$ARTIFACTS_GREETER/greeter-tinshell.sh" "$ARTIFACTS_GREETER/greeter-tinshell.sh.stamp.json" "dist"
  printf '%s\t%s\t%s\t%s\t%s\n' "greeter-lock" "greeter" \
    "$ARTIFACTS_GREETER/tinshell-lock.sh" "$ARTIFACTS_GREETER/tinshell-lock.sh.stamp.json" "dist"
  printf '%s\t%s\t%s\t%s\t%s\n' "greeter-deployed" "greeter" \
    "$ARTIFACTS_DEPLOY" "$ARTIFACTS_DEPLOY.stamp.json" "deployed"
}
