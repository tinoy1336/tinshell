#!/usr/bin/env bash
# tinshell-boot.sh — boot orchestrator for the shell instance.
#
# Subcommands:
#   boot    tinshell-shell.service ExecStart (foreground, Type=simple):
#     1. `tinshell-host warm shell` — fills the ONE universal bundle cache. A
#        build failure here means the shell spawn WILL fail.
#     2. Spawn the shell as a foreground child; health-probe within the
#        probe window (PROBE_WINDOW_S). Every OTHER artifact (the per-app
#        bundle caches, the greeter dist bundles) and the freshness verdict
#        are NOT dependencies of the spawn, so they run in the BACKGROUND
#        (step 2b, reaped before this script settles) while the shell
#        initialises — in front of the spawn they cost more than the shell's
#        own start. See warm_other_artifacts / reap_hygiene.
#     3. Healthy  → `wait $pid; exit $rc` — the SCRIPT is the unit's main
#        process and dies WITH the child, propagating the exit code so
#        systemd's Restart=on-failure sees every crash.
#     4. Unhealthy → kill the child, engage the fallback fleet, exit 0. The
#        exit is load-bearing: a script that stays alive
#        as the unit's MainPID leaves the unit reading `active` while no
#        shell exists, which turns every `systemctl --user start
#        tinshell-shell` (the login autostart, `tinshell-mode shell`, the polkit
#        recovery) into a SILENT no-op — and `tinshell-mode shell` has already
#        stopped the islands by then, so the desktop is left with NO TINSHELL
#        surface at all. Exit 0 IS a success result, so Restart=on-failure
#        does not re-run boot; the unit goes INACTIVE (honest state — the
#        fleet serves, this unit does not) and a later `start` re-runs the
#        whole path, made safe by the no-double-spawn guard.
#   fleet   tinshell-islands-fallback.service (OnFailure=, oneshot): covers
#     restart-exhaustion (the shell crash-looped past StartLimitBurst). Engages
#     the same fleet, with the no-double-spawn guard — the single guard
#     shared by both fleet paths.
#
# Fleet modes:
#   perapp   universal bundle BUILD failed → islands launch via their
#            PER-APP bundles (`run.sh <app>`, the apps/<app>/app.ts entries —
#            one broken app's syntax error must not take down the fleet, and
#            the universal bundle is exactly what is broken in this case),
#            each as its OWN transient unit `tinshell-<app>` so it survives this
#            unit's teardown.
#   dispatch bundle OK but the bus was never claimed / the shell crashed
#            repeatedly → manifest `unit` dispatch: apps.json names a
#            `unit` → `systemctl --user start <unit>`; no unit →
#            `tinshell-host start <app>` (transient unit). The unit-vs-host
#            decision lives in exactly one place — the manifest.
#
# Every fleet app therefore runs in its OWN systemd unit — never as a forked
# child of this script, which would sit in tinshell-shell.service's cgroup and be
# killed with it the moment `boot` exits after a fleet fallback.
#
# Fleet set = the long-running set ONLY (surfaces + services — same set as
# `tinshell-mode island` with no args). Lazy apps stay on-demand: the router
# cold-starts them per request through tinshell-host.
#
# Test hooks (failure-shape verification):
#   TINSHELL_BOOT_RAW_SET="shell,bogusapp" — spawn the shell with a raw TINSHELL_HOST_SET
#   that passes no validation (bypasses tinshell-host) so the universal entry
#   hard-errors → shape (b): bundle fine, bus never claimed → dispatch fleet.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
TINSHELL_HOME="$(cd "$DIR/../.." && pwd)"
TINSHELL_HOST="$TINSHELL_HOME/common/shell/tinshell-host.sh"
RUNSH="$TINSHELL_HOME/common/shell/run.sh"
NOTIFY_FAILED="$TINSHELL_HOME/common/shell/notify-failed.sh"
MANIFEST="$TINSHELL_HOME/common/shell/apps.json"
BUILD_ALL="$TINSHELL_HOME/scripts/build-all.sh"
CHECK_BUILDS="$TINSHELL_HOME/scripts/check-builds.sh"

# Hard ceilings for the warm step: a bundler that hangs must never hold the
# boot path in the foreground.
WARM_ALL_TIMEOUT=300
FRESHNESS_TIMEOUT=120

