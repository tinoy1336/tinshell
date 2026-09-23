#!/usr/bin/env bash
# hyprland-session-redirect.sh — pacman PostTransaction hook action.
#
# Installed to /usr/local/lib/ by setup.sh (root section, 10d) and run by
# /etc/pacman.d/hooks/95-hyprland-session-log.hook after every hyprland
# package transaction. Runs as ROOT.
#
# WHAT IT REPAIRS: the console-log redirect on the session's wayland entry.
# greetd starts the user session from /usr/share/wayland-sessions/hyprland.desktop
# and runs its Exec line through a shell (`/bin/sh -c "... exec <cmd>"`,
# config `source_profile = true`), so the session compositor inherits the VT as
# its stdout/stderr. Hyprland prints its banner and its pre-config log lines
# BEFORE it parses the config (`debug.enable_stdout_logs = false` cannot reach
# them), so without a redirect VT 1 turns into a text console full of Hyprland
# lines at every login and logout. That entry is package-owned (hyprland ships
# it), so every hyprland upgrade reinstalls the stock bare
# `Exec=/usr/bin/start-hyprland` and the spam returns on the next login.
#
# TRADE-OFF: this mutates a package-owned file in place — the same shape as the
# original manual fix. The cleaner alternative (a repo-owned entry under
# /usr/local/share/wayland-sessions, preferred by scanner order in the TINSHELL
# greeter's SessionPicker) needs a greeter code change and a bundle redeploy, so
# it is not this hook's job. `pacman -Qkk hyprland` reports this one file as
# altered; that is expected and is the cost of keeping the stock path.
#
# LOG TARGET: "${XDG_RUNTIME_DIR:-/tmp}/hyprland-session.log". greetd exports
# XDG_RUNTIME_DIR (pam_systemd sets it while the PAM session opens, before the
# session command runs — confirmed in the live session's /proc/<pid>/environ),
# so the log lands in the per-user runtime dir; the `:-/tmp` fallback keeps the
# redirect resolvable if it is ever unset, because an unset variable would make
# the redirect itself fail and take the login down with it. `>` truncates per
# session start: a Hyprland session log runs to ~2 MB and /tmp is a 15 GB tmpfs,
# so appending across logins would grow unbounded. This file absorbs the
# pre-config banner, the Xwayland/child-process noise; Hyprland's own post-config
# log file (/run/user/<uid>/hypr/<sig>/hyprland.log) is unaffected.
#
# IDEMPOTENT + TRANSACTION-SAFE: an already-redirected entry is a no-op, and a
# missing/unreadable file or an entry with no start-hyprland Exec line only
# logs. Every path exits 0 — a failing PostTransaction hook can abort a package
# upgrade, and console hygiene must never break pacman.
set -u

SESSION_FILE=/usr/share/wayland-sessions/hyprland.desktop
CANONICAL_EXEC='Exec=/usr/bin/start-hyprland >"${XDG_RUNTIME_DIR:-/tmp}/hyprland-session.log" 2>&1'

if [ ! -f "$SESSION_FILE" ]; then
  echo "hyprland-session-redirect: $SESSION_FILE absent — nothing to do"
  exit 0
fi

current_exec=$(grep -m1 '^Exec=' "$SESSION_FILE" || true)
if [ "$current_exec" = "$CANONICAL_EXEC" ]; then
  echo "hyprland-session-redirect: redirect already present in $SESSION_FILE — nothing to do"
  exit 0
fi

# Only rewrite an entry that actually launches Hyprland. Anything else (a
# different session launcher, a hand-edited entry) is left alone.
case "$current_exec" in
  *start-hyprland*) ;;
  *)
    echo "hyprland-session-redirect: no start-hyprland Exec line in $SESSION_FILE (found: ${current_exec:-none}) — leaving it unchanged"
    exit 0
    ;;
esac

tmp=$(mktemp "${SESSION_FILE}.XXXXXX") ||
  { echo "hyprland-session-redirect: cannot create a temp file next to $SESSION_FILE — skipping" >&2; exit 0; }
trap 'rm -f "$tmp"' EXIT

awk -v exec_line="$CANONICAL_EXEC" '
  /^Exec=/ && !done { print exec_line; done = 1; next }
  { print }
  END { if (!done) exit 3 }
' "$SESSION_FILE" >"$tmp" ||
  { echo "hyprland-session-redirect: rewrite failed — $SESSION_FILE left unchanged" >&2; exit 0; }

# Keep the packaged mode (root:root 0644, world-readable) and swap atomically.
chmod 0644 "$tmp" && mv "$tmp" "$SESSION_FILE" ||
  { echo "hyprland-session-redirect: could not replace $SESSION_FILE — it is unchanged" >&2; exit 0; }
trap - EXIT

echo "hyprland-session-redirect: re-applied the session console-log redirect in $SESSION_FILE"
exit 0
