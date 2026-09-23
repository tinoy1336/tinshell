#!/usr/bin/env bash
# ensure-open.sh — the xdg-open handler for text files (tinshell-notes.desktop).
#
# Thin wrapper over the shared router: tinshell-route routes "notes …" to the live
# instance (shell first, dev island second) and cold-starts when neither is up.
#
#   ensure-open.sh /path/note.md   → open that file as a note
#   ensure-open.sh                 → no file named; opens the notes session
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROUTE="$DIR/../../common/shell/tinshell-route.sh"

if [ $# -ge 1 ] && [ -n "$1" ]; then
  exec "$ROUTE" notes open "$@"
fi
exec "$ROUTE" notes session
