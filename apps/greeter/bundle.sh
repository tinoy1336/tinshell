#!/usr/bin/env bash
# apps/greeter/bundle.sh — the body shared by build.sh and build-lock.sh.
#
# Sourced, never executed on its own. Both greeter bundles are ONE source
# (apps/greeter/app.ts) with two destinations, so the build has to be ONE
# implementation: the bundle guard every other build path runs
# (common/shell/bundle-guard.sh), the same per-app JS-outfile patch
# common/shell/run.sh applies, the same source fingerprint and stamp (ONE
# captured input list feeding both the injected fingerprint and the sidecar's
# `sources`), the same GPU-wake pins, and the same atomic replace of the output.
#
# WHY THE WRAPPER IS REPLACED ATOMICALLY: greetd and hypridle exec these
# bundles directly — the lock bundle is exec'd from dist/ by hypridle's
# lock_cmd — so the built file is a live dependency, never just an artifact.

# shellcheck source=common/shell/bundle-guard.sh
. "$GREETER_ROOT/common/shell/bundle-guard.sh"
# shellcheck source=common/shell/bundle-stamp.sh
. "$GREETER_ROOT/common/shell/bundle-stamp.sh"

# greeter_build <artifact> <output> <js-name> [--force]
greeter_build() {
  local artifact="$1" out="$2" jsname="$3"
  shift 3
  local force=0 arg
  for arg in "$@"; do
    case "$arg" in
      --force) force=1 ;;
      -h | --help)
        echo "usage: $0 [--force]"
        echo "  --force  rebuild even when the sources are unchanged"
        return 0
        ;;
      *)
        echo "$0: unknown argument '$arg' (only --force)" >&2
        return 1
        ;;
    esac
  done
  [ "${TINSHELL_BUNDLE_FORCE:-0}" = "1" ] && force=1

  mkdir -p "$(dirname "$out")"
  local stamp="$out.stamp.json" entry="$GREETER_ROOT/apps/greeter/app.ts"
  mapfile -t dirs < <(bundle_source_dirs "$GREETER_ROOT" "greeter")

  # Unchanged sources AND an untouched payload = the existing bundle still IS
  # this build's result. Verified, not assumed: the payload's own hash has to
  # match the stamp, so a bundle that was copied over after the build rebuilds.
  if [ "$force" != 1 ] &&
    bundle_stamp_verify "$artifact" "$stamp" "$out" "${dirs[@]}" 2>/dev/null; then
    echo "up to date: $out"
    return 0
  fi

  local log rc=0 tmp
  # The input list is captured ONCE, before the bundle is produced: its hash is
  # the fingerprint injected into the wrapper and the SAME captured list is what
  # the sidecar records, so the artifact's identity and the evidence a stale
  # verdict names come from one derivation at one instant.
  local inputs fp
  inputs="$(mktemp "${TMPDIR:-/tmp}/greeter-inputs.XXXXXX")"
  bundle_inputs_capture "$inputs" "${dirs[@]}"
  log="$(mktemp "${TMPDIR:-/tmp}/greeter-bundle-log.XXXXXX")"
  tmp="$out.tmp.$$"
  bundle_guard_sources "$artifact" "${dirs[@]}" || rc=3
  if [ "$rc" -eq 0 ]; then
    # ags bundle resolves tsconfig path aliases (@common/*) from the CWD, and
    # the repo tsconfig lives at the home root — bundle from there, never from
    # this dir.
    if ! (cd "$GREETER_ROOT" && /usr/bin/ags bundle --gtk 4 "$entry" "$tmp") >"$log" 2>&1; then
      rc=3
      [ -s "$log" ] && cat "$log" >&2
    elif ! bundle_guard_diagnostics "$artifact" "$log"; then
      rc=3
    fi
  fi
  rm -f "$log"
  if [ "$rc" -ne 0 ]; then
    rm -f "$tmp" "$inputs"
    return "$rc"
  fi

  # PATCH the internal JS outfile per-app (same sed as common/shell/run.sh):
  # the hash-based default collides across bundles.
  sed -i "1,/^file=/ s|^file=.*|file=\"\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}/$jsname\"|" "$tmp"
  # GPU-WAKE PINS: greetd/hypridle exec these bundles directly, never through
  # common/shell/tinshell-host.sh, so they do not inherit the session env union's
  # pins — and without them GTK's startup enumerates the NVIDIA EGL and Vulkan
  # vendor stacks, opens /dev/nvidia*, and holds the dGPU runtime-active for
  # its autosuspend window (~20s) on a screen that has no GPU work. The pinned
  # set is tinshell-host.sh's: Mesa's EGL vendor + the Radeon ICD only.
  sed -i "/^file=/a\\
export __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json\\
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/radeon_icd.json\\
export GSK_RENDERER=gl" "$tmp"
  fp="$(bundle_inputs_fingerprint "$inputs")"
  bundle_stamp_inject "$tmp" "$artifact" "$fp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$out"
  bundle_stamp_record "$artifact" "$out" "$stamp" "$inputs"
  rm -f "$inputs"
  echo "built: $out (sources ${fp:0:12})"
}