FLEET_SET="dock,launcher,notifications,keyboard,clipboard,promptd,portal,polkit"

# Health-probe ceiling for the shell child. This is a CEILING, not a timeout
# to be tuned tight: the child's own exit is the fast failure signal (the
# probe breaks the moment `kill -0` fails), so a shell that cannot start is
# caught in well under a second. The window only bounds a child that is ALIVE
# but not yet serving, and a cold boot can spend 25s inside Gtk init waiting
# on org.freedesktop.portal.Settings (the D-Bus default timeout) while the
# portal backend is still coming up. A 10s window declared such a shell dead,
# killed it, and fell back to the fleet — every boot — even though the shell
# was healthy moments later.
PROBE_WINDOW_S=45

# Apply the session env union to THIS script's environment before spawning
# anything. The per-app fleet path (run.sh <app>) bypasses tinshell-host start
# (which applies host_env itself) — without this, fleet islands inherit the
# caller's (possibly wrong/missing) display env and die silently — the
# DISPLAY=:0 trap (agent shells carry DISPLAY=:1; boot units carry none).
while IFS='=' read -r k v; do export "$k=$v"; done < <("$TINSHELL_HOST" env)

log() { echo "tinshell-boot: $*"; }

# Millisecond clock for the boot-phase timings below: the journal is the only
# record of where a slow start spent its time, and the unit's own
# "Started" line fires at fork time (Type=simple), not at readiness.
now_ms() { date +%s%3N; }
step_ms() { # <label> <start-ms>
  log "step '$1': $(( $(now_ms) - $2 ))ms"
}

notify_fail() { # <app> <hint>
  if [ -x "$NOTIFY_FAILED" ]; then "$NOTIFY_FAILED" "$1" "$2"; fi
}

manifest_unit() { # <app> → unit name or empty
  jq -r --arg a "$1" '.[$a].unit // empty' "$MANIFEST" 2>/dev/null
}

