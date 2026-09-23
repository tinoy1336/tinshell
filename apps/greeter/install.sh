#!/usr/bin/env bash
# install.sh — ROOT deploy script. Run with sudo, never automatically.
#
# Deploys the built bundle + config store + templates into /etc/greetd/.
# Idempotent; re-run after rebuilds. The DM switch (enable greetd / disable
# plasmalogin) is NOT part of this script — that happens from a spare TTY
# or via setup.sh's greeter block on a fresh machine.
#
# Usage: ./install.sh [--force] [--no-build]
#
# The bundle is a SNAPSHOT: it inlines apps/greeter/ + common/ at build time.
# This script therefore REBUILDS it (./build.sh, a no-op while the sources are
# unchanged), VERIFIES the built payload against the sources it was built from
# (common/shell/bundle-stamp.sh) and REFUSES — before anything under
# /etc/greetd/ is touched — when the payload in dist/ does not match those
# sources. The build is unprivileged and does not escalate; the deploy is the
# only root step, and it is this one command.
#
# Config safety (common/shell/deploy-config.sh) — three destination classes:
#   config.json                       SEED: installed when absent, PRESERVED
#                                     when it exists (the loader merges
#                                     config.defaults.json UNDER the live file,
#                                     so overwriting it buys nothing).
#                                     --force discards it and re-seeds.
#   config.defaults.json,             SEED MIRRORS: always installed — they are
#   config.schema.json, dock trio     the seed the live file merges over.
#   config.toml, greeter.lua,         PAYLOAD: greetd, the greeter compositor
#   pam.d/greetd                      and PAM read these directly and have no
#                                     defaults channel, so the shipped file is
#                                     the only route a repo change has to this
#                                     machine: always installed, and the line
#                                     names the md5 it superseded.
set -euo pipefail
cd "$(dirname "$0")"

FORCE=0
NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --no-build) NO_BUILD=1 ;;
    -h | --help)
      echo "usage: install.sh [--force] [--no-build]"
      echo "  --force     re-seed /etc/greetd/tinshell-greeter/config.json from config.defaults.json, destroying its current contents"
      echo "  --no-build  deploy the bundle already in dist/ instead of rebuilding it (it is STILL refused when its stamp does not match the sources)"
      exit 0
      ;;
    *)
      echo "error: unknown argument '$arg' (only --force, --no-build)" >&2
      exit 1
      ;;
  esac
done
if [ "$FORCE" = 1 ]; then export TINSHELL_DEPLOY_FORCE=1; fi

TINSHELL_HOME="$(cd ../.. && pwd)"
. "$TINSHELL_HOME/common/shell/deploy-config.sh"
# shellcheck source=common/shell/bundle-stamp.sh
. "$TINSHELL_HOME/common/shell/bundle-stamp.sh"

# ── build + freshness gate ────────────────────────────────────────────
if [ "$NO_BUILD" = 1 ]; then
  echo "[deploy] --no-build: using the bundle already in dist/"
else
  ./build.sh
fi

[ -f dist/greeter-tinshell.sh ] || {
  echo "error: dist/greeter-tinshell.sh missing — run ./build.sh first" >&2
  exit 1
}
mapfile -t GREETER_DIRS < <(bundle_source_dirs "$TINSHELL_HOME" "greeter")
if ! bundle_stamp_verify greeter "$(pwd)/dist/greeter-tinshell.sh.stamp.json" \
  "$(pwd)/dist/greeter-tinshell.sh" "${GREETER_DIRS[@]}"; then
  echo "[deploy] REFUSED — the payload would not be the sources it claims; nothing installed under /etc/greetd/" >&2
  exit 3
fi

