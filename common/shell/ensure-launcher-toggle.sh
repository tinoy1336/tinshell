#!/usr/bin/env bash
# ensure-launcher-toggle.sh — the mod+Space keybind handler for the launcher
# surface. Thin wrapper over the shared router (routes "launcher toggle" to
# the live instance: shell first, dev launcher island second, cold-start when
# neither is servable). Lives beside tinshell-route.sh in common/shell.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/tinshell-route.sh" launcher toggle
