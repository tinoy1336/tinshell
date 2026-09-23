#!/usr/bin/env bash
# tinshell-route.sh — generic request router for the TINSHELL multi-app home.
#
# Routes "<app> <command...>" to the first LIVE instance hosting <app>.
#
# Probe order (map decides priority, NOT the full hosting set):
#   1. Map-listed instances (route-map.conf) in map order — production first;
#      a dev island must never hijack a keybind while the shell is up.
#   2. Any OTHER live instance (`ags list`) — dynamic combos created by
#      tinshell-host are routable with zero map edits (first servable hit wins).
# Only when NO live instance hosts the app does it cold-start the map's
# first instance (via tinshell-host.sh, flock-serialized), waits for a servable
# dispatcher, then fires. An app with no map entry at all (the applet OS-call
# backend, which rides the dock instance) is live-scan only: it is served by
# whichever live instance hosts it and never cold-started.
#
# Probing uses the empty request (lists the command namespaces) — every
# instance's registry root lists the app names (prefixed registration), so
# `ags -i <inst> request "" | grep -w <app>` is a servable check that works
# for the shell (all apps), per-app islands (dock/launcher/notifications/
# keyboard/clipboard) and every other island.
#
# Usage:
#   tinshell-route.sh notes "open foo"          → ags -i shell request "notes open foo"
#   tinshell-route.sh launcher toggle           → shell-surface request (shell first)
#   tinshell-route.sh promptd "askpass <b64>"   → promptd request (shell first)
#   tinshell-route.sh --no-start dock screengrab capture still select
#                                          → LIVE instances only; exit 2 when
#                                            nothing serves it
#
# Exit codes: 0 on a forwarded reply, EXCEPT one whose first line starts with
# `error:` — that is exit 1. The `ags` request CLI exits 0 for EVERY reply,
# `error: …` included, so a script cannot tell success from failure without
# parsing stdout; the router is the one client path all of them share, so the
# mapping lives here. The test is deliberately narrow: the first line only, the
# exact `error:` prefix only, nothing else inspected (a plain prefix test on
# the whole reply IS a first-line test — a later line's `error:` cannot make
# the string start with it). A JSON ENVELOPE IS NOT MAPPED: `applets …` replies
# are `{"ok":true,…}` / `{"ok":false,…}` and their clients parse the envelope
# only on exit 0 (common/applets/backend-client.ts), so mapping those would
# turn a structured `ok:false` answer into a transport failure. Every other
# reply keeps the CLI's own exit code untouched. Also: 1 on usage error or
# unknown app; 2 when --no-start found no live instance; non-zero if no
# instance ever became servable.
set -u

# --no-start: route to a LIVE instance only, never cold-start one. Keybind
# handlers use it so a keystroke never pays a bundle rebuild — they report the
# miss themselves instead.
NO_START=0
if [ "${1:-}" = "--no-start" ]; then
  NO_START=1
  shift
fi

APP="${1:?usage: tinshell-route.sh [--no-start] <app> <command...>}"
shift
[ $# -ge 1 ] || {
  echo "tinshell-route: missing command for '$APP'" >&2
  exit 1
}
CMD="$*"

DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# readlink -f: the ~/.local/bin/tinshell-route symlink must resolve to the repo
# (bare dirname gives the symlink's dir → route-map.conf missing → no app has
# a cold-start target).
MAP="$DIR/route-map.conf"
TINSHELL_HOME="$HOME/dev/tinshell"
probed=""

# Instance order for this app: comma-separated, production first. Empty when
# the app has no map entry — it then has no cold-start target either (see the
# live-scan step below).
instances="$(awk -F= -v app="$APP" '$1==app {print $2}' "$MAP" | head -1)"

# Servable probe: the empty request lists the command namespaces; exit 0 +
# the app name present = this instance hosts the app AND answers requests.
# NOTE: a resident combo lists its LAZY namespaces too (registry
# pre-declaration) — routing notes at a combo is CORRECT: the request
# pre-step lazy-loads notes inside that instance.
probe() {
  ags -i "$1" request "" 2>/dev/null | grep -qw -- "$APP"
}

