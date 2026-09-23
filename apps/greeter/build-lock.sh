#!/usr/bin/env bash
# build-lock.sh — tinoy-side build → ./dist/tinshell-lock.sh (self-contained LOCK
# bundle for the in-session session lock, TINSHELL_GREETER_MODE=lock).
#
# Same source and same build body as build.sh (apps/greeter/bundle.sh) — the
# lock is a second PRODUCT of one app, not a second app. The bundle runs as
# tinoy in the live session, exec'd straight from dist/ by hypridle's
# lock_cmd, so the built file is a live dependency: it is replaced atomically
# (build to a temp file, then rename over it) and rebuilding is a no-op while
# the sources are unchanged.
set -euo pipefail
cd "$(dirname "$0")"
GREETER_ROOT="$(cd ../.. && pwd)"
# shellcheck source=apps/greeter/bundle.sh
. ./bundle.sh

greeter_build greeter-lock "$(pwd)/dist/tinshell-lock.sh" "tinshell-lock.js" "$@"
