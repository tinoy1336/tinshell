#!/usr/bin/env bash
# Forward extra args (run.sh notes open foo → shared run.sh → app main(argv)).
exec "$(dirname "$0")/../../common/shell/run.sh" notes "$@"
