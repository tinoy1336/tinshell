#!/usr/bin/env bash
# tinshell-mode — swap the TINSHELL home between runtime modes (preset layer over
# tinshell-host).
#
#   tinshell-mode              status
#   tinshell-mode shell        stop islands, start the production shell (one process)
#   tinshell-mode island       stop shell, start ALL long-running islands
#                         (manifest non-lazy apps: surfaces + services)
#   tinshell-mode island APP   stop shell, start one island (e.g. island notes —
#                         lazy apps spawn as pure-lazy quit-on-close islands)
#   tinshell-mode toggle       shell live ? island-mode : shell-mode
#
# Instance hosting is tinshell-host.sh's job: manifest `unit` apps start via
# their systemd unit, everything else via `tinshell-host start` (transient unit,
# journalctl --user -u tinshell-<instance> logs). The app list comes from
# common/shell/apps.json.
set -u

TINSHELL_HOME="$HOME/dev/tinshell"
TINSHELL_HOST="$TINSHELL_HOME/common/shell/tinshell-host.sh"
MANIFEST="$TINSHELL_HOME/common/shell/apps.json"

# Long-running set = manifest apps without lazy:true (surfaces + services).
LONGRUNNING="$(jq -r 'to_entries[] | select(.key | startswith("$") | not) | select(.value.lazy != true) | .key' "$MANIFEST" | sort | paste -sd, -)"

manifest_unit() { jq -r --arg a "$1" '.[$a].unit // empty' "$MANIFEST" 2>/dev/null; }

live_instances() { ags list 2>/dev/null || true; }
shell_live()     { live_instances | grep -qw shell; }
island_live()    { live_instances | grep -vw shell | grep -q .; }

# Which live instances serve <app>? (probe-based; combos included — an app
# can be hosted by MORE than one live instance, e.g. a lazy app loaded in
# two surface islands. Status lists every host, comma-joined.)
hosting_instances() {
	local app="$1" inst
	for inst in $(live_instances); do
		if ags -i "$inst" request "" 2>/dev/null | grep -qw -- "$app"; then
			echo "$inst"
		fi
	done
}

# Which live instances have <app> LOADED? (lazy apps only.) Namespace
# presence can't discriminate: every resident island pre-declares all lazy
# prefixes (ensureNamespace), so `request ""` lists them everywhere. Uses
# the side-effect-free `lazy status` request instead — any request whose
# first token names the app would lazy-LOAD it (pre-step) and make every
# instance report it. An instance NAMED like the app (pure-lazy island,
# e.g. instance "notes" hosting notes via its boot hook) hosts by
# definition — its own lazy registry is empty.
hosting_loaded() {
	local app="$1" inst
	for inst in $(live_instances); do
		if [ "$inst" = "$app" ]; then
			echo "$inst"
		elif ags -i "$inst" request "lazy status" 2>/dev/null \
			| grep -v -e '^available commands' -e '^error:' \
			| grep -qw -- "$app"; then
			echo "$inst"
		fi
	done
}

# UNIT-STATE for a row: shell → tinshell-shell state; manifest unit → its
# systemd state; otherwise the tinshell-host transient unit (tinshell-<instance>) →
# "transient" when that unit exists, "run.sh" when the instance lives
# outside systemd (run.sh fallback / bare ags run). Evaluated on the FIRST
# host instance when an app is multi-hosted.
unit_state() {
	local app="$1" inst="$2" unit st
	if [ "$inst" = shell ]; then
		st="$(systemctl --user is-active tinshell-shell 2>/dev/null || true)"
		echo "${st:-unknown}"
		return
	fi
	unit="$(manifest_unit "$app")"
	if [ -n "$unit" ]; then
		st="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
		echo "${st:-unknown}"
		return
	fi
	st="$(systemctl --user is-active "tinshell-$inst.service" 2>/dev/null || true)"
	if [ -z "$st" ] || [ "$st" = unknown ]; then
		echo "run.sh"
	else
		echo "transient"
	fi
}

