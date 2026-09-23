#!/usr/bin/env bash
# greeter/preview.sh — windowed greeter prototype (DEV ONLY, never production).
#
# Renders the greeter UI (login or lock card + the REAL dock applet strip) as
# a plain window pinned to workspace 10 in the LIVE user session — no greetd,
# no session lock, NO PAM, no VT1 round-trip. Used for layout/UX iteration;
# the real lock path (tinshell-lock.sh) and the greeter compositor are untouched.
#
#   preview.sh [login|lock]     (default: login)
#
# TINSHELL_GREETER_PREVIEW=login|lock selects the card. The dock applets run as
# tinoy and read the REAL dock config (MPRIS/AstalWp live).
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-login}"
case "$MODE" in
  login|lock) ;;
  *) echo "usage: preview.sh [login|lock]" >&2; exit 1 ;;
esac

# One instance only: a second gjs instance of the same bundle becomes a
# GApplication REMOTE client of the first and exits printing the empty-argv
# response (greeter AGENTS.md). Only the PREVIEW outfile is killed — never
# tinshell-lock.js (the production lock bundle).
pkill -f 'greeter-tinshell\.js' 2>/dev/null || true

[ -x dist/greeter-tinshell.sh ] || ./build.sh

hyprctl dispatch "hl.dsp.exec_cmd('env TINSHELL_GREETER_PREVIEW=$MODE $(pwd)/dist/greeter-tinshell.sh', {workspace=10})"
echo "greeter preview ($MODE) launched on workspace 10"
