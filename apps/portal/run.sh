#!/usr/bin/env bash
# portal/run.sh — shim to the shared bundler (root AGENTS.md: launch path).
#
# Manual per-app entry for the portal backend. It is deliberately NOT a D-Bus
# activation target: a second claimant for the impl name races the shell at
# login and hangs the session on the 25s D-Bus timeout (see apps/portal/
# AGENTS.md).
#
# The env is set here because a caller may not carry the session identity the
# shell unit's Environment= provides. Missing it: the chooser spawns on the
# wrong display, or a start wakes the RTX 4060 (see tinshell-shell.service for the
# full rationale).
export WAYLAND_DISPLAY=wayland-1
export DISPLAY=:0
export XDG_CURRENT_DESKTOP=Hyprland
export __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/radeon_icd.json

exec "$(dirname "$0")/../../common/shell/run.sh" portal
