#!/usr/bin/env bash
# zenity — zenity-compatible dialog CLI routed through promptd windows.
#
# Sibling of ~/.local/bin/prompt (the yad-flavoured wrapper). Shadows
# /usr/bin/zenity on PATH and maps the dialog kinds promptd can represent:
#
#   --question [--ok-label= --cancel-label=]  -> confirm  (exit 0 = yes, 1 = no)
#   --entry [--hide-text] [--entry-text=]     -> input    (value on stdout)
#   --password                                -> input (masked)
#   --list --column=C item...                 -> choice   (selection on stdout)
#   --forms --add-entry= --add-password= ...  -> form     (values, --separator)
#   --info | --warning | --error              -> confirm with a single OK
#
# Anything else (--file-selection, --progress, --scale, --calendar,
# --notification, --text-info, --color-selection, --extra-button, --timeout,
# multi-column lists) execs the REAL /usr/bin/zenity with the original argv —
# honest passthrough beats a wrong approximation. Same rule when promptd is
# unreachable or errors. An explicit user cancel exits 1 without spawning
# zenity.
set -u

# promptd client helpers (router, payload framing, JSON escaping).
. "$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/promptd-client.sh"

REAL_ZENITY=/usr/bin/zenity
orig_args=("$@")

fallback() { exec "$REAL_ZENITY" "${orig_args[@]}"; }

mode=""
title=""
text=""
entry_text=""
hide_text=0
ok_label=""
cancel_label=""
separator="|"
columns=0
items=()
fields=()          # "label" or "label:masked"
set_mode() {
  # Two mode flags in one invocation is a zenity usage error — let the real
  # binary produce the canonical message.
  [ -n "$mode" ] && fallback
  mode="$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --question) set_mode question ;;
    --entry) set_mode entry ;;
    --password) set_mode password ;;
    --list) set_mode list ;;
    --forms) set_mode forms ;;
    --info) set_mode info ;;
    --warning) set_mode info ;;
    --error) set_mode info ;;

    --title=*) title="${1#--title=}" ;;
    --text=*) text="${1#--text=}" ;;
    --entry-text=*) entry_text="${1#--entry-text=}" ;;
    --hide-text) hide_text=1 ;;
    --ok-label=*) ok_label="${1#--ok-label=}" ;;
    --cancel-label=*) cancel_label="${1#--cancel-label=}" ;;
    --separator=*) separator="${1#--separator=}" ;;
    --column=*) columns=$((columns + 1)) ;;
    --add-entry=*) fields+=("${1#--add-entry=}") ;;
    --add-password=*) fields+=("${1#--add-password=}:masked") ;;

    # Cosmetic / harmless: ignored, the promptd window has its own chrome.
    --width=*|--height=*|--icon-name=*|--window-icon=*|--no-markup|--no-wrap|--modal|--default-cancel) : ;;

    # Everything promptd cannot represent faithfully.
    --file-selection|--progress|--scale|--calendar|--notification|--text-info|--color-selection|--extra-button=*|--timeout=*|--print-column=*|--multiple|--checklist|--radiolist|--add-calendar=*|--add-combo=*|--add-list=*)
      fallback ;;

    --) shift; items+=("$@"); break ;;
    --*) : ;;   # unknown flag: ignore, mode mapping still applies
    *) items+=("$1") ;;
  esac
  shift
done

[ -n "$mode" ] || fallback
# Multi-column lists change the argv grouping semantics — not worth faking.
[ "$mode" = list ] && [ "$columns" -gt 1 ] && fallback
[ "$mode" = forms ] && [ ${#fields[@]} -eq 0 ] && fallback

reply=""
rc=0
case "$mode" in
  question|info)
    ok="${ok_label:-OK}"
    payload="{\"title\":\"$(promptd_json_str "${title:-Question}")\",\"body\":\"$(promptd_json_str "$text")\",\"okLabel\":\"$(promptd_json_str "$ok")\""
    if [ "$mode" = question ]; then
      payload+=",\"cancelLabel\":\"$(promptd_json_str "${cancel_label:-Cancel}")\"}"
    else
      payload+="}"
    fi
    reply="$(promptd_request confirm "$payload")"; rc=$?
    ;;
  entry|password)
    m="text"
    { [ "$mode" = password ] || [ "$hide_text" -eq 1 ]; } && m="masked"
    payload="{\"mode\":\"$m\",\"title\":\"$(promptd_json_str "${title:-Input}")\",\"body\":\"$(promptd_json_str "$text")\",\"placeholder\":\"$(promptd_json_str "$entry_text")\"}"
    reply="$(promptd_request input "$payload")"; rc=$?
    ;;
  list)
    json_opts=""; sep=""
    for o in "${items[@]:-}"; do
      [ -n "$o" ] || continue
      json_opts+="$sep\"$(promptd_json_str "$o")\""; sep=","
    done
    [ -n "$json_opts" ] || fallback
    payload="{\"title\":\"$(promptd_json_str "${title:-Select}")\",\"body\":\"$(promptd_json_str "$text")\",\"options\":[$json_opts]}"
    reply="$(promptd_request choice "$payload")"; rc=$?
    ;;
  forms)
    json_fields=""; sep=""; i=1
    for f in "${fields[@]}"; do
      label="$f"; masked=false
      case "$f" in *:masked) label="${f%:masked}"; masked=true ;; esac
      json_fields+="$sep{\"key\":\"field$i\",\"label\":\"$(promptd_json_str "$label")\",\"masked\":$masked}"
      sep=","; i=$((i + 1))
    done
    payload="{\"title\":\"$(promptd_json_str "${title:-Form}")\",\"body\":\"$(promptd_json_str "$text")\",\"fields\":[$json_fields]}"
    reply="$(promptd_request form "$payload")"; rc=$?
    if [ -n "$reply" ] && [ "${reply#error:}" = "$reply" ]; then
      # promptd returns JSON {key: value}; zenity prints values joined by
      # --separator (default "|") in field order.
      reply="$(SEP="$separator" printf '%s' "$reply" | python3 -c 'import json,os,sys
d=json.load(sys.stdin)
print(os.environ.get("SEP","|").join(str(d.get(k,"")) for k in d))' 2>/dev/null)" || fallback
    fi
    ;;
esac

# User dismissed the promptd window: zenity semantics = exit 1, no output,
# and NO second dialog.
[ "$reply" = "error: cancelled" ] && exit 1

# promptd unreachable or errored -> real zenity, drop-in.
if [ "$rc" -ne 0 ] || [ -z "$reply" ] || [ "${reply#error:}" != "$reply" ]; then
  fallback
fi

case "$mode" in
  question|info) exit 0 ;;          # answer is the exit code; nothing on stdout
  *) printf '%s\n' "$reply"; exit 0 ;;
esac
