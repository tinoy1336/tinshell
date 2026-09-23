#!/usr/bin/env bash
# restart-shell.sh — the mod+SHIFT+B "restart what's live" handler.
#
# Shell mode (production): restart the shell — existing behaviour, absorbed
# by systemd Restart=on-failure + the ExecStartPre bus-name waiter.
# Island mode: restart every LIVE island instead of starting the shell
# (the two branches must stay distinct — an identical pair would START the
# production shell in dev). Probe idioms are tinshell-mode.sh's
# (ags list for live instances, apps.json for manifest units).
set -u

# The tree root: this script's own location (common/shell → repo root) unless
# the environment already named it. Never overwritten.
TINSHELL_HOME="${TINSHELL_HOME:-$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)}"
MANIFEST="$TINSHELL_HOME/common/shell/apps.json"

manifest_unit() { jq -r --arg a "$1" '.[$a].unit // empty' "$MANIFEST" 2>/dev/null; }

# Production shell live → restart it.
if ags -i shell request "" >/dev/null 2>&1; then
  exec systemctl --user restart tinshell-shell
fi

# Island mode: restart each live non-shell instance. Manifest-unit apps
# (promptd/portal/polkit dev units) restart via their unit; everything else
# (transient tinshell-<instance> units from tinshell-host) restarts by re-running its
# unit's ExecStart. Instances living outside systemd (run.sh / bare ags run)
# are skipped — there is no supervised lifecycle to restart through.
restarted=0
for inst in $(ags list 2>/dev/null | awk '{print $1}'); do
  [ "$inst" = shell ] && continue
  unit="$(manifest_unit "$inst")"
  if [ -z "$unit" ]; then
    unit="tinshell-$inst.service"
  fi
  if systemctl --user cat "$unit" >/dev/null 2>&1; then
    systemctl --user restart "$unit" && restarted=$((restarted + 1))
  fi
done

if [ "$restarted" -eq 0 ]; then
  echo "restart-shell: nothing live to restart" >&2
fi
