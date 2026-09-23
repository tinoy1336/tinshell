#!/usr/bin/env bash
# deploy-config.sh — config safety for the deploy scripts (install.sh, setup.sh).
#
# SOURCE this file; it runs nothing on its own:
#
#   TINSHELL_HOME="$(cd "$(dirname "$0")/../.." && pwd)"
#   . "$TINSHELL_HOME/common/shell/deploy-config.sh"
#
# The rule these helpers implement: a deploy NEVER silently reverts a config
# the user has already set. Three destination classes, three implementations —
# never copy one of these bodies into a script:
#
#   deploy_seed_config <src> <dst>
#     A LIVE config whose shipped file is only a SEED: the app's loader merges
#     the defaults UNDER the live file, so overwriting it buys nothing.
#       <dst> absent                → installed from <src> (a fresh machine
#                                     still gets a working config).
#       <dst> identical to <src>    → nothing written.
#       <dst> differs               → PRESERVED, with the override printed
#                                     (TINSHELL_DEPLOY_FORCE=1 / --force).
#     Non-zero only when <src> is missing or a write failed.
#
#   deploy_payload_config <src> <dst>
#     A config a daemon reads DIRECTLY, with no defaults/merge channel
#     (/etc/greetd/config.toml, /etc/greetd/greeter.lua, /etc/pam.d/greetd):
#     the shipped file is the only route a repo change has to the machine, so
#     preserving it would silently stop shipping fixes. Always installed — and
#     the line names the md5 of the file it superseded, so a hand-edit about to
#     be replaced is visible rather than lost in silence.
#
#   deploy_config_line <file> <line> <marker> [mode] [validator ...]
#     ONE line added to a config that is edited in place (/etc/modprobe.d,
#     /etc/udev/rules.d, /etc/sudoers.d). The file is never truncated:
#       absent                 → created holding the line (mode, default 644).
#       present, no <marker>   → the line is APPENDED; existing bytes preserved.
#       present, has <marker>  → nothing written (re-runs are no-ops).
#     `validator ...` is a command run against the MERGED file before install
#     (e.g. `visudo -c -f`); a non-zero exit installs nothing.
#     Outcome in $TINSHELL_DEPLOY_OUTCOME: created | appended | already-set | failed.
#
# Environment — read when this file is sourced, so set it BEFORE the `.` line:
#   TINSHELL_DEPLOY_SUDO    privilege prefix for the writes, default "sudo";
#                      TINSHELL_DEPLOY_SUDO="" for a destination the caller owns.
#   TINSHELL_DEPLOY_FORCE   "1" = deploy_seed_config overwrites an existing live
#                      config (the explicit reset).
set -euo pipefail

DEPLOY_SUDO=()
if [ -n "${TINSHELL_DEPLOY_SUDO-sudo}" ]; then
  read -r -a DEPLOY_SUDO <<<"${TINSHELL_DEPLOY_SUDO-sudo}"
fi

# md5 of a destination, or "-" when it cannot be read.
deploy_md5() {
  "${DEPLOY_SUDO[@]}" md5sum -- "$1" 2>/dev/null | cut -d' ' -f1 || true
}

# Seed a LIVE config from the shipped defaults file. See the header.
deploy_seed_config() {
  local src="$1" dst="$2" before
  if [ ! -f "$src" ]; then
    echo "[deploy] ERROR: shipped source missing: $src — nothing installed" >&2
    return 1
  fi
  if [ ! -e "$dst" ]; then
    "${DEPLOY_SUDO[@]}" install -Dm644 "$src" "$dst" || return 1
    echo "[deploy] seeded $dst from $src (was absent)"
    return 0
  fi
  if "${DEPLOY_SUDO[@]}" cmp -s "$src" "$dst"; then
    echo "[deploy] $dst already matches $src — unchanged"
    return 0
  fi
  if [ "${TINSHELL_DEPLOY_FORCE:-}" = "1" ]; then
    before="$(deploy_md5 "$dst")"
    "${DEPLOY_SUDO[@]}" install -Dm644 "$src" "$dst" || return 1
    echo "[deploy] OVERWROTE $dst with $src — previous contents (md5 ${before:-unreadable}) DESTROYED (TINSHELL_DEPLOY_FORCE=1)"
    return 0
  fi
  echo "[deploy] PRESERVED $dst — it differs from $src and a deploy never reverts a live config"
  echo "[deploy]   to overwrite it with the shipped defaults and DISCARD its current contents: re-run the deploy with --force (TINSHELL_DEPLOY_FORCE=1)"
  return 0
}

