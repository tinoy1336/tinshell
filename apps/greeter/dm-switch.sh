#!/usr/bin/env bash
# dm-switch.sh <greetd|plasmalogin> — switch the display manager.
#
# MUST be run from a SPARE TTY (Ctrl+Alt+F2, login as tinoy), NEVER from
# inside the graphical session: (re)starting greetd/plasmalogin while a
# session is active can yank the active VT.
#
# Order matters: greetd.service is Alias=display-manager.service, so enabling
# it while plasmalogin still owns the display-manager symlink fails. Disable
# plasmalogin FIRST (drops the symlink), then enable greetd.
set -euo pipefail

case "${1:-}" in
greetd)
  echo "→ disabling plasmalogin (drops the display-manager.service symlink)"
  sudo systemctl disable plasmalogin
  echo "→ enabling greetd (takes the display-manager.service alias)"
  sudo systemctl enable greetd
  echo "→ starting greetd (VT 1)"
  sudo systemctl start greetd
  echo "switched to greetd — VT1 should show the TINSHELL greeter."
  echo "watch: journalctl -u greetd -f"
  ;;
plasmalogin)
  echo "→ stopping + disabling greetd"
  sudo systemctl disable --now greetd
  echo "→ enabling + starting plasmalogin (rollback)"
  sudo systemctl enable plasmalogin
  sudo systemctl start plasmalogin
  echo "rolled back to plasmalogin"
  ;;
*)
  echo "usage: dm-switch.sh <greetd|plasmalogin>" >&2
  exit 1
  ;;
esac
