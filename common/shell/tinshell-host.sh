#!/usr/bin/env bash
# tinshell-host.sh — the ONE distributor for every TINSHELL instance shape.
#
# An instance = a SET of apps + one bus name. Any shape — singleton island,
# arbitrary combo (instance name = sorted set joined with "."), or the full
# shell preset — runs the SAME universal bundle (common/host/entry.ts, cached
# at ~/.cache/tinshell-bundle/universal/) with the set selected at RUNTIME from
# env. No code generation anywhere. tinshell-mode is a thin preset layer over
# this script; the boot path (tinshell-boot.sh) and the OnFailure fallback unit
# also spawn through it.
#
# Usage:
#   tinshell-host start <set> [--name N] [--foreground] [--force] [--if-absent]
#                   [extra argv...]
#       Spawn an instance hosting <set> (comma-separated app names, order
#       irrelevant). Instance name defaults to the sorted set joined with
#       "." (e.g. dock.notifications); --name overrides. The instance is a
#       transient systemd --user unit (tinshell-<name>) with Restart=on-failure
#       — supervised lifecycle + journalctl --user logs for EVERY shape,
#       not just the shell. --foreground execs the wrapper directly (unit
#       ExecStart path). Extra argv is forwarded to the entry's main()
#       (cold-start "open <x>" parity: tinshell-host start notes open foo).
#       --if-absent makes an already-hosted app a NO-OP SUCCESS instead of a
#       refusal: the resident dev units (tinshell-portal.service) use it so a unit
#       whose app a live host already serves exits 0 and stays down rather
#       than failing the duplicate-host guard and letting Restart=on-failure
#       spin it forever.
#   tinshell-host warm <set> [--name N]
#       Build-only (cache fill, no spawn) — tinshell-warm.service uses this.
#   tinshell-host stop <instance>
#       `<instance> quit` request (the app's OWN teardown path — a systemctl
#       stop only SIGTERMs and runs no app code), a brief wait for the process
#       to exit, then unit stop + reset-failed (a wedged instance stops
#       regardless; a clean exit is never resurrected).
#   tinshell-host list
#       Live instances (ags list).
#   tinshell-host status
#       Per-instance table: unit state + which manifest apps each live
#       instance actually serves (probe-based, no static set assumptions).
#
# The TINSHELL_SHELL rule: TINSHELL_SHELL=1
# iff the set has an EAGER member (surface/service hosted → resident — a
# loaded lazy app's last-window close must never quit the process, notes.ts:166
# isShell gate). A pure-lazy set (e.g. `start notes`) is a standalone island:
# TINSHELL_SHELL unset → quit-on-close live = standalone island semantics.
#
# The env union below (Wayland session identity, GPU-wake pins, GSK_RENDERER)
# is the ONE session env applied to every instance shape — spawned apps and
# Gtk rendering must behave identically in an island and in the shell.
# The unit templates carry no app env (see systemd/tinshell-shell.service).
set -euo pipefail

DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# readlink -f: the ~/.local/bin/tinshell-host symlink must resolve to the repo
# (bare dirname gives the symlink's dir → TINSHELL_HOME = $HOME → manifest missing).
TINSHELL_HOME="$(cd "$DIR/../.." && pwd)"
MANIFEST="$TINSHELL_HOME/common/shell/apps.json"
RUNSH="$TINSHELL_HOME/common/shell/run.sh"
HOST_ENTRY="common/host/entry.ts"
NOTIFY_FAILED="$TINSHELL_HOME/common/shell/notify-failed.sh"

[ -f "$MANIFEST" ] || { echo "tinshell-host: manifest missing: $MANIFEST" >&2; exit 1; }
command -v jq >/dev/null || { echo "tinshell-host: jq required" >&2; exit 1; }

die() { echo "tinshell-host: $*" >&2; exit 1; }