# Install a config a daemon reads directly (no defaults/merge channel). See the
# header.
deploy_payload_config() {
  local src="$1" dst="$2" before
  if [ ! -f "$src" ]; then
    echo "[deploy] ERROR: shipped source missing: $src — nothing installed" >&2
    return 1
  fi
  if [ ! -e "$dst" ]; then
    "${DEPLOY_SUDO[@]}" install -Dm644 "$src" "$dst" || return 1
    echo "[deploy] installed $dst from $src (was absent)"
    return 0
  fi
  before="$(deploy_md5 "$dst")"
  "${DEPLOY_SUDO[@]}" install -Dm644 "$src" "$dst" || return 1
  echo "[deploy] re-deployed $dst from $src — payload file (no defaults channel), superseded md5 ${before:-unreadable}"
}

# Add one line to a config edited in place, never truncating it. See the header.
deploy_config_line() {
  local file="$1" line="$2" marker="$3" mode="${4:-644}" tmp
  local -a validator=()
  if [ "$#" -gt 4 ]; then validator=("${@:5}"); fi

  TINSHELL_DEPLOY_OUTCOME=""
  if [ -f "$file" ] && "${DEPLOY_SUDO[@]}" grep -q -e "$marker" "$file"; then
    TINSHELL_DEPLOY_OUTCOME="already-set"
    echo "[deploy] $file already carries \"$marker\" — unchanged"
    return 0
  fi

  tmp="$(mktemp)" || return 1
  if [ -e "$file" ]; then
    if ! "${DEPLOY_SUDO[@]}" cp -- "$file" "$tmp" || ! printf '%s\n' "$line" >>"$tmp"; then
      rm -f "$tmp"
      TINSHELL_DEPLOY_OUTCOME="failed"
      echo "[deploy] ERROR: could not build the merged contents of $file — NOT installed" >&2
      return 1
    fi
    TINSHELL_DEPLOY_OUTCOME="appended"
  else
    if ! printf '%s\n' "$line" >"$tmp"; then
      rm -f "$tmp"
      TINSHELL_DEPLOY_OUTCOME="failed"
      echo "[deploy] ERROR: could not write the new $file contents — NOT installed" >&2
      return 1
    fi
    TINSHELL_DEPLOY_OUTCOME="created"
  fi

  if [ "${#validator[@]}" -gt 0 ]; then
    local verdict=""
    if ! verdict="$("${DEPLOY_SUDO[@]}" "${validator[@]}" "$tmp" 2>&1)"; then
      rm -f "$tmp"
      TINSHELL_DEPLOY_OUTCOME="failed"
      echo "[deploy] ERROR: ${validator[0]} rejected the merged $file — NOT installed" >&2
      if [ -n "$verdict" ]; then echo "[deploy]   ${validator[0]}: $verdict" >&2; fi
      return 1
    fi
  fi

  if ! "${DEPLOY_SUDO[@]}" install -Dm"$mode" "$tmp" "$file"; then
    rm -f "$tmp"
    TINSHELL_DEPLOY_OUTCOME="failed"
    echo "[deploy] ERROR: could not install $file" >&2
    return 1
  fi
  rm -f "$tmp"
  case "$TINSHELL_DEPLOY_OUTCOME" in
    created) echo "[deploy] created $file with \"$line\"" ;;
    appended) echo "[deploy] appended to $file (existing contents preserved): $line" ;;
  esac
  return 0
}
