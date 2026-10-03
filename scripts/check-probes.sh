#!/usr/bin/env bash
# Run every probe that is deterministic and self-contained.
#
# The failure this script exists for: the tree carries check surfaces beside its
# modules (`*.probe.ts`) and nothing invoked them on a push. `biome`, `tsc` and
# the generator gates all pass while a decision inside a module drifts, because
# those decisions live in pure functions and recorders no other gate reads — a
# member table that stops resolving a shorthand, a tilde form that stops
# expanding, a glob whose cap moves, an envelope kind the parser drops. Each
# probe fails on its own; this is what makes that failure reach a merge.
#
# Shape: one `timeout` per probe, the probe's own output streamed, and any
# failure counted and reported at the end. A probe that exits non-zero fails the
# run; there is no partial credit and no retry. A probe that exits 124/137 is
# reported as a TIMEOUT row rather than as a defect in the module.
#
# Every probe runs with its own scratch XDG tree and `TINSHELL_HOME` at the
# repository root, so no probe reads or writes the running session's state, the
# user's config, or the runtime directory; the scratch tree is removed on exit.
#
# Two shapes, because the modules differ: `*.probe.ts` beside a gi-free module
# runs under plain node (`node --experimental-strip-types`), while a probe whose
# module imports `gi://` or `ags/*` is built with the repository's own bundler
# and the wrapper run under gjs. Bundling is a build, never a launch.
#
# NOT RUN HERE, each with what it needs (a probe for one of these would have to
# be skipped here as well, so it is named rather than silently absent):
#   apps/annotate/window.probe.ts                      opens editor windows
#   apps/greeter/dev/backend.probe.ts                  the greetd session + display
#   apps/greeter/dev/lock-surface.probe.ts             the lock surface (compositor)
#   common/applets/backend-client.probe.ts             a LIVE applets instance
#   common/applets/battery/plugged-since-store.probe.ts  the live applet store
#   common/applets/battery/threshold-store.probe.ts    the live applet store
#   common/applets/wifi/menu.probe.ts                  nmcli + the menu window
#   common/applets/domains/volume.probe.ts             a session default sink
#   common/applets/host/socket-server.ts               NO PROBE EXISTS: its read
#                                                      loop resumes through a
#                                                      promise, and outside the
#                                                      AGS runtime the module
#                                                      graph stops promise
#                                                      continuations draining
#                                                      (see the host spec)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOUND="${PROBE_TIMEOUT:-120}"

abort() {
  printf 'PROBE RUNNER PRECONDITION FAILURE: %s\n' "$1" >&2
  exit 2
}

command -v node >/dev/null 2>&1 ||
  abort "node is not on PATH; the probes need node --experimental-strip-types (node >= 22.6)."
command -v timeout >/dev/null 2>&1 || abort "timeout is not on PATH (coreutils)."
command -v ags >/dev/null 2>&1 || abort "ags is not on PATH; the bundled probes build through it."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 6) ? 0 : 1)' ||
  abort "node $(node -v) is too old for --experimental-strip-types (needs node >= 22.6)."

# Probes whose module is gi-free: plain node, no build step.
PLAIN=(
  common/text.probe.ts
  common/colour.probe.ts
  common/media/classify.probe.ts
  common/hyprland/lua-string.probe.ts
  common/emoji/insert-plan.probe.ts
  common/host/registry-exports.probe.ts
  common/applets/battery/low-warning.probe.ts
  common/local-index/local-index.probe.mjs
  apps/launcher/sources/bang-token.probe.ts
  apps/launcher/sources/exec-fields.probe.ts
  apps/launcher/sources/text-tools.probe.ts
  apps/notes/history.probe.mjs
)

