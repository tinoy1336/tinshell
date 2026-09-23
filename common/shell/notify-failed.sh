#!/usr/bin/env bash
# notify-failed.sh — dual-channel TINSHELL failure notice.
#
# Usage: notify-failed.sh <app> <logpath-or-hint>
#
# ALWAYS both channels: notify-send (notifd) AND `hyprctl notify`. The
# notification daemon is one of the things that can be down when an TINSHELL app
# fails (chicken-and-egg) — hyprctl notify needs no daemon and is the
# failsafe. The log path is always included so the next debugging session
# can start immediately.
#
# HYPRLAND_INSTANCE_SIGNATURE caveat: hyprctl requires it in the
# environment, but the systemd user manager does NOT carry it. Resolve it
# from $XDG_RUNTIME_DIR/hypr/ — one directory = the live compositor
# instance (newest wins if ever more than one).
set -u

APP="${1:?usage: notify-failed.sh <app> <logpath-or-hint>}"
shift
LOG="${*:-journalctl --user}"

if [ -z "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
  sig="$(ls -t "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/hypr" 2>/dev/null | head -1)"
  [ -n "$sig" ] && export HYPRLAND_INSTANCE_SIGNATURE="$sig"
fi

notify-send -u normal -a TINSHELL "TINSHELL: $APP failed" "log: $LOG" 2>/dev/null || true

if command -v hyprctl >/dev/null 2>&1 && [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
  hyprctl notify 5000 0 "rgb(ff0000)" "TINSHELL $APP FAILED — log: $LOG" >/dev/null 2>&1 || true
fi
exit 0
