#!/usr/bin/env bash
# install.sh — ROOT deploy script. Run via sudo_approve (never raw sudo).
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
      echo "  --force     re-seed /etc/greetd/ags-greeter/config.json from config.defaults.json, destroying its current contents"
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

install -Dm755 dist/greeter-tinshell.sh /etc/greetd/ags-greeter.sh
install -Dm644 dist/greeter-tinshell.sh.stamp.json /etc/greetd/ags-greeter.sh.stamp.json
deploy_seed_config config.defaults.json /etc/greetd/ags-greeter/config.json
install -Dm644 config.defaults.json /etc/greetd/ags-greeter/config.defaults.json
install -Dm644 config.schema.json /etc/greetd/ags-greeter/config.schema.json
# The applet strip mounts the SHARED renderer (common/applets/surface) with the
# DOCK's config: the greeter user cannot read tinoy's home, so the dock config
# trio ships here too (apps/greeter/config.ts dockConfigView). schema + defaults
# let the shared loader serve the dock's canonical values; the LIVE values are a
# separate root copy (data in tinoy's home) — run it when the dock config
# changes:
#   sudo install -Dm644 ~/dev/tinshell/apps/dock/config.json \
#     /etc/greetd/ags-greeter/dock/config.json
# That copy stays a plain install (no seed guard): its SOURCE is the live dock
# config itself, so it is a refresh of a mirror and cannot revert a setting.
install -Dm644 ../dock/config.schema.json /etc/greetd/ags-greeter/dock/config.schema.json
install -Dm644 ../dock/config.defaults.json /etc/greetd/ags-greeter/dock/config.defaults.json
# the dock's LIVE values now live OUTSIDE the tree (~/.config/tinshell/dock.json), so the
# greeter's dock view pairs the deployed schema/defaults with that flat file; ship the
# deployed copy too when it is readable (root deploy, data in the user's home)
if [ -r "$HOME/.config/tinshell/dock.json" ]; then
  install -Dm644 "$HOME/.config/tinshell/dock.json" /etc/greetd/ags-greeter/dock/config.json
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
  chown -R greeter:greeter /etc/greetd/ags-greeter.sh /etc/greetd/ags-greeter
fi

echo "greeter deployed:"
echo "  /etc/greetd/ags-greeter.sh          (the bundle, runs as user greeter)"
echo "  /etc/greetd/ags-greeter.sh.stamp.json (the sources it was built from — \`npm run check:builds\` reads it)"
echo "  /etc/greetd/ags-greeter/config*.json"
echo "  /etc/greetd/ags-greeter/dock/       (the dock config the applet strip renders)"
echo "  /etc/greetd/config.toml             (greetd → greeter compositor)"
echo "  /etc/greetd/greeter.lua             (greeter compositor config)"
echo "  /etc/greetd/greeter-handoff.sh      (login handoff: freezes the last frame)"
echo "  /etc/pam.d/greetd                   (+ gnome-keyring unlock)"
echo "(config.json is seeded only when absent and otherwise preserved; --force re-seeds it)"
