#!/usr/bin/env bash
# greeter-handoff.sh — freezes the greeter's last frame at login handoff.
#
# Spawned by the TINSHELL greeter app (production mode only) right after
# start_session_finish. SIGKILLs the greeter compositor tree so NO teardown
# happens: the framebuffer keeps the last rendered frame (wallpaper + the
# "Logging in..." card) frozen until the user session's Hyprland paints over
# it. Runs pre-login as user "greeter" — kill(2) can only touch greeter-owned
# processes, so a stray execution can never kill the user session's
# compositor.
#
# Kill order matters:
#   1. start-hyprland FIRST — the watchdog wrapper must be dead BEFORE its
#      child exits, otherwise it observes the non-clean Hyprland exit and
#      re-spawns a --safe-mode compositor, which re-modesets the output and
#      causes the login black flash.
#   2. Hyprland — releases the DRM master (SIGKILL = no teardown, the last
#      frame freezes on the framebuffer).
#   3. awww-daemon — the greeter-compositor wallpaper daemon (would linger
#      as an orphan otherwise).
set -u

pgrep -x start-hyprland | xargs -r kill -9
pgrep -x Hyprland | xargs -r kill -9
pgrep -x hyprland | xargs -r kill -9
pgrep -x awww-daemon | xargs -r kill -9