# Forward the request to a servable instance, print its reply verbatim and
# apply the `error:` exit mapping (see the exit-code contract in the header).
# `forward <instance> <request> [quiet]` — `quiet` drops the CLI's stderr, the
# cold-start path where a freshly spawned instance's own startup output is not
# part of the reply. The reply is unmodified: command substitution collapses a
# run of trailing newlines to the one printed here, and nothing else changes.
forward() {
  local out rc
  if [ -n "${3:-}" ]; then
    out="$(ags -i "$1" request "$2" 2>/dev/null)"
  else
    out="$(ags -i "$1" request "$2")"
  fi
  rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  case "$out" in
    error:*) rc=1 ;;
  esac
  return "$rc"
}

# 1. Map-listed instances in map order (production priority).
for inst in $(printf '%s' "$instances" | tr ',' ' '); do
  if probe "$inst"; then
    forward "$inst" "$APP $CMD"
    exit $?
  fi
  probed="${probed:+$probed
}$inst"
done

# 2. Live-scan every OTHER live instance (dynamic combos; map edits never
#    needed). Skip the map-listed ones already probed above.
for inst in $(ags list 2>/dev/null); do
  printf '%s' "$probed" | grep -qxF -- "$inst" && continue
  if probe "$inst"; then
    forward "$inst" "$APP $CMD"
    exit $?
  fi
done

# Nothing live served it. A map-listed app is cold-started below; an app with
# no map entry has no instance to start (and a misspelled app name must not
# spawn anything), so the request is refused.
if [ -z "$instances" ]; then
  echo "tinshell-route: no live instance serves '$APP' (no route-map entry in route-map.conf)" >&2
  exit 1
fi

if [ "$NO_START" = 1 ]; then
  echo "tinshell-route: no live instance serves '$APP' (cold start disabled)" >&2
  exit 2
fi

# None live — cold-start the first instance (flock-serialized so two
# concurrent routes can't race two spawns of it), wait for a servable
# dispatcher.
# Cold-start goes through tinshell-host.sh (manifest unit/transient dispatch,
# duplicate-host guard, health probe); the unit/run.sh paths remain
# as fallback for a host-script or manifest failure.
#
# The instance started, waited for and fired at is ALWAYS $FIRST — the map's
# first entry (the production instance). tinshell-host derives the instance name
# from the set it is handed, so a spawn of any other set creates an instance
# this router never probes and never fires at.
FIRST="${instances%%,*}"
(
  flock 9
  if probe "$FIRST"; then
    exit 0 # a peer cold-started while we waited
  fi
  if [ -x "$TINSHELL_HOME/common/shell/tinshell-host.sh" ]; then
    "$TINSHELL_HOME/common/shell/tinshell-host.sh" start "$FIRST" >/dev/null 2>&1 || true
  elif [ -f "$HOME/.config/systemd/user/tinshell-$FIRST.service" ]; then
    systemctl --user start "tinshell-$FIRST.service" >/dev/null 2>&1 || true
  elif [ -x "$TINSHELL_HOME/apps/$FIRST/run.sh" ]; then
    "$TINSHELL_HOME/apps/$FIRST/run.sh" >/dev/null 2>&1 &
  fi
  # Wait up to 15s (150 × 0.1s) — matches tinshell-bus-wait.sh's budget. A cold
  # start that includes a bundle rebuild can exceed 6s; the router must not
  # declare "never became servable" while the instance is still coming up.
  for _ in $(seq 1 150); do
    if probe "$FIRST"; then
      exit 0
    fi
    sleep 0.1
  done
  exit 1
) 9>"/tmp/tinshell-route-$FIRST.lock" || {
  echo "tinshell-route: '$APP' never became servable" >&2
  exit 1
}

forward "$FIRST" "$APP $CMD" quiet
exit $?
