#!/usr/bin/env bash
# prompt — yad-compatible dialog CLI routed through promptd windows.
#
# Accepts the common yad flag surface and maps it to promptd requests:
#   --entry [--hide-text]        -> masked/text input (result on stdout)
#   --question                   -> confirm window (exit 0 = OK, 1 = cancel)
#   --list [--column=...] args.. -> choice window (selected option on stdout)
#   --form --field=label ...     -> form window (values on stdout, "|"-joined)
#   --title= --text= --width=    -> passed through to the window payload
#
# When promptd is unreachable or errors, execs real yad with the ORIGINAL
# arguments — a literal drop-in fallback. An explicit promptd cancel (window
# dismissed) exits 1 without spawning yad.
set -u

# promptd client helpers (router, payload framing, JSON escaping).
. "$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/promptd-client.sh"

orig_args=("$@")

title=""
text=""
entry=0
hide_text=0
question=0
list=0
form=0
fields=()
opts=()
width=""

while [ $# -gt 0 ]; do
  case "$1" in
    --title=*) title="${1#--title=}" ;;
    --text=*) text="${1#--text=}" ;;
    --width=*) width="${1#--width=}" ;;
    --entry) entry=1 ;;
    --hide-text) hide_text=1 ;;
    --question) question=1 ;;
    --list) list=1 ;;
    --form) form=1 ;;
    --field=*) fields+=("${1#--field=}") ;;
    --column=*) : ;; # columns are cosmetic in the single-list mapping
    --button=*) : ;; # custom button ids map to ok=0 / cancel=1
    --) shift; opts+=("$@"); break ;;
    --*) : ;; # other yad flags ignored
    *) opts+=("$1") ;;
  esac
  shift
done

ags_rc=0
reply=""
if [ "$form" -eq 1 ]; then
  json_fields=""
  sep=""
  i=1
  for f in "${fields[@]}"; do
    json_fields+="$sep{\"key\":\"field$i\",\"label\":\"$(promptd_json_str "$f")\"}"
    sep=","
    i=$((i + 1))
  done
  payload="{\"title\":\"$(promptd_json_str "$title")\",\"body\":\"$(promptd_json_str "$text")\",\"fields\":[$json_fields]}"
  reply="$(promptd_request form "$payload")"
  ags_rc=$?
  # promptd returns JSON {key: value} — convert to yad's "|"-joined stdout.
  if [ -n "$reply" ] && [ "${reply#error:}" = "$reply" ]; then
    reply="$(printf '%s' "$reply" | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("|".join(str(d.get(k,"")) for k in d))' 2>/dev/null)"
  fi
elif [ "$list" -eq 1 ]; then
  json_opts=""
  sep=""
  for o in "${opts[@]}"; do
    json_opts+="$sep\"$(promptd_json_str "$o")\""
    sep=","
  done
  payload="{\"title\":\"$(promptd_json_str "$title")\",\"body\":\"$(promptd_json_str "$text")\",\"options\":[$json_opts]}"
  reply="$(promptd_request choice "$payload")"
  ags_rc=$?
elif [ "$question" -eq 1 ]; then
  payload="{\"title\":\"$(promptd_json_str "${title:-Question}")\",\"body\":\"$(promptd_json_str "$text")\"}"
  reply="$(promptd_request confirm "$payload")"
  ags_rc=$?
elif [ "$entry" -eq 1 ]; then
  mode="text"
  [ "$hide_text" -eq 1 ] && mode="masked"
  payload="{\"mode\":\"$mode\",\"title\":\"$(promptd_json_str "${title:-Input}")\",\"body\":\"$(promptd_json_str "$text")\",\"placeholder\":\"\"}"
  reply="$(promptd_request input "$payload")"
  ags_rc=$?
else
  echo "prompt: no mode flag (--entry/--question/--list/--form)" >&2
  exit 2
fi

if [ "$reply" = "error: cancelled" ]; then
  exit 1
fi
if [ "$ags_rc" -ne 0 ] || [ "${reply#error:}" != "$reply" ]; then
  # promptd unreachable (CLI failed, possibly empty reply) or errored —
  # fall back to real yad with the ORIGINAL arguments, drop-in.
  if [ "$question" -eq 1 ]; then
    # yad has no --question (that's a zenity flag) — translate to a text
    # dialog with OK/Cancel (exit 0 = OK, 1 = Cancel, yad button ids).
    exec yad --text="${text:-Question}" --title="$title" --button=OK:0 --button=Cancel:1
  fi
  exec yad "${orig_args[@]}"
fi

if [ "$question" -eq 1 ]; then
  # yad parity: --question prints nothing, the exit code is the answer.
  exit 0
fi
printf '%s\n' "$reply"
exit 0