# ── manifest helpers ──────────────────────────────────────────────────────
manifest_apps()   { jq -r 'keys[] | select(startswith("$") | not)' "$MANIFEST"; }
manifest_lazy()   { jq -r 'to_entries[] | select(.key | startswith("$") | not) | select(.value.lazy == true) | .key' "$MANIFEST"; }
manifest_valid()  { jq -e --arg app "$1" 'has($app)' "$MANIFEST" >/dev/null; }

# Resolve + validate a comma-separated set → sorted unique app list.
# Preset: "shell" expands to the full long-running set (the 8 always-on
# apps — surfaces + services; the 4 lazy desktop apps ride along as lazy
# registrations, loaded on demand).
SHELL_PRESET="dock,launcher,notifications,keyboard,clipboard,promptd,portal,polkit"
resolve_set() {
  local raw="$1" app out=""
  [ -n "$raw" ] || die "empty app set"
  [ "$raw" = "shell" ] && raw="$SHELL_PRESET"
  IFS=',' read -ra parts <<<"$raw"
  for app in "${parts[@]}"; do
    app="$(echo "$app" | xargs)" # trim
    [ -n "$app" ] || continue
    if ! manifest_valid "$app"; then
      die "unknown app '$app' (not in apps.json — known: $(manifest_apps | tr '\n' ' '))"
    fi
    out="$out $app"
  done
  echo "$out" | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ' | sed 's/ $//'
}

# Live-host snapshot: ONE `ags list` plus one namespace probe per live
# instance, answering "is <app> hosted, and by whom?" for the whole set. The
# guard asks that question once per app, and probing per question cost two
# `ags` invocations each — a full shell start paid ~16 of them before it
# reached the spawn. The snapshot is refreshed after a shim retires (the guard
# must see the retired instance gone).
HOST_SNAPSHOT="" # "<instance>\t<namespace> <namespace> …" per line
snapshot_hosts() {
  local inst
  HOST_SNAPSHOT=""
  for inst in $(ags list 2>/dev/null | awk '{print $1}'); do
    HOST_SNAPSHOT="$HOST_SNAPSHOT$inst"$'\t'"$(instance_namespaces "$inst" | tr '\n' ' ')"$'\n'
  done
}

# hosted_by <app> → the first live instance serving it, or nothing (rc 1).
hosted_by() {
  local app="$1" inst srv
  while IFS=$'\t' read -r inst srv; do
    [ -n "$inst" ] || continue
    case " $srv " in *" $app "*)
      echo "$inst"
      return 0
      ;;
      esac
  done <<<"$HOST_SNAPSHOT"
  return 1
}

# Instance hosting-check against the snapshot (duplicate-host guard — the
# bus-name race rule, now enforced in code).
app_hosted_by_any() {
  hosted_by "$1"
}

# The APP namespaces an instance serves. The `request ""` reply is ONE line —
# `available commands: <ns>, <ns>, …` — and `lazy` is the loader's own
# namespace, present in every resident instance, so it is not an app and is
# dropped here.
instance_namespaces() { # <instance> → one app namespace per line
  ags -i "$1" request "" 2>/dev/null \
    | sed -n 's/^available commands: *//p' \
    | tr ',' '\n' \
    | awk '{print $1}' \
    | grep -vE '^$|^lazy$'
}

# Does <instance> serve <app> and NOTHING else? A single-app host is a SHIM,
# not a real instance: `tinshell-mode island <app>` creates one deliberately, and
# the boot fleet's per-app path can too. Answers from the snapshot.
instance_serves_only() { # <instance> <app>
  local srv
  srv="$(awk -F'\t' -v i="$1" '$1 == i {print $2; exit}' <<<"$HOST_SNAPSHOT")"
  [ "$(printf '%s\n' $srv | grep -c .)" -eq 1 ] || return 1
  [ "$srv" = "$2" ]
}