# Probes whose module imports gi:// or ags/*: built with the repository bundler.
BUNDLED=(
  common/applets/socket-protocol.probe.ts
  common/applets/backend-protocol.probe.ts
  common/applets/host/transport.probe.ts
  common/path/complete.probe.ts
  common/config/loader.probe.ts
  common/applets/shared/value-tick.probe.ts
  common/applets/utils/row-region.probe.ts
  common/applets/battery/charge-counter.probe.ts
  common/applets/domains/brightness.probe.ts
  common/host/build-stamp.probe.ts
  common/media/divider.probe.ts
  common/scroll.probe.ts
  apps/clipboard/style.probe.ts
  apps/clipboard/store.probe.ts
  apps/clipboard/commands.probe.ts
  apps/clipboard/preview.probe.ts
  apps/dock/Overflow.probe.ts
  apps/files/navigate-path.probe.ts
  apps/launcher/sources/units.probe.ts
  apps/launcher/combiner.probe.ts
  apps/launcher/emoji.probe.ts
  apps/launcher/sources/bang-preview.probe.ts
  apps/media/zoom.probe.ts
  apps/notes/history-store.probe.ts
)

scratch="$(mktemp -d "${TMPDIR:-/tmp}/tinshell-probes.XXXXXX")"
cleanup() { rm -rf "${scratch}"; }
trap cleanup EXIT INT TERM

export TINSHELL_HOME="${ROOT}"
export XDG_CONFIG_HOME="${scratch}/config"
export XDG_STATE_HOME="${scratch}/state"
export XDG_DATA_HOME="${scratch}/data"
export XDG_CACHE_HOME="${scratch}/cache"
mkdir -p "${XDG_CONFIG_HOME}" "${XDG_STATE_HOME}" "${XDG_DATA_HOME}" "${XDG_CACHE_HOME}"

failed=0
ran=0

for probe in "${PLAIN[@]}"; do
  [ -f "${ROOT}/${probe}" ] || abort "missing probe ${probe} — the list and the tree disagree."
  printf '\n==== %s\n' "${probe}"
  ran=$((ran + 1))
  timeout "${BOUND}" node --experimental-strip-types "${ROOT}/${probe}"
  status=$?
  if [ "${status}" -eq 124 ] || [ "${status}" -eq 137 ]; then
    printf 'PROBE TIMED OUT after %ss: %s\n' "${BOUND}" "${probe}" >&2
    failed=$((failed + 1))
  elif [ "${status}" -ne 0 ]; then
    printf 'PROBE FAILED (exit %s): %s\n' "${status}" "${probe}" >&2
    failed=$((failed + 1))
  fi
done

for probe in "${BUNDLED[@]}"; do
  [ -f "${ROOT}/${probe}" ] || abort "missing probe ${probe} — the list and the tree disagree."
  printf '\n==== %s (bundled)\n' "${probe}"
  ran=$((ran + 1))
  wrapper="${scratch}/$(printf '%s' "${probe}" | tr '/' '_').sh"
  timeout "${BOUND}" ags bundle --gtk 4 "${ROOT}/${probe}" "${wrapper}" >/dev/null 2>&1
  if [ $? -ne 0 ]; then
    printf 'PROBE BUILD FAILED: %s\n' "${probe}" >&2
    failed=$((failed + 1))
    continue
  fi
  timeout "${BOUND}" bash "${wrapper}"
  status=$?
  if [ "${status}" -eq 124 ] || [ "${status}" -eq 137 ]; then
    printf 'PROBE TIMED OUT after %ss: %s\n' "${BOUND}" "${probe}" >&2
    failed=$((failed + 1))
  elif [ "${status}" -ne 0 ]; then
    printf 'PROBE FAILED (exit %s): %s\n' "${status}" "${probe}" >&2
    failed=$((failed + 1))
  fi
done

printf '\n'
if [ "${failed}" -gt 0 ]; then
  printf 'PROBE RUN FAILURE: %s of %s probes failed\n' "${failed}" "${ran}" >&2
  exit 1
fi
printf 'ALL %s PROBES PASSED\n' "${ran}"