status() {
	local insts app hosts first joined
	insts=$(live_instances | paste -sd, - | sed 's/,/, /g')
	if shell_live; then
		echo "mode: shell (production)"
	else
		if island_live; then echo "mode: island (dev)"; else echo "mode: down (no live instances)"; fi
	fi
	[ -n "$insts" ] && echo "live instances: $insts"
	echo
	printf '  %-13s %-24s %-10s %s\n' APP HOST-INSTANCE UNIT-STATE LOG
	for app in $(echo "$LONGRUNNING" | tr ',' ' '); do
		hosts="$(hosting_instances "$app")"
		if [ -n "$hosts" ]; then
			first="$(printf '%s\n' "$hosts" | head -n1)"
			joined="$(printf '%s\n' "$hosts" | paste -sd, -)"
			printf '  %-13s %-24s %-10s %s\n' "$app" "$joined" "$(unit_state "$app" "$first")" "journalctl --user -u tinshell-$first"
		else
			printf '  %-13s %-24s %-10s %s\n' "$app" "(down)" "-" "-"
		fi
	done
	# Lazy apps: show only when actually hosted somewhere (they are
	# on-demand — "down" is their normal state).
	for app in $(jq -r 'to_entries[] | select(.key | startswith("$") | not) | select(.value.lazy == true) | .key' "$MANIFEST"); do
		hosts="$(hosting_loaded "$app")"
		[ -n "$hosts" ] || continue
		first="$(printf '%s\n' "$hosts" | head -n1)"
		joined="$(printf '%s\n' "$hosts" | paste -sd, -)"
		printf '  %-13s %-24s %-10s %s\n' "$app" "$joined" "lazy" "journalctl --user -u tinshell-$first"
	done
}

stop_islands() {
	local inst
	for inst in $(live_instances); do
		[ "$inst" = shell ] && continue
		"$TINSHELL_HOST" stop "$inst" >/dev/null 2>&1 || true
	done
	# manifest-unit apps: also stop their units (a quit app leaves the unit
	# inactive anyway; the explicit stop resets failed state).
	local app unit
	for app in $(echo "$LONGRUNNING" | tr ',' ' '); do
		unit="$(manifest_unit "$app")"
		[ -n "$unit" ] && systemctl --user stop "$unit" 2>/dev/null || true
	done
}

stop_shell() {
	systemctl --user stop tinshell-shell.service 2>/dev/null || true
}

start_island() {
	local app="$1" unit
	unit="$(manifest_unit "$app")"
	if [ -n "$unit" ]; then
		systemctl --user start "$unit"
	elif "$TINSHELL_HOST" start "$app" >/dev/null 2>&1; then
		return 0
	else
		echo "tinshell-mode: failed to start island '$app' (tinshell-host)" >&2
		return 1
	fi
}

shell_mode() {
	stop_islands
	# Brief settle so released bus names don't race the shell's ExecStartPre wait.
	sleep 0.3
	systemctl --user start tinshell-shell.service
	# `start` returns as soon as the unit is spawned (Type=simple) — the shell
	# still needs its own startup time, and tinshell-boot's probe now allows for a
	# slow cold boot, so WAIT for the instance rather than asserting it.
	# Printing "shell up" unconditionally is what made a refused switch (the
	# duplicate-host guard exits before the shell ever starts) look like a
	# successful one.
	local i
	for i in $(seq 1 180); do
		if shell_live; then
			echo "tinshell-mode: shell up"
			return 0
		fi
		systemctl --user is-active --quiet tinshell-shell.service || break
		sleep 0.25
	done
	echo "tinshell-mode: shell did NOT come up — still island mode (journalctl --user -u tinshell-shell)" >&2
	return 1
}

island_mode() {
	stop_shell
	sleep 0.3
	local app
	for app in $(echo "$LONGRUNNING" | tr ',' ' '); do
		start_island "$app" && echo "tinshell-mode: island $app up"
	done
}

case "${1:-status}" in
	status) status ;;
	shell) shell_mode ;;
	island)
		shift
		if [ $# -gt 0 ]; then
			stop_shell
			for app in "$@"; do start_island "$app" && echo "tinshell-mode: island $app up"; done
		else
			island_mode
		fi
		;;
	toggle)
		if shell_live; then island_mode; else shell_mode; fi
		;;
	*)
		sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
		exit 1
		;;
esac