install -Dm755 dist/greeter-tinshell.sh /etc/greetd/tinshell-greeter.sh
install -Dm644 dist/greeter-tinshell.sh.stamp.json /etc/greetd/tinshell-greeter.sh.stamp.json
deploy_seed_config config.defaults.json /etc/greetd/tinshell-greeter/config.json
install -Dm644 config.defaults.json /etc/greetd/tinshell-greeter/config.defaults.json
install -Dm644 config.schema.json /etc/greetd/tinshell-greeter/config.schema.json
# The applet strip mounts the SHARED renderer (common/applets/surface) with the
# DOCK's config: the greeter user cannot read the session user's home, so the dock config
# trio ships here too (apps/greeter/config.ts dockConfigView). schema + defaults
# let the shared loader serve the dock's canonical values; the deployed
# config.json is a MIRROR of the dock's LIVE file — a plain install, no seed
# guard, because its SOURCE is the live config itself, so refreshing it cannot
# revert a setting.
install -Dm644 ../dock/config.schema.json /etc/greetd/tinshell-greeter/dock/config.schema.json
install -Dm644 ../dock/config.defaults.json /etc/greetd/tinshell-greeter/dock/config.defaults.json
# The live dock config sits OUTSIDE the tree (<config dir>/tinshell/dock.json,
# common/config/loader appConfigPath). Resolve it EXPLICITLY: TINSHELL_DOCK_CONFIG
# names it, else the INVOKING user's home does (SUDO_USER). Never $HOME — under
# sudo that is /root, where the readability test fails, the copy is skipped in
# silence and the deploy still reports success while shipping the previous
# mirror. An unreadable source is NAMED (here and in the summary below), never
# silently skipped.
DOCK_LIVE="${TINSHELL_DOCK_CONFIG:-}"
if [ -z "$DOCK_LIVE" ]; then
  DOCK_LIVE="$(getent passwd "${SUDO_USER:-$(id -un)}" 2>/dev/null | cut -d: -f6 || true)/.config/tinshell/dock.json"
fi
if [ -r "$DOCK_LIVE" ]; then
  install -Dm644 "$DOCK_LIVE" /etc/greetd/tinshell-greeter/dock/config.json
  DOCK_MIRROR="refreshed from $DOCK_LIVE"
else
  DOCK_MIRROR="kept as deployed: the live dock config is unreadable at ${DOCK_LIVE:-<unresolved>} (name it with TINSHELL_DOCK_CONFIG)"
  echo "[deploy] WARNING: dock config mirror NOT refreshed — $DOCK_MIRROR" >&2
fi
# The three PAYLOAD configs (see the header): always installed, each one naming
# the md5 it superseded.
deploy_payload_config templates/greetd.config.toml /etc/greetd/config.toml
deploy_payload_config templates/greeter.lua /etc/greetd/greeter.lua
# Handoff script: SIGKILLs the greeter compositor tree on login so the last
# rendered frame freezes until the user session paints over it (spawned by
# the app, runs as user greeter). Code, not config — always deployed.
install -Dm755 templates/greeter-handoff.sh /etc/greetd/greeter-handoff.sh
# PAM: package default + gnome-keyring unlock — deployed explicitly because it
# diverges from the package default.
deploy_payload_config templates/pam.d.greetd /etc/pam.d/greetd

# The greeter user (created by greetd's sysusers.d/greetd.conf) needs read
# access to the bundle + config. Root-owned 755/644 would suffice; chown for
# clarity and future edits.
if id greeter >/dev/null 2>&1; then
  chown -R greeter:greeter /etc/greetd/tinshell-greeter.sh /etc/greetd/tinshell-greeter
fi

echo "greeter deployed:"
echo "  /etc/greetd/tinshell-greeter.sh          (the bundle, runs as user greeter)"
echo "  /etc/greetd/tinshell-greeter.sh.stamp.json (the sources it was built from — \`npm run check:builds\` reads it)"
echo "  /etc/greetd/tinshell-greeter/config*.json"
echo "  /etc/greetd/tinshell-greeter/dock/       (the dock config the applet strip renders — mirror $DOCK_MIRROR)"
echo "  /etc/greetd/config.toml             (greetd → greeter compositor)"
echo "  /etc/greetd/greeter.lua             (greeter compositor config)"
echo "  /etc/greetd/greeter-handoff.sh      (login handoff: freezes the last frame)"
echo "  /etc/pam.d/greetd                   (+ gnome-keyring unlock)"
echo "(config.json is seeded only when absent and otherwise preserved; --force re-seeds it)"
