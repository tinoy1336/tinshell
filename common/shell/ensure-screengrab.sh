#!/usr/bin/env bash
# ensure-screengrab.sh — the Print-key handler.
#
# Routes a region capture into the live instance that hosts the screen grab
# applet, so the capture runs that applet's own pipeline: storage dir and name
# template from the config, the frozen frame, the notification carrying the
# Annotate action, and the clipboard copy.
#
# The action is dispatched through an IN-PROCESS handler, which is why the
# capture must run inside that instance — a capture taken anywhere else would
# raise a notification whose button goes nowhere.
#
# Never cold-starts (--no-start): a keystroke must not spend seconds rebuilding
# a bundle. With no live instance the miss is reported on both channels —
# notify-send AND hyprctl notify — because the TINSHELL notification daemon is one of
# the things that is down in exactly that case.
set -u

DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

"$DIR/tinshell-route.sh" --no-start dock screengrab capture still select
status=$?

if [ "$status" -eq 2 ]; then
  "$DIR/notify-failed.sh" screengrab \
    "no live instance hosts the screen grab applet — start TINSHELL (tinshell-mode shell), then press Print again"
fi

exit 0
