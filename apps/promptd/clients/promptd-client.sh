#!/usr/bin/env bash
# promptd-client.sh — the shared promptd client helpers for the dialog
# wrappers in this directory (prompt, zenity, pinentry-promptd,
# ssh-askpass-promptd, sudo-approve-askpass). Sourced, never executed: it
# defines functions and no working state.
#
# A caller owns its own argv mapping and its own literals (default prompt
# text, fallback dialog titles); everything about reaching promptd — the
# router, the base64 payload framing, the reply/`error:` contract — lives
# here, so the wrappers cannot drift apart.
#
# Requires: bash, base64, sed. The request surface splits its arguments on
# whitespace, so every payload travels as one base64(JSON) token.

# The router: the shell instance first, a dev promptd island second.
# PROMPTD_ROUTE points the helpers at another router; unset, the router is
# this tree's own common/shell/tinshell-route.sh — the file setup.sh links
# into ~/.local/bin as `tinshell-route`. Each wrapper is installed as a
# symlink, so this file's own path is resolved through `readlink -f` before
# the tree root is derived from it.
PROMPTD_ROUTE="${PROMPTD_ROUTE:-$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)/common/shell/tinshell-route.sh}"

# promptd_b64 <string> — the wire encoding of one request argument.
promptd_b64() { printf '%s' "$1" | base64 -w0; }

# promptd_json_str <string> — escape a value for embedding in a promptd JSON
# payload. Backslash and double quote only: a control character (newline,
# tab) passes through raw and makes the payload invalid JSON, which promptd
# answers as an error and the caller's own fallback dialog then covers.
promptd_json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# promptd_request <command> <payload-json> — route one promptd request
# (input | confirm | choice | form | askpass) and print its reply on stdout.
# stderr is dropped: callers branch on the reply text (`error: …`) and on
# this function's status, which is non-zero only when the CLI itself could
# not run (promptd unreachable).
promptd_request() { "$PROMPTD_ROUTE" promptd "$1 $(promptd_b64 "$2")" 2>/dev/null; }

# promptd_ping — true when a live promptd answers.
promptd_ping() { "$PROMPTD_ROUTE" promptd ping 2>/dev/null | grep -q "^pong$"; }

# promptd_askpass <prompt> <fallback-title> <fallback-text>
# The askpass contract shared by SSH_ASKPASS and sudo -A: print the secret on
# stdout and exit 0; exit 1 when the user dismissed the window. A promptd
# window answers first; when promptd is unreachable or errored, the yad
# dialog the caller describes takes over (its exit code is then the answer).
promptd_askpass() {
  local prompt="$1" title="$2" text="$3"
  local reply code
  reply="$(promptd_request askpass "$prompt")"
  code=$?
  if [ "$code" -eq 0 ] && [ "$reply" != "error: cancelled" ]; then
    case "$reply" in
      error:*) ;; # another promptd error -> yad fallback below
      *) printf '%s\n' "$reply"; return 0 ;;
    esac
  else
    # The CLI itself failed (promptd down) or the user cancelled the window.
    [ "$reply" = "error: cancelled" ] && return 1
  fi
  exec yad --entry \
    --hide-text \
    --title="$title" \
    --text="$text" \
    --image=dialog-password \
    --button="Cancel":1 \
    --button="OK":0 \
    --width=380
}
