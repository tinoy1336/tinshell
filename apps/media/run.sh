#!/usr/bin/env bash
# Forward extra args (run.sh media open <path> → shared run.sh → app main(argv)).
exec "$(dirname "$0")/../../common/shell/run.sh" media "$@"
