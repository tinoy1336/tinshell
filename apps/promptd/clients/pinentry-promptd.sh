#!/usr/bin/env bash
# pinentry-promptd — assuan pinentry speaking to promptd windows.
#
# gpg-agent / ssh-agent spawn this program (pinentry-program in
# gpg-agent.conf) and talk to it over stdio with the assuan protocol:
#   SETDESC <text>   description shown above the prompt
#   SETPROMPT <txt>  prompt label (default "PIN:")
#   SETTITLE <text>  window title
#   GETPIN           ask for a secret -> D <percent-encoded> | ERR ... canceled
#   CONFIRM          yes/no question  -> OK | ERR ... canceled
#   MESSAGE          info box         -> OK
#   BYE              quit
# Unknown SET*/OPTION* lines are answered OK (lenient, like other pinentries).
#
# Fallback: probes promptd at startup; when unreachable, execs the real
# pinentry ($PINENTRY_FALLBACK, default pinentry-gnome3) so the ENTIRE
# protocol stream goes to it from the beginning.
set -u

# promptd client helpers (router, payload framing, ping probe).
. "$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/promptd-client.sh"

FALLBACK="${PINENTRY_FALLBACK:-pinentry-gnome3}"

# Percent-decode assuan values (gpg-agent percent-encodes SETDESC etc.).
pctdecode() {
  python3 -c 'import sys,urllib.parse; print(urllib.parse.unquote(sys.stdin.buffer.read().decode()), end="")'
}

# Percent-encode GETPIN data (assuan D lines: %XX for non-unreserved chars).
pctencode() {
  python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.buffer.read().decode(), safe="-_.~"), end="")'
}

# Probe promptd BEFORE consuming any protocol input.
if ! promptd_ping; then
  exec "$FALLBACK"
fi

DESC=""
PROMPT="PIN:"
TITLE=""

while IFS= read -r line || [ -n "$line" ]; do
  # Strip a trailing CR if present (assuan allows CRLF).
  line="${line%$'\r'}"
  case "$line" in
    SETDESC*) DESC="${line#SETDESC }" ;;
    SETPROMPT*) PROMPT="${line#SETPROMPT }" ;;
    SETTITLE*) TITLE="${line#SETTITLE }" ;;
    OPTION*) echo "OK" ;;
    GETPIN)
      resp="$(promptd_request input "{\"mode\":\"masked\",\"title\":\"$(promptd_json_str "${TITLE:-PIN entry}")\",\"body\":\"$(promptd_json_str "$(printf '%s' "$DESC" | pctdecode)")\",\"placeholder\":\"$(promptd_json_str "$PROMPT")\"}")"
      if [ "$resp" = "error: cancelled" ]; then
        echo "ERR 83886179 Operation cancelled"
      elif [ -z "$resp" ] || [ "${resp#error:}" != "$resp" ]; then
        echo "ERR 67109135 Unexpected failure"
      else
        # printf (NOT a herestring) — a herestring would add a trailing \n
        # that percent-encodes into the passphrase (%0A).
        printf '%s' "$resp" | pctencode | { read -r encoded; echo "D $encoded"; }
      fi
      ;;
    CONFIRM)
      resp="$(promptd_request confirm "{\"title\":\"$(promptd_json_str "${TITLE:-Confirmation}")\",\"body\":\"$(promptd_json_str "$(printf '%s' "$DESC" | pctdecode)")\"}")"
      if [ "$resp" = "ok" ]; then
        echo "OK"
      elif [ "$resp" = "error: cancelled" ]; then
        echo "ERR 83886179 Operation cancelled"
      else
        echo "ERR 67109135 Unexpected failure"
      fi
      ;;
    MESSAGE)
      resp="$(promptd_request confirm "{\"title\":\"$(promptd_json_str "${TITLE:-Message}")\",\"body\":\"$(promptd_json_str "$(printf '%s' "$DESC" | pctdecode)")\",\"okLabel\":\"OK\"}")"
      [ "$resp" = "ok" ] && echo "OK" || echo "ERR 83886179 Operation cancelled"
      ;;
    BYE)
      echo "OK"
      exit 0
      ;;
    "")
      : ;;
    *)
      # Lenient: unknown SET*/GETINFO-style lines answered OK.
      echo "OK"
      ;;
  esac
done
