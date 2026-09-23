#!/usr/bin/env bash
# annotate/run.sh — 1-line shim to the shared bundler (forwards argv).
exec "$(dirname "$0")/../../common/shell/run.sh" annotate "$@"
