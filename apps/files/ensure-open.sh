#!/usr/bin/env bash
# ensure-open.sh — the files app's xdg-open entry (tinshell-files.desktop's Exec).
#
# Thin wrapper over the shared router: tinshell-route routes "files …" to the live
# instance (shell first, dev island second) and cold-starts when neither is up.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROUTE="$DIR/../../common/shell/tinshell-route.sh"

# Default action "new": every request from here opens its OWN window — an
# xdg-open on a folder must not retarget the browser the user already has open
# (`files open` remains the surfacing/focusing verb on the request surface).
# A cold start is the same shape: the router boots the instance (no window) and
# then delivers `files new`.
#   ensure-open.sh              → a new window at the startup dir
#   ensure-open.sh /some/dir    → a new window at /some/dir
ARGS=("new")
if [ $# -ge 1 ] && [ -n "$1" ]; then
  ARGS=("new" "$@")
fi
exec "$ROUTE" files "${ARGS[*]}"
