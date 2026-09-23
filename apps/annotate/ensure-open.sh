#!/usr/bin/env bash
# ensure-open.sh — the "open in annotate" handler (screenshot action hook).
#
# Thin wrapper over the shared router: tinshell-route routes "annotate …" to the
# live instance (shell first, dev island second) and cold-starts when neither
# is up.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROUTE="$DIR/../../common/shell/tinshell-route.sh"

# Default action "open" with the image path arg(s):
#   ensure-open.sh /path/to/capture.png
ARGS=("open")
if [ $# -ge 1 ] && [ -n "$1" ]; then
  ARGS=("open" "$@")
fi
exec "$ROUTE" annotate "${ARGS[*]}"
