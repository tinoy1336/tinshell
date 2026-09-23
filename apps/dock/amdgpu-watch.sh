#!/usr/bin/env bash
# amdgpu-watch.sh — watch the kernel journal for amdgpu ring timeouts / GPU
# resets (the gfx_0.0.0 ring timeout -> failed MES reset -> full GPU reset
# class, which froze the whole session ~5s and crashed
# Hyprland). On detection: append the event to a log AND copy the
# devcoredump before it expires (the kernel's dump at
# /sys/class/drm/card1/device/devcoredump/*/data auto-expires quickly).
# Runs as a systemd user service.
#
# Notes: copying the dump needs read permission on the devcoredump data file
# (may be root-only — the script logs the path regardless). Detection is
# journal-based, so it also catches events that predate the service.
LOG_DIR="$HOME/.local/state"
mkdir -p "$LOG_DIR"
EVENTS="$LOG_DIR/amdgpu-crashes.log"
DUMP_DIR="$LOG_DIR/amdgpu-devcoredumps"
mkdir -p "$DUMP_DIR"

# Backfill any recent events that happened before this service started.
journalctl -k --since "-12 hours" --no-pager 2>/dev/null |
  grep -E "ring gfx.*timeout|GPU reset begin" | while read -r line; do
  echo "backfill: $line" >>"$EVENTS"
done

journalctl -k -f -o cat 2>/dev/null | while read -r line; do
  if echo "$line" | grep -qE "ring gfx.*timeout|GPU reset begin|MES failed"; then
    ts=$(date +%Y%m%d-%H%M%S)
    echo "$ts: $line" >>"$EVENTS"
    for d in /sys/class/drm/card1/device/devcoredump/*/; do
      [ -d "$d" ] || continue
      if [ -r "$d/data" ]; then
        cp "$d/data" "$DUMP_DIR/devcoredump-$ts.bin" 2>/dev/null &&
          echo "$ts: copied devcoredump to $DUMP_DIR/devcoredump-$ts.bin" >>"$EVENTS"
      else
        echo "$ts: devcoredump exists but unreadable (root needed): $d/data" >>"$EVENTS"
      fi
    done
  fi
done