# A single-app SHIM yields to a host that serves it as part of a LARGER SET.
# Without this a shim left over from an earlier start makes the duplicate-host
# guard refuse EVERY `tinshell-host start shell`, so the desktop can never leave
# island mode. Only a strict-subset shim is retired, and only for a multi-app
# set — a same-shape start (one app, one host) is a plain duplicate and still
# refuses. A real island or the shell is never touched, so the guard keeps
# protecting against genuine double-claims.
retire_shims_for() { # <set list>
  local app holder retired=0
  [ "$(printf '%s\n' $1 | grep -c .)" -gt 1 ] || return 0
  for app in $1; do
    holder="$(hosted_by "$app")" || continue
    if instance_serves_only "$holder" "$app"; then
      retire_shim "$holder" || true
      retired=1
    fi
  done
  # A retired shim is still in the snapshot — refresh so the guard below sees
  # the bus genuinely free.
  [ "$retired" = 1 ] && snapshot_hosts
  return 0
}

retire_shim() { # <instance>
  echo "tinshell-host: retiring single-app shim '$1' (a real host supersedes it)" >&2
  if ! ags -i "$1" request "$1 quit" >/dev/null 2>&1; then
    echo "tinshell-host: shim '$1' did not answer quit" >&2
    return 1
  fi
  local _
  for _ in $(seq 1 20); do
    ags -i "$1" request "" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  echo "tinshell-host: shim '$1' still live after quit" >&2
  return 1
}

# Health probe: every app in the set must answer its namespace within 10s.
# One namespace probe per poll, not one per app (the reply already lists them
# all).
health_probe() {
  local instance="$1" set_list="$2" app up="" down="" ns
  local deadline=$((SECONDS + 10))
  while [ $SECONDS -lt $deadline ]; do
    up=""; down=""
    ns="$(instance_namespaces "$instance" | tr '\n' ' ')"
    for app in $set_list; do
      case " $ns " in
        *" $app "*) up="$up $app" ;;
        *) down="$down $app" ;;
      esac
    done
    [ -z "${down// /}" ] && break
    sleep 0.25
  done
  local rc=0
  for app in $set_list; do
    if printf '%s' "$up" | grep -qw -- "$app"; then
      echo "  UP   $app"
    else
      echo "  DOWN $app"
      rc=3
      if [ -x "$NOTIFY_FAILED" ]; then
        "$NOTIFY_FAILED" "$app" "journalctl --user -u tinshell-$instance" || true
      fi
    fi
  done
  return $rc
}

# ── env union (the ONE session env union for every instance shape) ───────
HOST_ENV_KEYS=(WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE
  XDG_SESSION_DESKTOP DESKTOP_SESSION MOZ_ENABLE_WAYLAND _JAVA_AWT_WM_NONREPARENTING
  __EGL_VENDOR_LIBRARY_FILENAMES VK_ICD_FILENAMES GSK_RENDERER)
host_env() {
  cat <<'EOF'
WAYLAND_DISPLAY=wayland-1
DISPLAY=:0
XDG_CURRENT_DESKTOP=Hyprland
XDG_SESSION_TYPE=wayland
XDG_SESSION_DESKTOP=Hyprland
DESKTOP_SESSION=/usr/share/wayland-sessions/hyprland.desktop
MOZ_ENABLE_WAYLAND=1
_JAVA_AWT_WM_NONREPARENTING=1
__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json
VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/radeon_icd.json
GSK_RENDERER=gl
EOF
}

cmd="${1:-}"; [ -n "$cmd" ] || die "usage: tinshell-host start|warm|stop|list|status (see header)"
shift || true

