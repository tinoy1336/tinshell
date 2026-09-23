#!/usr/bin/env bash
# build.sh — tinoy-side build → ./dist/greeter-tinshell.sh (self-contained bundle
# for the greetd login screen).
#
# The build body (guard + esbuild + outfile patch + GPU pins + stamp) is
# apps/greeter/bundle.sh, shared with build-lock.sh: both bundles are ONE
# source, so they cannot drift apart. Sources unchanged since the last build
# makes this a no-op (--force rebuilds regardless).
#
# The bundle inlines everything incl. common/*, so it runs standalone as the
# `greeter` user with no repo access. Deploying it is separate and runs as
# root: ./install.sh (which rebuilds and then refuses a payload whose stamp
# does not match the sources it was built from).
set -euo pipefail
cd "$(dirname "$0")"
GREETER_ROOT="$(cd ../.. && pwd)"
# shellcheck source=apps/greeter/bundle.sh
. ./bundle.sh

greeter_build greeter "$(pwd)/dist/greeter-tinshell.sh" "greeter-tinshell.js" "$@"
