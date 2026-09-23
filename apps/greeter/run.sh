#!/usr/bin/env bash
# Dev shim — same 1-line pattern as every app (root AGENTS.md: launch path).
# PRODUCTION launch is NOT via run.sh: greetd boots the deployed bundle
# (build.sh + install.sh → /etc/greetd/ags-greeter.sh) pre-login as the
# `greeter` user. run.sh is dev-only (preview/testing in the live session).
exec "$(dirname "$0")/../../common/shell/run.sh" greeter