case "$cmd" in
  start|warm)
    SET_RAW=""; NAME=""; FOREGROUND=0; FORCE=0; IF_ABSENT=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) NAME="${2:-}"; shift 2 ;;
        --name=*) NAME="${1#*=}"; shift ;;
        --foreground) FOREGROUND=1; shift ;;
        --force) FORCE=1; shift ;;
        --if-absent) IF_ABSENT=1; shift ;;
        --*) die "unknown option $1" ;;
        *) if [ -z "$SET_RAW" ]; then SET_RAW="$1"; else break; fi; shift ;; # extra argv after the set
      esac
    done
    EXTRA_ARGV=("$@")
    SET_LIST="$(resolve_set "$SET_RAW")" || exit $?
    [ -n "$NAME" ] || {
      if [ "$SET_RAW" = "shell" ]; then NAME="shell"
      else NAME="$(printf '%s' "$SET_LIST" | tr ' ' '.')"; fi
    }
    case "$NAME" in *[!A-Za-z0-9_.-]*|'') die "illegal instance name '$NAME' (D-Bus + systemd safe charset: [A-Za-z0-9_.-])" ;; esac

    # TINSHELL_SHELL rule: TINSHELL_SHELL=1
    # iff the set has an EAGER member — an instance hosting a surface/service is
    # resident, so a loaded lazy app's last-window close must never quit it
    # (notes.ts:166 isShell gate), and its lazy-not-in-set apps are registered
    # for on-demand loading. A set of ONLY lazy apps (e.g. `start notes`) is a
    # standalone island: NOTHING is registered (empty lazy registry), TINSHELL_SHELL
    # unset → quit-on-close live = standalone island semantics.
    # TINSHELL_SHELL rule belongs to the SPAWN path only; the build-only warm below
    # never reads it (nor the session env union), so both are computed after
    # the warm branch.
    if [ "$cmd" = warm ]; then
      TINSHELL_BUNDLE_WARM=1 TINSHELL_HOST_ENTRY="$HOST_ENTRY" TINSHELL_HOST_NAME=universal \
        "$RUNSH" universal
      exit $?
    fi

    LAZY_LIST="$(manifest_lazy | sort)"
    EAGER_IN_SET="$(comm -23 <(printf '%s\n' $SET_LIST | sort) <(printf '%s\n' $LAZY_LIST | sort))"
    if [ -n "$EAGER_IN_SET" ]; then export TINSHELL_SHELL=1; else unset TINSHELL_SHELL || true; fi

    # Host vars reach the child in BOTH spawn paths (foreground exec env +
    # transient-unit --setenv) — run.sh keys its host mode off TINSHELL_HOST_ENTRY.
    # TINSHELL_HOST_SET serializes COMMA-separated (entry.ts splits on ",").
    export TINSHELL_HOST_ENTRY="$HOST_ENTRY" TINSHELL_HOST_NAME=universal TINSHELL_HOST_SET="$(printf '%s' "$SET_LIST" | tr ' ' ',')" TINSHELL_HOST_INSTANCE="$NAME"

    # Duplicate-host guard: refuse overlapping sets unless --force (exit 2).
    # Single-app shims are retired first — they exist only because no host
    # owned the name, and a host that can serve the app as part of a SET
    # supersedes them (see retire_shims_for).
    if [ "$FORCE" != 1 ]; then
      # ONE live-host snapshot answers the shim retirement AND the guard below.
      snapshot_hosts
      retire_shims_for "$SET_LIST"
      for app in $SET_LIST; do
        if holder="$(app_hosted_by_any "$app")"; then
          if [ "$IF_ABSENT" = 1 ]; then
            echo "tinshell-host: app '$app' already hosted by live instance '$holder' — nothing to do (--if-absent)" >&2
            exit 0
          fi
          echo "tinshell-host: app '$app' already hosted by live instance '$holder' — refusing to double-claim (use --force to override)" >&2
          exit 2
        fi
      done
    fi

    # Env for the child: host vars + the session union.
    while IFS='=' read -r k v; do export "$k=$v"; done < <(host_env)

    if [ "$FOREGROUND" = 1 ]; then
      # Every instance (shell + foreground islands) tees stderr into ONE
      # crash file — gjs uncaught exceptions / unhandled rejections print
      # there as "JS ERROR:" (see AGENTS.md). Journal capture is preserved
      # (the tee re-emits to the original stderr).
      exec 2> >(tee -a "${TINSHELL_CRASH_LOG:-/tmp/tinshell-crashes.log}" >&2)
      exec "$RUNSH" universal "${EXTRA_ARGV[@]}"
    fi

    # Transient-unit spawn. Pre-clean stale state FIRST: a clean `ags quit`
    # leaves a dead-but-registered transient unit whose name blocks re-spawn
    # (one per island; never a duplicate host).
    systemctl --user reset-failed "tinshell-$NAME" 2>/dev/null || true
    systemctl --user stop "tinshell-$NAME" 2>/dev/null || true
    sleep 0.1

    SPAWN_ARGS=(--user --unit="tinshell-$NAME" --property=Restart=on-failure)
    SPAWN_ARGS+=(--setenv="TINSHELL_HOST_ENTRY=$HOST_ENTRY" --setenv="TINSHELL_HOST_NAME=universal")
    SPAWN_ARGS+=(--setenv="TINSHELL_HOST_SET=$(printf '%s' "$SET_LIST" | tr ' ' ',')" --setenv="TINSHELL_HOST_INSTANCE=$NAME")
    if [ -n "${TINSHELL_SHELL+x}" ]; then SPAWN_ARGS+=(--setenv="TINSHELL_SHELL=$TINSHELL_SHELL"); fi
    while IFS='=' read -r k v; do SPAWN_ARGS+=(--setenv="$k=$v"); done < <(host_env)

    if ! systemd-run "${SPAWN_ARGS[@]}" bash -c 'exec 2> >(tee -a "$1" >&2); shift; exec "$@"' _ "${TINSHELL_CRASH_LOG:-/tmp/tinshell-crashes.log}" "$RUNSH" universal "${EXTRA_ARGV[@]}" 2>&1; then
      die "systemd-run failed for instance '$NAME'"
    fi

    # Health probe: per-app UP/DOWN; exit 3 (failures listed) / 0 all up.
    echo "tinshell-host: instance '$NAME' hosting: $SET_LIST"
    health_probe "$NAME" "$SET_LIST"
    exit $?
    ;;

  stop)
    [ $# -ge 1 ] || die "usage: tinshell-host stop <instance>"
    # Quit through the instance's OWN request surface first: that is where an
    # app's quit teardown runs (`<instance> quit` replies "quitting", then runs
    # the teardown and quits). Wait ≤ ~2s for the instance to disappear, then
    # stop the unit REGARDLESS — an instance that is wedged or never answers
    # must still stop. A dead/absent instance fails the request immediately and
    # falls straight through to the unit stop.
    if ags -i "$1" request "$1 quit" >/dev/null 2>&1; then
      for _ in $(seq 1 10); do
        ags -i "$1" request "" >/dev/null 2>&1 || break
        sleep 0.2
      done
    fi
    systemctl --user stop "tinshell-$1" 2>/dev/null || true
    systemctl --user reset-failed "tinshell-$1" 2>/dev/null || true
    echo "tinshell-host: stopped $1"
    ;;

  list)
    exec ags list
    ;;

  env)
    # print the session env union (one KEY=VALUE per line) — consumers:
    # tinshell-boot.sh exports it before spawning ANY child (the per-app fleet
    # path bypasses tinshell-host start, which applies env itself). The DISPLAY
    # trap: a gjs app spawned with the wrong/missing DISPLAY=:0 dies
    # SILENTLY ~1s after Gtk init with rc=0 and no error.
    host_env
    ;;

  status)
    printf '%-28s %-12s %s\n' "INSTANCE" "UNIT" "APPS SERVED (probe)"
    for inst in $(ags list 2>/dev/null | awk '{print $1}'); do
      ustate="$(systemctl --user is-active "tinshell-$inst" 2>/dev/null || echo 'no-unit')"
      served=""
      for app in $(manifest_apps); do
        if ags -i "$inst" request "" 2>/dev/null | grep -qw -- "$app"; then
          served="$served $app"
        fi
      done
      printf '%-28s %-12s %s\n' "$inst" "$ustate" "${served:- (none)}"
    done
    ;;
  *)
    die "unknown command '$cmd' (start|warm|stop|list|status)"
    ;;
esac
