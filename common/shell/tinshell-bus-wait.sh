#!/usr/bin/env bash
# tinshell-bus-wait.sh — wait for an Astal bus name to be FREE before starting an
# TINSHELL app (ExecStartPre of its systemd unit). Each app passes ITS OWN name:
#   tinshell-bus-wait.sh shell    (tinshell-shell.service — the merged shell)
#   tinshell-bus-wait.sh promptd  (tinshell-promptd.service)
# The name arg is REQUIRED — no default, so a unit that forgets it fails the
# start loudly instead of waiting on the wrong bus.
#
# Why: on `systemctl restart <app>` the Go wrapper exits promptly on SIGTERM,
# but its gjs child can linger ~2s holding the bus name. Starting the new
# instance then races the name release: the common outcome is the
# register-race death ("Failed to register: ...NoReply: Remote peer
# disconnected", exit 1, ~9s downtime per restart), and when any stray
# instance owns the bus the new `ags run` degrades to a clean-exit probe
# (prints "available commands: ...", exits 0) — which a Restart=always unit
# resurrects every RestartSec (114 cycles in 10 min).
#
# This wait makes the handover atomic: the new instance only starts once the
# name is released (normal case: instant; restart case: ~2s). A name still
# held after the timeout means a STRAY instance owns this app's bus — fail
# loudly instead of starting a death loop. Combined with Restart=on-failure
# (a clean exit 0 is never resurrected), both race faces are closed.
[ $# -ge 1 ] || {
      echo "tinshell-bus-wait.sh: missing bus name (e.g. 'dock', '<app>'); refusing to start." >&2
      exit 1
}
NAME="io.Astal.$1"
for _ in $(seq 1 150); do
      if ! dbus-send --session --dest=org.freedesktop.DBus --type=method_call \
            --print-reply / org.freedesktop.DBus.NameHasOwner string:"$NAME" \
            2>/dev/null | grep -q "boolean true"; then
            exit 0
      fi
      sleep 0.1
done
echo "$NAME still held after 15s — a stray instance owns this app's bus; refusing to start. Kill it by exact PID (pgrep -a gjs shows the holder) and retry." >&2
exit 1
