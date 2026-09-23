#!/usr/bin/env bash
# ensure-new.sh — the notes launcher: the SUPER+N and SUPER+SHIFT+N handlers;
# also the `!n <name>` launcher bang's spawn target (`ensure-new.sh open <name>`
# opens/creates a named note).
#
# Actions (first argument; a bare call and the `!n` bang's cold argv both use
# the default "new"):
#   fresh        a guaranteed fresh EMPTY note, never the closed-note history
#                (SUPER+N → `notes fresh`)
#   new          reopen the most recently closed note, else a fresh blank note
#                (SUPER+SHIFT+N → `notes new`)
#   open <name>  open/create a named note (or a path)
#
# Thin wrapper over the shared router: tinshell-route routes "notes …" to the live
# instance (shell first, dev island second) and cold-starts when neither is up.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROUTE="$DIR/../../common/shell/tinshell-route.sh"

ARGS=("${@:-new}") # default action "new"; e.g. ("fresh") / ("open", "foo")
exec "$ROUTE" notes "${ARGS[*]}"
