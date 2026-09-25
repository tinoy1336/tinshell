#!/usr/bin/env bash
# ssh-askpass-promptd — SSH_ASKPASS bridge to promptd windows.
#
# ssh (and ssh-keygen with -y) invoke the program named by SSH_ASKPASS with
# the prompt as argv[1] and read the passphrase from stdout — the same
# contract as sudo's askpass. Promptd window first; yad fallback; an explicit
# promptd cancel never re-prompts.

# promptd client helpers (router, payload framing, askpass bridge).
. "$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/promptd-client.sh"

PROMPT="${1:-Enter passphrase: }"
promptd_askpass "$PROMPT" "ssh passphrase" "$PROMPT"
