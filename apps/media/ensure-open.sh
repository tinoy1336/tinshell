#!/usr/bin/env bash
# ensure-open.sh — the media handler: the launcher `!p` bang, the
# tinshell-media.desktop entry (xdg-open), and ad-hoc `media …` routing.
#
# Thin wrapper over the shared router: tinshell-route routes "media …" to the live
# instance (shell first, dev island second) and cold-starts when neither is up.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROUTE="$DIR/../../common/shell/tinshell-route.sh"

# --new: a NEW window per request (the xdg-open shape — media is
# multi-instance, and retargeting the running window silently replaced the
# file the user was looking at).
ACTION="open"
if [ "${1:-}" = "--new" ]; then
  ACTION="new"
  shift
fi

#   ensure-open.sh                → focus the most-recent window, else an empty
#                                   one that prompts through the portal
#   ensure-open.sh /path/video    → the most-recent window shows /path/video
#   ensure-open.sh /path/img      → viewer showing /path/img (and nothing else)
#   ensure-open.sh --new <file>   → a window of its own, showing <file>
ARGS=("$ACTION")
if [ $# -ge 1 ] && [ -n "$1" ]; then
  ARGS=("$ACTION" "$@")
fi
exec "$ROUTE" media "${ARGS[*]}"
