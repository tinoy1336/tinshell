#!/usr/bin/env bash
# sudo-approve askpass bridge (sudo -A).
#
# Prefers the promptd window (tinshell/promptd — themed, centred, unified with
# the approval flow); falls back to the yad dialog when promptd is
# unreachable. The password flows dialog -> stdout -> sudo; the requesting
# process never sees it.
#
# Paths:
#   promptd answered            -> print password, exit 0
#   promptd window cancelled    -> exit 1 (NO fallback window — the user
#                                  already dismissed one)
#   promptd unavailable/error   -> yad dialog (fallback)
#   yad cancelled               -> exit 1

# promptd client helpers (router, payload framing, askpass bridge).
. "$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/promptd-client.sh"

PROMPT="${1:-[sudo] password: }"
promptd_askpass "$PROMPT" "sudo authentication" "Enter your password to run the approved command(s):"