# Shared no-double-spawn guard: engage ONLY if at least one
# fleet app is NOT hosted by a live instance. "Anything live" is NOT the
# test — promptd/portal/polkit islands are fleet members themselves; if
# they are up but the surfaces are dead, the fleet must still engage and
# fill the gaps. If ALL fleet apps are hosted, a fleet is already engaged
# (boot script or an earlier fallback run) — never double-spawn. A rare
# concurrent partial race loses only a bus-claim error (second claimant
# exits), never a broken state.
fleet_needed() {
  local app inst
  for app in ${FLEET_SET//,/ }; do
    for inst in $(ags list 2>/dev/null | awk 'NF'); do
      ags -i "$inst" request "" 2>/dev/null | grep -qw -- "$app" && { app=; break; }
    done
    [ -n "$app" ] && return 0 # some fleet app has no live host
  done
  return 1
}

# Spawn one fleet app: manifest unit first, then the mode-specific path.
fleet_spawn_app() { # <app> <mode>
  local app="$1" mode="$2" unit out
  unit="$(manifest_unit "$app")"
  if [ -n "$unit" ]; then
    systemctl --user start "$unit" >/dev/null 2>&1 && {
      log "fleet: $app via $unit"
      return 0
    }
    notify_fail "$app" "fleet: unit $unit failed to start — journalctl --user -u $unit"
    return 1
  fi
  if [ "$mode" = perapp ]; then
    # Own transient unit (the shape the dispatch path gets from tinshell-host): the
    # fleet must outlive this script. A forked child would be killed with this
    # unit's cgroup when `boot` exits after the fallback.
    local envargs=()
    while IFS='=' read -r k v; do envargs+=(--setenv="$k=$v"); done < <("$TINSHELL_HOST" env)
    systemctl --user reset-failed "tinshell-$app" 2>/dev/null || true
    systemctl --user stop "tinshell-$app" 2>/dev/null || true
    if out="$(systemd-run --user --unit="tinshell-$app" --property=Restart=on-failure \
      --property="StandardOutput=append:/tmp/tinshell-fleet-$app.log" \
      "${envargs[@]}" "$RUNSH" "$app" 2>&1)"; then
      log "fleet: $app via per-app bundle (transient unit tinshell-$app, log /tmp/tinshell-fleet-$app.log)"
    else
      log "fleet: $app per-app unit failed: $out"
      notify_fail "$app" "fleet: per-app unit tinshell-$app failed to start — journalctl --user -u tinshell-$app"
      return 1
    fi
  else
    if "$TINSHELL_HOST" start "$app" >/dev/null 2>&1; then
      log "fleet: $app via tinshell-host (transient unit)"
    else
      notify_fail "$app" "fleet: tinshell-host start failed — check tinshell-host output"
      return 1
    fi
  fi
}

fleet_engage() { # <mode>
  local mode="$1" app inst hosted
  if ! fleet_needed; then
    log "all fleet apps already hosted — fleet NOT double-spawned"
    return 0
  fi
  log "engaging fallback fleet (mode=$mode): $FLEET_SET"
  for app in ${FLEET_SET//,/ }; do
    fleet_spawn_app "$app" "$mode" || true
  done
  # Per-app probe; failures → notify chain. No auto-retry — a broken app
  # stays down and noisy.
  sleep 3
  for app in ${FLEET_SET//,/ }; do
    hosted=""
    for inst in $(ags list 2>/dev/null | awk 'NF'); do
      if ags -i "$inst" request "" 2>/dev/null | grep -qw -- "$app"; then
        hosted="$inst"
        break
      fi
    done
    if [ -z "$hosted" ]; then
      log "fleet: $app NOT servable after engage"
      notify_fail "$app" "fleet: app not servable after fallback — check island/unit logs"
    fi
  done
}

# Boot hygiene (step 2b), run in the background while the shell initialises:
# every artifact this user can build, then the freshness verdict. Neither is a
# dependency of the shell spawn; both are bounded by their own hard timeouts.
#
# The warm and the probe share ONE receipt file, minted here for this run alone:
# the warm records the artifacts it left current, the probe counts those as
# verified instead of re-deriving the source set a second time, and the file is
# removed as soon as the probe is done. A probe with no receipt (every other
# invocation, including `npm run check:builds` by hand) re-derives everything.
warm_other_artifacts() {
  local receipt out
  receipt="$(mktemp "${TMPDIR:-/tmp}/tinshell-warm-receipt.XXXXXX")" || receipt=""
  if ! TINSHELL_BUILD_RECEIPT="$receipt" timeout "$WARM_ALL_TIMEOUT" "$BUILD_ALL" --quiet; then
    log "artifact build-all FAILED — the artifacts above kept their last good build"
  fi
  # Both verdicts are relayed, fresh or stale: the probe's summary names the
  # store it read and how many artifacts it verified rather than re-derived, so
  # a store the warm did not write to cannot look like a stale tree.
  out="$(TINSHELL_BUILD_RECEIPT="$receipt" timeout "$FRESHNESS_TIMEOUT" "$CHECK_BUILDS" --quiet 2>&1)" || true
  printf '%s\n' "$out" | sed -n 's/^check-builds:/probe:/p' | while IFS= read -r line; do log "$line"; done
  [ -z "$receipt" ] || rm -f "$receipt"
}

# Bounded reap of the hygiene job. The wait itself is not the shell's problem
# (the shell serves the moment it mounts), but the script must not leave a
# background builder in the unit's cgroup, and the fleet path must reach the
# per-app bundles it fills. Overrun is abandoned rather than waited on — a
# wedged bundler must never hold the boot path or the fallback.
HYGIENE_WAIT_TICKS=1700 # 0.25s ticks = 425s, just past the 300s+120s inner ceilings
reap_hygiene() { # <pid>
  local ticks=0
  while kill -0 "$1" 2>/dev/null && [ "$ticks" -lt "$HYGIENE_WAIT_TICKS" ]; do
    sleep 0.25
    ticks=$((ticks + 1))
  done
  if kill -0 "$1" 2>/dev/null; then
    log "artifact warm still running after 425s — abandoned (nothing stale was served)"
    kill "$1" 2>/dev/null || true
  fi
  wait "$1" 2>/dev/null || true
}

cmd_boot() {
  local pid healthy build_ok=1 t_step

  # 1. Warm the universal bundle — the ONE artifact the shell spawn is a
  #    function of. Failure = the shell cannot work.
  t_step=$(now_ms)
  if ! "$TINSHELL_HOST" warm shell; then
    build_ok=0
    log "universal bundle BUILD FAILED — fallback fleet will use per-app bundles"
  fi
  step_ms warm-universal "$t_step"

  # 2. Spawn the shell as a foreground child.
  t_step=$(now_ms)
  if [ -n "${TINSHELL_BOOT_RAW_SET:-}" ]; then
    # test hook: raw set bypasses tinshell-host validation (failure-shape (b))
    export TINSHELL_HOST_SET="$TINSHELL_BOOT_RAW_SET" TINSHELL_HOST_INSTANCE=shell \
      TINSHELL_HOST_ENTRY=common/host/entry.ts TINSHELL_HOST_NAME=universal
    "$RUNSH" universal &
  else
    "$TINSHELL_HOST" start shell --foreground &
  fi
  pid=$!

  # 2b. Boot hygiene — every OTHER artifact this user owns (the per-app bundle
  #     caches the fallback fleet uses, the greeter login + lock bundles exec'd
  #     by greetd / hypridle) and the freshness verdict on the one artifact this
  #     user cannot build (the /etc/greetd deploy, root's step — a login or lock
  #     screen running code that is no longer in the repo is otherwise
  #     invisible from the session). NONE of it is needed to serve this shell,
  #     so it runs in the BACKGROUND: in front of the spawn it sat directly on
  #     the boot critical path for ~1.4s — longer than the shell's own start —
  #     while the shell above was already initialising. Both steps stay
  #     individual-timeout-guarded; the reaped wait below is for the script's
  #     own exit path (and the fleet, whose per-app bundles this fills), never
  #     for the shell's readiness.
  warm_other_artifacts &
  local hygiene_pid=$!

  # 3. Health probe: the shell must serve its namespaces within the window.
  # A dead child breaks the loop immediately; the window only bounds a live
  # child that is still initialising (see PROBE_WINDOW_S).
  healthy=0
  local probe_end=$((SECONDS + PROBE_WINDOW_S))
  while [ "$SECONDS" -lt "$probe_end" ]; do
    kill -0 "$pid" 2>/dev/null || break
    if ags -i shell request "" 2>/dev/null | grep -qw dock; then
      healthy=1
      break
    fi
    sleep 0.25
  done

  if [ "$healthy" = 1 ]; then
    step_ms shell-ready "$t_step"
    reap_hygiene "$hygiene_pid"
    # Blocking wait that ends only when the shell ends — the unit's main process
    # dies with the child and propagates its exit code (Restart=on-failure).
    wait "$pid"
    exit $?
  fi

  # 4. Unhealthy → kill the child, engage the fleet, exit 0.
  # The exit is what keeps the unit honest: staying alive here held
  # tinshell-shell.service `active` with no shell in it, so `systemctl --user start
  # tinshell-shell` (the login autostart, `tinshell-mode shell`, the polkit recovery)
  # silently did nothing while `tinshell-mode shell` had already stopped the
  # islands — desktop with no TINSHELL surface at all. Exit 0 = success = the unit
  # goes inactive and Restart=on-failure does not re-run boot; the fleet runs
  # in its own units and stands. A later start re-runs the whole path.
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  # The fleet's per-app bundle caches are exactly what the hygiene job fills —
  # reap it before engaging rather than racing the first app's build.
  reap_hygiene "$hygiene_pid"
  log "shell failed to hold the bus within the probe window — fallback fleet"
  if [ "$build_ok" = 0 ]; then
    fleet_engage perapp
  else
    fleet_engage dispatch
  fi
  log "boot exit 0 — unit inactive, fleet serving (a later start re-runs boot)"
  exit 0
}

cmd_fleet() {
  # OnFailure oneshot. NOTE: OnFailure= fires on EVERY failure result — not
  # only start-limit exhaustion — INCLUDING the first crash while
  # Restart=on-failure is about to recover. So: wait out one restart cycle
  # (RestartSec=5s + the boot probe window), then engage ONLY if the shell
  # is really gone. A recovering shell is left alone; a crash-loop that
  # exhausted StartLimit (or a restart that failed its own probe) engages
  # the fleet. Guard inside fleet_engage prevents double-spawn either way.
  sleep "$PROBE_WINDOW_S"
  if ags -i shell request "" 2>/dev/null | grep -qw dock; then
    log "shell instance serving again — fleet NOT engaged"
    return 0
  fi
  fleet_engage dispatch
}

case "${1:-}" in
  boot) cmd_boot ;;
  fleet) cmd_fleet ;;
  *)
    echo "usage: tinshell-boot.sh boot|fleet" >&2
    exit 1
    ;;
esac
