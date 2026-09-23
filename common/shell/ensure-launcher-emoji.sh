#!/usr/bin/env bash
# ensure-launcher-emoji.sh — the mod+. keybind handler for the launcher's emoji
# mode. Thin wrapper over the shared router (routes "launcher emoji" to the
# live instance: shell first, dev launcher island second, cold-start when
# neither is servable). Lives beside tinshell-route.sh in common/shell, like
# ensure-launcher-toggle.sh.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/tinshell-route.sh" launcher emoji
