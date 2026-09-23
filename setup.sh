#!/usr/bin/env bash
# setup.sh — bootstrap the TINSHELL multi-app home onto a fresh machine.
#
# Idempotent + re-runnable. Handles: package deps, node_modules symlinks, GI
# type generation, script permissions, systemd units, Hyprland integration
# verification, and the root-requiring hardware steps (input group, modprobe
# option, udev charge-threshold rule). Root steps use sudo inline (the user is
# prompted); each auto-detects current state and skips if already done.
#
# Assumes same hardware (EndeavourOS/Arch, Hyprland, ASUS convertible with AMD
# iGPU + NVIDIA dGPU). Run from anywhere; operates on ~/dev/tinshell.
set -euo pipefail

HOME_DIR="$HOME"
TINSHELL_HOME="$HOME_DIR/dev/tinshell"
SYSTEMD_USER="$HOME_DIR/.config/systemd/user"

# Colours for legible output.
C_DONE=$'\033[32m'
C_SKIP=$'\033[33m'
C_TODO=$'\033[36m'
C_ERR=$'\033[31m'
C_RST=$'\033[0m'
say() { echo "${C_TODO}[setup]${C_RST} $*"; }
done_() { echo "${C_DONE}[setup] done${C_RST}: $*"; }
skip() { echo "${C_SKIP}[setup] skipped${C_RST}: $* (already done)"; }
err() { echo "${C_ERR}[setup] ERROR${C_RST}: $*" >&2; }

# ──────────────────────────── 1. Preflight ────────────────────────────

say "preflight checks"

if [ ! -f /etc/os-release ]; then
  err "not a Linux system with /etc/os-release — this setup targets Arch/EndeavourOS"
  exit 1
fi
if ! grep -qiE 'arch|endeavour' /etc/os-release; then
  err "this setup targets Arch/EndeavourOS (pacman). Found: $(grep PRETTY_NAME /etc/os-release)"
  exit 1
fi

if [ ! -d "$TINSHELL_HOME/common" ]; then
  err "TINSHELL home not found at $TINSHELL_HOME (expected the repo with apps/ + common/)."
  err "Clone/copy the repo to $TINSHELL_HOME first, then run this script."
  exit 1
fi

cd "$TINSHELL_HOME"
done_ "preflight (Arch/EndeavourOS, TINSHELL home present)"

# Deploy-time config safety (shared with apps' install.sh — see
# common/shell/deploy-config.sh). Every write into a config that is edited in
# place goes through deploy_config_line, which never truncates.
. "$TINSHELL_HOME/common/shell/deploy-config.sh"

# ──────────────────────── 2. System packages ─────────────────────────

say "checking system package dependencies"

# Official Arch repo packages. Each skipped if already installed.
OFFICIAL=(
  gjs glib2 gtk4-layer-shell
  hyprland hypridle hyprlock
  networkmanager bluez bluez-utils upower wireplumber pipewire
  playerctl grim slurp wf-recorder libnotify libqalculate
  python firefox chromium kitty brightnessctl wl-clipboard xdg-utils
  dbus mesa libva vulkan-radeon nvidia-utils nvidia-open nvidia-prime
  systemd tlp jq
)

missing_official=()
for pkg in "${OFFICIAL[@]}"; do
  if pacman -Q "$pkg" >/dev/null 2>&1; then :; else missing_official+=("$pkg"); fi
done

if [ ${#missing_official[@]} -gt 0 ]; then
  say "installing ${#missing_official[@]} official packages: ${missing_official[*]}"
  sudo pacman -S --needed --noconfirm "${missing_official[@]}"
  done_ "official packages installed"
else
  skip "official packages (all present)"
fi

# AUR packages. aylurs-gtk-shell provides `ags` (the official `ags` is older).
# libastal-* provide the Astal typelibs. Detected via pacman -Q; if missing,
# try an AUR helper (yay/paru), else print manual instructions.
AUR=(aylurs-gtk-shell libastal-git libastal-4-git libastal-io-git ttf-jetbrains-mono-nerd hyprshutdown)

missing_aur=()
for pkg in "${AUR[@]}"; do
  if pacman -Q "$pkg" >/dev/null 2>&1; then :; else missing_aur+=("$pkg"); fi
done

if [ ${#missing_aur[@]} -gt 0 ]; then
  AUR_HELPER=""
  for h in yay paru; do command -v "$h" >/dev/null 2>&1 && AUR_HELPER="$h" && break; done
  if [ -n "$AUR_HELPER" ]; then
    say "installing ${#missing_aur[@]} AUR packages via $AUR_HELPER: ${missing_aur[*]}"
    $AUR_HELPER -S --needed --noconfirm "${missing_aur[@]}" || {
      err "AUR install via $AUR_HELPER failed for some packages. Install manually:"
      err "  $AUR_HELPER -S ${missing_aur[*]}"
    }
    done_ "AUR packages installed"
  else
    err "AUR packages need manual install (no yay/paru found):"
    err "  ${missing_aur[*]}"
    err "Install an AUR helper first (yay or paru), then re-run, OR install them manually."
  fi
else
  skip "AUR packages (all present)"
fi

# hyprgrass plugin: built by hyprpm into /var/cache/hyprpm/$USER/hyprgrass/.
# Skip if the .so exists; else print the manual build command (repo URL is
# user-specific).
HYPRGRASS_SO="/var/cache/hyprpm/$USER/hyprgrass/hyprgrass.so"
if [ -f "$HYPRGRASS_SO" ]; then
  skip "hyprgrass plugin (.so present)"
else
  say "hyprgrass plugin not built. Build it with:"
  echo "    sudo hyprpm add https://github.com/horriblename/hyprgrass"
  echo "    sudo hyprpm reload"
  echo "  (then re-run this script to confirm)"
fi

# ─────────────────────── 3. GLib version check ───────────────────────

say "checking GLib >= 2.84 (required for gi://GioUnix)"
GLIB_VER="$(pacman -Q glib2 2>/dev/null | awk '{print $2}' | cut -d- -f1)"
if [ -n "$GLIB_VER" ]; then
  GLIB_MAJOR="$(echo "$GLIB_VER" | cut -d. -f1)"
  GLIB_MINOR="$(echo "$GLIB_VER" | cut -d. -f2)"
  if [ "$GLIB_MAJOR" -gt 2 ] || { [ "$GLIB_MAJOR" -eq 2 ] && [ "$GLIB_MINOR" -ge 84 ]; }; then
    done_ "GLib $GLIB_VER (>= 2.84 — GioUnix available)"
  else
    err "GLib $GLIB_VER < 2.84 — the launcher's gi://GioUnix import will fail. Upgrade glib2."
  fi
else
  err "could not determine GLib version — verify manually (pacman -Q glib2)"
fi

# ───────────────────────── 4. Font check ─────────────────────────────

say "checking JetBrainsMono Nerd Font"
# fc-list depends on the fontconfig cache state (a scan run mid-rebuild can
# come back empty); the package FILES are the ground truth. The
# package itself is installed by the AUR section above (ttf-jetbrains-mono-
# nerd) — a failed check means missing package OR stale cache, and BOTH are
# self-healed here: yay install (no-op when present) + fc-cache -f, then
# re-verify.
font_ok() {
  fc-list 2>/dev/null | grep -qi "JetBrainsMono.*Nerd" ||
    compgen -G "/usr/share/fonts/**/JetBrainsMonoNerdFont-*.ttf" >/dev/null
}
if font_ok; then
  done_ "JetBrainsMono Nerd Font installed"
else
  err "JetBrainsMono Nerd Font check failed — attempting fix (AUR helper + fc-cache)"
  AUR_HELPER=""
  for h in yay paru; do command -v "$h" >/dev/null 2>&1 && AUR_HELPER="$h" && break; done
  if [ -n "$AUR_HELPER" ]; then
    $AUR_HELPER -S --needed --noconfirm ttf-jetbrains-mono-nerd >/dev/null 2>&1 || true
  fi
  fc-cache -f >/dev/null 2>&1 || true
  if font_ok; then
    done_ "JetBrainsMono Nerd Font (fixed via $AUR_HELPER + fc-cache)"
  else
    err "JetBrainsMono Nerd Font still not found — install ttf-jetbrains-mono-nerd manually (AUR)."
    err "Without it, dock icons/launcher glyphs render as boxes."
  fi
fi

# ──────────────────── 5. node_modules symlink ────────────────────────

say "setting up node_modules (links are created AFTER npm install — npm prunes undeclared links and walks inside in-project symlink targets)"
mkdir -p "$TINSHELL_HOME/node_modules"
done_ "root node_modules prepared"

say "npm install (workspaces: apps/* — materializes @apps/* links)"
if npm install --no-audit --no-fund >/dev/null 2>&1; then
  done_ "npm workspace links (@apps/*)"
else
  err "npm install failed — @apps/* links missing (shell bundle needs them); run \`npm install\` manually"
fi
# npm prunes undeclared node_modules entries on every install — re-create the
# manual shims it removed (ags+gnim → /usr/share/ags/js).
ln -sfn /usr/share/ags/js "$TINSHELL_HOME/node_modules/ags"
ln -sfn /usr/share/ags/js/node_modules/gnim "$TINSHELL_HOME/node_modules/gnim"
done_ "node_modules shims re-linked (ags, gnim)"

# ──────────────────────── 6. @girs generation ────────────────────────

if ! command -v ags >/dev/null 2>&1; then
  err "ags binary not found — install aylurs-gtk-shell (AUR) first, then re-run."
  exit 1
fi

say "generating GObject-Introspection type definitions (@girs) at root"
if ags types -d "$TINSHELL_HOME" >/dev/null 2>&1; then
  done_ "@girs generated ($(ls "$TINSHELL_HOME/@girs" 2>/dev/null | wc -l) files)"
else
  err "ags types failed. Check that gobject-introspection + typelibs are installed."
fi

# The type-check program resolves ags/gnim through shim-types/ (declarations
# emitted from the installed shims), so it derives from the same package as
# @girs above and is regenerated at the same point.
say "emitting shim declarations (shim-types) for the type-check program"
if (cd "$TINSHELL_HOME" && npm run gen:shim-types >/dev/null 2>&1); then
  done_ "shim-types generated from the installed ags/gnim shims"
else
  err "shim-types generation failed — run \`npm run gen:shim-types\` manually"
fi

# ────────────────────── 7. chmod +x scripts ──────────────────────────

say "making scripts executable"
chmod +x "$TINSHELL_HOME/common/shell/tinshell-bus-wait.sh" \
  "$TINSHELL_HOME/common/shell/tinshell-route.sh" \
  "$TINSHELL_HOME/common/shell/run.sh" \
  "$TINSHELL_HOME/common/shell/tinshell-host.sh" \
  "$TINSHELL_HOME/common/shell/tinshell-boot.sh" \
  "$TINSHELL_HOME/common/shell/notify-failed.sh" \
  "$TINSHELL_HOME/common/shell/ensure-launcher-toggle.sh" \
  "$TINSHELL_HOME/common/shell/ensure-launcher-emoji.sh" \
  "$TINSHELL_HOME/common/shell/ensure-screengrab.sh" \
  "$TINSHELL_HOME/common/shell/restart-shell.sh" \
  "$TINSHELL_HOME/common/shell/tinshell-mode.sh" \
  "$TINSHELL_HOME/common/shell/new-app.sh" \
  "$TINSHELL_HOME/apps/notes/run.sh" \
  "$TINSHELL_HOME/apps/notes/ensure-open.sh" \
  "$TINSHELL_HOME/apps/notes/ensure-new.sh" \
  "$TINSHELL_HOME/apps/files/run.sh" \
  "$TINSHELL_HOME/apps/files/ensure-open.sh" \
  "$TINSHELL_HOME/apps/media/run.sh" \
  "$TINSHELL_HOME/apps/media/ensure-open.sh" \
  "$TINSHELL_HOME/apps/portal/run.sh" \
  "$TINSHELL_HOME/apps/annotate/run.sh" \
  "$TINSHELL_HOME/apps/annotate/ensure-open.sh" \
  "$TINSHELL_HOME/apps/greeter/run.sh" \
  "$TINSHELL_HOME/apps/greeter/build.sh" \
  "$TINSHELL_HOME/apps/greeter/build-lock.sh" \
  "$TINSHELL_HOME/apps/greeter/install.sh" \
  "$TINSHELL_HOME/apps/greeter/dm-switch.sh" 2>/dev/null || true
[ -f "$TINSHELL_HOME/apps/dock/amdgpu-watch.sh" ] && chmod +x "$TINSHELL_HOME/apps/dock/amdgpu-watch.sh"

# tinshell-mode + tinshell-host → ~/.local/bin (mode switcher + the ONE distributor)
if [ -d "$HOME/.local/bin" ]; then
  ln -sfn "$TINSHELL_HOME/common/shell/tinshell-mode.sh" "$HOME/.local/bin/tinshell-mode"
  done_ "tinshell-mode linked into ~/.local/bin"
  ln -sfn "$TINSHELL_HOME/common/shell/tinshell-host.sh" "$HOME/.local/bin/tinshell-host"
  done_ "tinshell-host linked into ~/.local/bin"
  # The router: every launch hook that is not a shell script (in-process
  # callers) reaches it by ABSOLUTE path — a service process has no
  # ~/.local/bin on PATH.
  ln -sfn "$TINSHELL_HOME/common/shell/tinshell-route.sh" "$HOME/.local/bin/tinshell-route"
  done_ "tinshell-route linked into ~/.local/bin"
else
  skip "~/.local/bin missing — tinshell-mode not linked"
fi
[ -f "$HOME_DIR/.config/hypr/hyprgrass-load.sh" ] && chmod +x "$HOME_DIR/.config/hypr/hyprgrass-load.sh"
done_ "scripts executable"

# ── desktop entries + xdg-open associations ─────────────────────────────────
# Each app that opens files ships an tinshell-<app>.desktop beside its sources; this
# installs them and points the types they declare at them. Without it a fresh
# machine has no TINSHELL entries at all and every file opens in whichever package
# grabbed the association last. Re-runnable: the copies are overwritten.
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$APPS_DIR"
ENTRY_COUNT=0
for entry in "$TINSHELL_HOME"/apps/*/tinshell-*.desktop; do
  [ -f "$entry" ] || continue
  dst="$APPS_DIR/$(basename "$entry")"
  tmp="$dst.tmp"
  # Substitute __HOME__ → real $HOME, same as the systemd unit templates: an
  # entry's Exec must name the home of the machine it is installed on.
  sed "s|__HOME__|$HOME_DIR|g" "$entry" >"$tmp"
  # A token that survives the substitution would exec a path that cannot exist
  # here, so the entry is NOT installed — and never written into place, so no
  # broken entry is left for xdg-open to resolve to.
  if grep -q '__HOME__' "$tmp"; then
    err "$(basename "$entry") still carries __HOME__ after substitution — not installed; check the template"
    rm -f "$tmp"
    continue
  fi
  mv -f "$tmp" "$dst" && ENTRY_COUNT=$((ENTRY_COUNT + 1))
done

# One pass per entry, driven by the entry's OWN MimeType list, so the file and
# the association cannot drift apart.
TYPE_COUNT=0
for entry in "$APPS_DIR"/tinshell-*.desktop; do
  [ -f "$entry" ] || continue
  mime=$(basename "$entry")
  for type in $(grep -m1 '^MimeType=' "$entry" | cut -d= -f2- | tr ';' ' ' | tr -s ' '); do
    xdg-mime default "$mime" "$type" 2>/dev/null && TYPE_COUNT=$((TYPE_COUNT + 1))
  done
done

# VSCode ships claiming only application/x-code-workspace, so it cannot receive
# source or data files at all. Regenerate a user copy with the code types added
# on every run, so a VSCode update cannot leave a stale override behind.
CODE_TYPES='application/x-code-workspace;text/plain;application/json;application/xml;text/xml;application/yaml;text/yaml;application/toml;text/css;text/javascript;text/x-python;text/x-csrc;text/x-chdr;text/x-c++src;text/x-c++hdr;text/x-java;text/x-csharp;text/x-go;text/x-rust;text/x-shellscript;application/x-shellscript;text/x-perl;text/x-ruby;text/x-php;text/x-lua;text/x-tcl;text/x-sql;text/x-makefile;text/x-cmake;text/x-diff;text/x-patch;text/x-log;text/x-tex;text/x-scss;text/x-sass;'
if [ -f /usr/share/applications/code.desktop ]; then
  cp -f /usr/share/applications/code.desktop "$APPS_DIR/code.desktop"
  sed -i "s|^MimeType=application/x-code-workspace;|MimeType=${CODE_TYPES}|" "$APPS_DIR/code.desktop"
fi

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true

# The files app's folder route: `xdg-open` on a directory must land on
# tinshell-files.desktop, whose Exec is apps/files/ensure-open.sh → the shared router
# (tinshell-route.sh), which delivers `files new <dir>`. Asserted by RESULT, not by
# a grep of any script path: the entry's own MimeType line is what the pass
# above installs, and this is what the desktop resolves it to.
if [ "$(xdg-mime query default inode/directory 2>/dev/null)" = "tinshell-files.desktop" ]; then
  done_ "inode/directory → tinshell-files.desktop (xdg-open on a folder reaches files/ensure-open.sh)"
else
  err "inode/directory does not resolve to tinshell-files.desktop — xdg-open on a folder will not reach the files app"
fi
done_ "desktop entries: $ENTRY_COUNT installed, $TYPE_COUNT mime associations set"

# ────────────────────── 8. systemd units ─────────────────────────────

say "installing systemd user units"
mkdir -p "$SYSTEMD_USER"

# Always-install units (boot machinery and the dock's amdgpu-watch)
# + every manifest `unit` entry
# (apps.json is the source of truth — a new app's dev unit can no longer be
# silently missed here).
UNITS="tinshell-shell.service tinshell-islands-fallback.service tinshell-warm.service amdgpu-watch.service $(jq -r '[to_entries[] | select(.key | startswith("$") | not) | select(.value.unit != null) | .value.unit] | .[]' "$TINSHELL_HOME/common/shell/apps.json")"
for unit in $UNITS; do
  SRC="$TINSHELL_HOME/systemd/$unit"
  DST="$SYSTEMD_USER/$unit"
  if [ ! -f "$SRC" ]; then
    err "canonical unit template missing: $SRC"
    continue
  fi
  # Substitute __HOME__ → real $HOME.
  sed "s|__HOME__|$HOME_DIR|g" "$SRC" >"$DST"
  done_ "$unit installed"
done

systemctl --user daemon-reload
# Production = the shell instance + the boot warm. The per-app units
# (promptd/portal/polkit) stay INSTALLED as DEV mode but are
# explicitly NOT enabled; only tinshell-shell.service + tinshell-warm.service are.
systemctl --user enable tinshell-shell.service tinshell-warm.service 2>/dev/null &&
  done_ "units enabled (shell + warm; per-app units are dev-only)" ||
  skip "shell/warm already enabled"
systemctl --user disable tinshell-promptd.service tinshell-portal.service tinshell-polkit.service 2>/dev/null || true

# Remove the dangling pre-multi-app symlink (its target unit doesn't exist).
DANGLING="$SYSTEMD_USER/graphical-session.target.wants/ags.service"
if [ -L "$DANGLING" ] && [ ! -e "$DANGLING" ]; then
  rm -f "$DANGLING"
  done_ "removed dangling ags.service wants symlink"
else
  skip "no dangling ags.service symlink"
fi

# hyprpolkitagent ships a packaged user unit (installed but unwanted): two
# agents must never race the (subject, locale) registration slot — only ONE
# agent per subject+locale; a second registration silently replaces the first.
if systemctl --user is-enabled hyprpolkitagent.service >/dev/null 2>&1; then
  systemctl --user disable hyprpolkitagent.service >/dev/null 2>&1 &&
    done_ "hyprpolkitagent.service disabled (agent slot reserved for tinshell-polkit)" ||
    err "could not disable hyprpolkitagent.service — two polkit agents would race"
else
  skip "hyprpolkitagent.service (not enabled)"
fi

# swaync ships a packaged user unit (installed but unwanted): the notifications
# surface claims org.freedesktop.Notifications and must be the only daemon on
# that name — two daemons mean a client's notification lands on whichever
# claimed the name first.
if systemctl --user is-enabled swaync.service >/dev/null 2>&1; then
  systemctl --user disable swaync.service >/dev/null 2>&1 &&
    done_ "swaync.service disabled (notification slot reserved for the notifications surface)" ||
    err "could not disable swaync.service — two notification daemons would race for org.freedesktop.Notifications"
else
  skip "swaync.service (not enabled)"
fi

# ──────────────── 8b. portal backend (user-local, RESIDENT) ──────────────
# The portal FileChooser backend lives INSIDE the shell instance (resident,
# WantedBy=graphical-session.target) and the shell owns the impl bus name.
# Only the .portal file is installed — there is deliberately NO session-bus
# activation file for the impl name. That activation file was a fallback meant
# to fire only when no host was running, but "the name is momentarily unowned"
# is exactly the state at login while the shell is still starting, so D-Bus
# spawned a SECOND claimant racing the shell. dbus-broker then abandons the
# frontend's StartServiceByName reply, and the whole session stalls for the
# full 25s D-Bus timeout. With no activation file the name has exactly one
# possible owner. The tinshell-portal.service unit stays installed for DEV mode but
# is NOT enabled.

say "installing portal FileChooser backend (user-local)"
mkdir -p "$HOME_DIR/.local/share/xdg-desktop-portal/portals"

cp "$TINSHELL_HOME/apps/portal/tinshell-portal.portal" \
  "$HOME_DIR/.local/share/xdg-desktop-portal/portals/tinshell-portal.portal" &&
  done_ "portal .portal file installed" ||
  err "portal .portal install failed"

sed "s|__HOME__|$HOME_DIR|g" "$TINSHELL_HOME/systemd/tinshell-portal.service" > \
  "$SYSTEMD_USER/tinshell-portal.service" &&
  done_ "tinshell-portal.service installed (dev mode)" ||
  err "tinshell-portal.service install failed"

# portals.conf: merge [preferred] FileChooser=tinshell-portal — never clobber an
# existing default= or other keys.
PORTALS_CONF="$HOME_DIR/.config/xdg-desktop-portal/portals.conf"
mkdir -p "$(dirname "$PORTALS_CONF")"
if [ ! -f "$PORTALS_CONF" ]; then
  printf '[preferred]\norg.freedesktop.impl.portal.FileChooser=tinshell-portal\n' >"$PORTALS_CONF"
  done_ "portals.conf created with tinshell-portal preferred"
elif grep -q 'org.freedesktop.impl.portal.FileChooser=tinshell-portal' "$PORTALS_CONF"; then
  skip "portals.conf already prefers tinshell-portal"
elif grep -q '^\[preferred\]' "$PORTALS_CONF"; then
  sed -i '/^\[preferred\]/a org.freedesktop.impl.portal.FileChooser=tinshell-portal' "$PORTALS_CONF"
  done_ "portals.conf [preferred] updated with tinshell-portal"
else
  printf '\n[preferred]\norg.freedesktop.impl.portal.FileChooser=tinshell-portal\n' >>"$PORTALS_CONF"
  done_ "portals.conf [preferred] section added"
fi

# ─────────────────── 9. Hyprland integration ─────────────────────────

HYPR="$HOME_DIR/.config/hypr/hyprland.lua"
if [ -f "$HYPR" ]; then
  say "verifying Hyprland integration ($HYPR)"
  MISSING_RULES=()
  grep -q 'dock-\.\*' "$HYPR" 2>/dev/null || MISSING_RULES+=("layerrule blur, dock-.*")
  grep -q 'namespace = "launcher"' "$HYPR" 2>/dev/null || grep -q 'blur, launcher' "$HYPR" 2>/dev/null || MISSING_RULES+=('layerrule blur, launcher')
  grep -q 'namespace = "promptd"' "$HYPR" 2>/dev/null || grep -q 'blur, promptd' "$HYPR" 2>/dev/null || MISSING_RULES+=('layerrule blur, promptd')
  grep -q 'start tinshell-shell' "$HYPR" 2>/dev/null || MISSING_RULES+=('systemctl --user start tinshell-shell')
  grep -q 'namespace = "notifications' "$HYPR" 2>/dev/null || grep -q 'blur, notifications' "$HYPR" 2>/dev/null || MISSING_RULES+=('layerrule blur, notifications-.*')
  grep -q 'keyboard-\.\*' "$HYPR" 2>/dev/null || MISSING_RULES+=('layerrule blur, keyboard-.*')
  grep -q 'clipboard-picker' "$HYPR" 2>/dev/null || MISSING_RULES+=('layerrule blur, clipboard-picker')
  grep -q 'namespace = "session-overlay"' "$HYPR" 2>/dev/null || grep -q 'blur, session-overlay' "$HYPR" 2>/dev/null || MISSING_RULES+=('layerrule blur, session-overlay')
  grep -q 'files-float' "$HYPR" 2>/dev/null || MISSING_RULES+=('windowrule float, files-float (io.Astal.files)')
  grep -q 'notes-float' "$HYPR" 2>/dev/null || MISSING_RULES+=('windowrule float, notes-float (io.Astal.notes)')
  grep -q 'annotate-float' "$HYPR" 2>/dev/null || MISSING_RULES+=('windowrule float, annotate-float (io.Astal.annotate)')
  grep -q 'portal-float' "$HYPR" 2>/dev/null || MISSING_RULES+=('windowrule float, portal-float (io.Astal.portal)')
  grep -q 'media-float' "$HYPR" 2>/dev/null || MISSING_RULES+=('windowrule float, media-float (io.Astal.media)')
  grep -q 'shell/ensure-launcher-toggle.sh' "$HYPR" 2>/dev/null || MISSING_RULES+=('SUPER+Space → shell/ensure-launcher-toggle.sh (launcher keybind)')
  grep -q 'shell/ensure-screengrab.sh' "$HYPR" 2>/dev/null || MISSING_RULES+=('Print → shell/ensure-screengrab.sh (region capture keybind)')
  grep -q 'tinshell-route.sh' "$HYPR" 2>/dev/null || MISSING_RULES+=('tinshell-route.sh (notifications/clipboard keybinds)')
  grep -q 'shell/restart-shell.sh' "$HYPR" 2>/dev/null || MISSING_RULES+=('SUPER+SHIFT+B → shell/restart-shell.sh (shell restart keybind)')
  if [ ${#MISSING_RULES[@]} -eq 0 ]; then
    done_ "Hyprland integration verified (blur rules + start hook present)"
  else
    err "Hyprland config missing some integration lines. Add these to $HYPR:"
    for rule in "${MISSING_RULES[@]}"; do echo "    $rule"; done
  fi
else
  err "$HYPR not found — Hyprland config must be set up separately."
fi

# ─────────────────── 10. Root steps (sudo, auto-skip) ────────────────

say "root-level hardware setup (sudo; each auto-skipped if already done)"

# (a) input group — for tablet-mode EVIOCGSW read access to /dev/input.
if id -nG "$USER" 2>/dev/null | grep -qw input; then
  skip "input group membership"
else
  sudo usermod -aG input "$USER"
  done_ "added $USER to input group (re-login to take effect)"
fi

# (b) asus_nb_wmi modprobe option — tablet_mode_sw=2 (lid-flip → SW_TABLET_MODE).
# Deployed as a LINE into /etc/modprobe.d/asus-nb-wmi.conf, never as a whole-file
# write: a user's other options in that file are preserved (deploy_config_line).
MODPROBE_FILE="/etc/modprobe.d/asus-nb-wmi.conf"
MODPROBE_LINE="options asus_nb_wmi tablet_mode_sw=2"
deploy_config_line "$MODPROBE_FILE" "$MODPROBE_LINE" "tablet_mode_sw=2" 644
if [ "$TINSHELL_DEPLOY_OUTCOME" = "already-set" ]; then
  skip "asus_nb_wmi modprobe option"
else
  done_ "$MODPROBE_FILE carries tablet_mode_sw=2 (reboot or reload asus_nb_wmi to apply)"
fi

# (c) udev rule — best-effort direct-write shortcut for
# charge_control_end_threshold. The attribute is normally root-owned 0644: the
# chmod below does NOT reliably land (the driver can create the attribute after
# the "add" event fires), so the WRITE PATH THAT ACTUALLY WORKS is the scoped
# `sudo -n tee` rule in step (d) — `fs.writeFileAsync` tries the direct write
# first and falls back to it. Deployed as a LINE (deploy_config_line), so other
# rules a user added to that file survive.
UDEV_FILE="/etc/udev/rules.d/99-battery-charge-threshold.rules"
UDEV_LINE='ACTION=="add", SUBSYSTEM=="power_supply", KERNEL=="BAT0", RUN+="/bin/chmod 0666 /sys/class/power_supply/BAT0/charge_control_end_threshold"'
deploy_config_line "$UDEV_FILE" "$UDEV_LINE" "charge_control_end_threshold" 644
if [ "$TINSHELL_DEPLOY_OUTCOME" = "already-set" ]; then
  skip "battery charge-threshold udev rule"
else
  sudo udevadm control --reload-rules
  sudo udevadm trigger 2>/dev/null || true
  done_ "wrote $UDEV_FILE + reloaded udev"
fi

# (d) the machine-level charge-cap INTENT file. The limit belongs to the
# MACHINE, not to a user account: the pre-login greeter runs as a different user
# and cannot read the session user's state dir, so a per-user store left a cap
# set before login UNRECORDABLE — the session's drift-heal then re-applied its
# own stale value over it. World-readable so every account can read it; written
# through the scoped sudo rules below (never a writable-by-all file).
CAP_FILE="/var/lib/ags/charge-cap"
LEGACY_CAP="$HOME_DIR/.local/state/tinshell/apps/battery/state.json"
if [ -f "$CAP_FILE" ]; then
  skip "charge-cap intent file"
else
  sudo install -d -m 755 /var/lib/ags
  if [ -f "$LEGACY_CAP" ]; then
    sudo install -Dm644 "$LEGACY_CAP" "$CAP_FILE" && done_ "seeded $CAP_FILE from the per-user store"
  else
    printf '{\n  "version": 1\n}\n' | sudo tee "$CAP_FILE" >/dev/null
    sudo chmod 644 "$CAP_FILE"
    done_ "created $CAP_FILE (no previous limit to migrate)"
  fi
fi

# (e) sudoers — the charge cap. The udev chmod in (c) does not reliably land,
# so these scoped `sudo -n tee` rules ARE the write path: the sysfs attribute
# itself plus the intent file above, for the session user (dock + lock screen)
# and for the greeter user (login screen). sudoers names those exact paths, so
# the generic `fs.writeFileAsync` cannot escalate anywhere else. Each rule is a
# LINE appended to its sudoers.d file (deploy_config_line) and the MERGED file
# is validated with visudo BEFORE install — a broken file in sudoers.d locks
# out sudo entirely, so a file that already exists is never replaced unvalidated.
CAP_TEE='/usr/bin/tee /sys/class/power_supply/BAT0/charge_control_end_threshold, /usr/bin/tee /var/lib/ags/charge-cap'
if ! deploy_config_line /etc/sudoers.d/tinshell-battery "$(id -un) ALL=(root) NOPASSWD: $CAP_TEE" "charge-cap" 440 visudo -c -f; then
  err "the charge-cap sudoers rule for $(id -un) is NOT installed — the session cannot write the battery cap"
fi
if id greeter >/dev/null 2>&1; then
  # Same merge-and-validate path for the greeter user's rule (the login screen
  # needs it before any session exists).
  if ! deploy_config_line /etc/sudoers.d/50-ags-greeter-battery "greeter ALL=(root) NOPASSWD: $CAP_TEE" "charge-cap" 440 visudo -c -f; then
    err "the charge-cap sudoers rule for greeter is NOT installed — the login screen cannot write the battery cap"
  fi
else
  skip "greeter charge-threshold sudoers rule (no greeter user yet)"
fi

# (f) the machine-level COUNTER STAMP: when the pack became plugged-and-idle.
# The fully-charged counter is painted by the session's battery applet AND by the
# pre-login greeter, whose home is not the session user's — a per-user stamp is
# unreadable there, so the login screen counted from the moment its strip mounted
# instead of from the state's start. World-readable so every account reads it;
# only the SESSION user gets the write rule below, because the session host is
# the one that records the start.
STAMP_FILE="/var/lib/ags/plugged-since"
if [ -f "$STAMP_FILE" ]; then
  skip "plugged-since stamp file"
else
  sudo install -d -m 755 /var/lib/ags
  # Seed the count already running in the per-user store, so the move does not
  # restart a live counter at 0s. The low-battery latch beside it stays per-user.
  LEGACY_SINCE=""
  STAMP_SRC="$HOME_DIR/.local/state/tinshell/apps/battery/state.json"
  if [ -f "$STAMP_SRC" ]; then
    LEGACY_SINCE="$(sed -n 's/.*"pluggedSince"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$STAMP_SRC" 2>/dev/null | head -n1 || true)"
  fi
  printf '{\n  "version": 1,\n  "pluggedSince": %s\n}\n' "${LEGACY_SINCE:-0}" | sudo tee "$STAMP_FILE" >/dev/null
  sudo chown root:root "$STAMP_FILE"
  sudo chmod 644 "$STAMP_FILE"
  if [ -n "$LEGACY_SINCE" ]; then
    done_ "created $STAMP_FILE (count resumed from $LEGACY_SINCE)"
  else
    done_ "created $STAMP_FILE (no count running)"
  fi
fi

# The stamp's write path: the SAME scoped `sudo -n tee` shape as the cap, one
# line per account under its own marker (a marker is what makes a re-run a
# no-op, so the cap's line is never rebuilt). NO greeter rule exists on purpose:
# the login screen only READS the stamp.
STAMP_TEE='/usr/bin/tee /var/lib/ags/plugged-since'
if ! deploy_config_line /etc/sudoers.d/tinshell-battery "$(id -un) ALL=(root) NOPASSWD: $STAMP_TEE" "plugged-since" 440 visudo -c -f; then
  err "the plugged-since sudoers rule for $(id -un) is NOT installed — the session cannot record when the pack became idle"
fi

# ───────────────── 10b. greeter island (greetd, boot-level) ─────────────────

say "greeter (greetd + TINSHELL login screen — boot-level, NO user unit)"

if pacman -Q greetd >/dev/null 2>&1; then
  skip "greetd package"
else
  sudo pacman -S --needed --noconfirm greetd
  done_ "greetd installed"
fi

if pacman -Q libastal-greetd-git >/dev/null 2>&1; then
  skip "libastal-greetd-git"
else
  AUR_HELPER=""
  for h in yay paru; do command -v "$h" >/dev/null 2>&1 && AUR_HELPER="$h" && break; done
  if [ -n "$AUR_HELPER" ]; then
    $AUR_HELPER -S --needed --noconfirm libastal-greetd-git ||
      err "libastal-greetd-git install failed — run manually: $AUR_HELPER -S libastal-greetd-git"
    done_ "libastal-greetd-git installed"
  else
    err "libastal-greetd-git needs manual install (no yay/paru found)"
  fi
fi

# Lock mode (TINSHELL_GREETER_MODE=lock) — the AstalAuth PAM backend. Ships its own
# /etc/pam.d/astal-auth (auth include login); no quarrel needed.
if pacman -Q libastal-auth-git >/dev/null 2>&1; then
  skip "libastal-auth-git"
else
  AUR_HELPER=""
  for h in yay paru; do command -v "$h" >/dev/null 2>&1 && AUR_HELPER="$h" && break; done
  if [ -n "$AUR_HELPER" ]; then
    $AUR_HELPER -S --needed --noconfirm libastal-auth-git ||
      err "libastal-auth-git install failed — run manually: $AUR_HELPER -S libastal-auth-git"
    done_ "libastal-auth-git installed"
  else
    err "libastal-auth-git needs manual install (no yay/paru found)"
  fi
fi

# Build + deploy the bundle (tinoy build via build.sh, root deploy via install.sh).
if [ -f "$TINSHELL_HOME/apps/greeter/dist/greeter-tinshell.sh" ]; then
  skip "greeter bundle (already built)"
else
  (cd "$TINSHELL_HOME/apps/greeter" && ./build.sh) || err "greeter build.sh failed"
  done_ "greeter bundle built"
fi

# Lock bundle (runs as tinoy from dist/, launched by hypridle lock_cmd).
if [ -f "$TINSHELL_HOME/apps/greeter/dist/tinshell-lock.sh" ]; then
  skip "greeter lock bundle (already built)"
else
  (cd "$TINSHELL_HOME/apps/greeter" && ./build-lock.sh) || err "greeter build-lock.sh failed"
  done_ "greeter lock bundle built"
fi

if [ -f /etc/greetd/ags-greeter.sh ]; then
  skip "greeter deploy (/etc/greetd/ags-greeter.sh present)"
else
  (cd "$TINSHELL_HOME/apps/greeter" && sudo ./install.sh) || err "greeter install.sh failed"
  done_ "greeter deployed to /etc/greetd/"
fi

# Greeter compositor config verification (the greeter's blur rule lives in
# /etc/greetd/greeter.lua, NOT hyprland.lua — different compositor).
if [ -f /etc/greetd/greeter.lua ] && grep -q 'namespace = "greeter"' /etc/greetd/greeter.lua; then
  skip "greeter compositor config (/etc/greetd/greeter.lua)"
else
  err "/etc/greetd/greeter.lua missing or lacks the greeter blur rule — re-run greeter/install.sh"
fi

# Brightness keys with nobody logged in: the XF86MonBrightness binds live ONLY
# in this file (hyprland.lua belongs to the session's own compositor and is not
# loaded at the login screen). Checked apart from the blur rule above, because a
# config deployed BEFORE the binds existed passes that check. A missing file is
# reported above, hence the elif.
if [ -f /etc/greetd/greeter.lua ] && grep -q XF86MonBrightnessUp /etc/greetd/greeter.lua && grep -q XF86MonBrightnessDown /etc/greetd/greeter.lua; then
  skip "greeter brightness binds (/etc/greetd/greeter.lua)"
elif [ -f /etc/greetd/greeter.lua ]; then
  # Copy the config ONLY — install.sh re-deploys the BUNDLE, both config
  # schemas, greeter-handoff.sh and PAM on the machine's only login path, all
  # of which a keybind change does not need. (The LIVE
  # /etc/greetd/ags-greeter/config.json is no longer a reason to avoid it:
  # since the seed guard it is preserved unless --force.)
  err "/etc/greetd/greeter.lua lacks the XF86MonBrightness binds — copy the config only: install -Dm644 $TINSHELL_HOME/apps/greeter/templates/greeter.lua /etc/greetd/greeter.lua"
fi

# DM switch (greetd ↔ plasmalogin). Only flips once greetd is actually
# deployed; plasmalogin stays installed as rollback. On a fresh machine this
# runs before any graphical login; on a live machine do it from a spare TTY.
if systemctl is-enabled greetd >/dev/null 2>&1 && ! systemctl is-enabled plasmalogin >/dev/null 2>&1; then
  skip "DM switch (greetd enabled, plasmalogin disabled)"
elif [ -f /etc/greetd/ags-greeter.sh ] && systemctl is-enabled plasmalogin >/dev/null 2>&1; then
  sudo systemctl enable greetd
  sudo systemctl disable plasmalogin
  done_ "DM switched: greetd enabled, plasmalogin disabled (reboot lands on the TINSHELL greeter)"
else
  skip "DM switch (prerequisites missing — greetd not deployed yet)"
fi

# ─────── 10c. applets socket dir (greeter ↔ session backend transport) ───────
# The applets backend (hosted by the dock) serves a unix socket in /run/ags so the
# PRE-LOGIN greeter
# (user `greeter`, no session bus, no access to tinoy's home) can read applet
# data from the live session. Cross-user access is a shared GROUP on a root
# directory: /run is a root-owned tmpfs, so both the group and the directory
# (2750, setgid → the socket inherits the group) are root artifacts installed
# here and re-created by tmpfiles at every boot. The socket itself is created
# and mode-fixed by the backend process (tinoy) — nothing here needs to run per
# session. Auto-skipped when already configured.

SOCKET_GROUP="ags-greeter"
if getent group "$SOCKET_GROUP" >/dev/null; then
  skip "group $SOCKET_GROUP (applets socket)"
else
  sudo groupadd --system "$SOCKET_GROUP"
  done_ "created group $SOCKET_GROUP"
fi

if id greeter >/dev/null 2>&1; then
  if id -nG greeter 2>/dev/null | grep -qw "$SOCKET_GROUP"; then
    skip "greeter in group $SOCKET_GROUP"
  else
    sudo usermod -aG "$SOCKET_GROUP" greeter
    done_ "added greeter to group $SOCKET_GROUP"
  fi
else
  err "user 'greeter' does not exist (greetd missing?) — the socket group has no member"
fi

TMPFILES_SRC="$TINSHELL_HOME/systemd/tmpfiles.d/ags-applets.conf"
TMPFILES_DST="/etc/tmpfiles.d/ags-applets.conf"
if [ ! -f "$TMPFILES_SRC" ]; then
  err "tmpfiles template missing: $TMPFILES_SRC"
elif sudo cmp -s "$TMPFILES_SRC" "$TMPFILES_DST"; then
  skip "tmpfiles entry $TMPFILES_DST (up to date)"
else
  sudo install -Dm644 "$TMPFILES_SRC" "$TMPFILES_DST"
  done_ "installed tmpfiles entry $TMPFILES_DST"
fi

if [ -f "$TMPFILES_SRC" ]; then
  if sudo systemd-tmpfiles --create "$TMPFILES_DST"; then
    done_ "/run/ags ready ($(sudo stat -c '%U:%G %a' /run/ags 2>/dev/null))"
  else
    err "systemd-tmpfiles could not create /run/ags — the applets socket will not be served"
  fi
fi

# ───── 10d. hyprland session console-log redirect (pacman hook) ──────
# greetd runs the session's Exec line through a shell and hands the session the
# VT as its stdout/stderr, so the session compositor's pre-parse banner/logs
# paint VT 1 as a text console at every login/logout. The redirect that keeps
# them off the console lives on the session's wayland entry — a file the
# hyprland package owns, so every hyprland upgrade reinstalls the bare Exec line
# and the spam returns (a hyprland package upgrade does exactly that). A
# pacman PostTransaction hook re-applies it after any transaction; both files
# are root artifacts installed here, and the hook is run once immediately so a
# fresh machine is fixed without waiting for a hyprland transaction. The entry
# itself is repaired in place (see the script's header for the trade-off).

SESSION_REDIRECT_SRC="$TINSHELL_HOME/systemd/pacman.d/hyprland-session-redirect.sh"
SESSION_REDIRECT_DST="/usr/local/lib/hyprland-session-redirect.sh"
SESSION_HOOK_SRC="$TINSHELL_HOME/systemd/pacman.d/hooks/95-hyprland-session-log.hook"
SESSION_HOOK_DST="/etc/pacman.d/hooks/95-hyprland-session-log.hook"

if [ ! -f "$SESSION_REDIRECT_SRC" ] || [ ! -f "$SESSION_HOOK_SRC" ]; then
  err "session-redirect templates missing under $TINSHELL_HOME/systemd/pacman.d/"
elif sudo cmp -s "$SESSION_REDIRECT_SRC" "$SESSION_REDIRECT_DST" &&
     sudo cmp -s "$SESSION_HOOK_SRC" "$SESSION_HOOK_DST"; then
  skip "hyprland session-log redirect (hook + script up to date)"
else
  sudo install -Dm755 "$SESSION_REDIRECT_SRC" "$SESSION_REDIRECT_DST"
  sudo install -Dm644 "$SESSION_HOOK_SRC" "$SESSION_HOOK_DST"
  done_ "installed $SESSION_HOOK_DST + $SESSION_REDIRECT_DST"
fi

# Apply now, every run: the hook only fires on the next hyprland transaction,
# and this step is what repairs a machine whose redirect a past upgrade wiped.
# The script is idempotent (already-redirected = no-op) and never exits non-zero.
if [ -f "$SESSION_REDIRECT_DST" ]; then
  sudo "$SESSION_REDIRECT_DST"
  done_ "session entry: $(grep -m1 '^Exec=' /usr/share/wayland-sessions/hyprland.desktop 2>/dev/null || echo 'Exec line unreadable')"
else
  err "$SESSION_REDIRECT_DST missing — the console-log redirect cannot be applied"
fi

# ───────────────────── 11. Verify + start ────────────────────────────

say "verifying EGL ICD (Mesa)"
if [ -f /usr/share/glvnd/egl_vendor.d/50_mesa.json ]; then
  done_ "Mesa EGL ICD present (prevents NVIDIA dGPU wake)"
else
  err "Mesa EGL ICD missing — install mesa."
fi

say "checking XDG_RUNTIME_DIR"
if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  done_ "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
else
  err "XDG_RUNTIME_DIR not set — services won't find the runtime dir. Re-login."
fi

# Start the services (idempotent — a no-op if already running via the target).
# Production = shell only; the per-app units are dev mode.
say "starting services"
systemctl --user start tinshell-shell.service 2>/dev/null && done_ "tinshell-shell started" || skip "tinshell-shell already running"

# ─────────────────────────── 12. Summary ─────────────────────────────

echo ""
echo "${C_DONE}════════════════════════════════════════════════════${C_RST}"
echo "${C_DONE} TINSHELL multi-app home setup complete${C_RST}"
echo "${C_DONE}════════════════════════════════════════════════════${C_RST}"
echo ""
echo "Services:"
echo "  systemctl --user status tinshell-shell"
echo "  journalctl --user -u tinshell-shell -f"
echo ""
echo "Smoke tests:"
echo "  ags list                                          # enumerate running instances"
echo "  ags -i shell request \"\"                            # available command namespaces"
echo "  ags -i shell request \"dock config get layout.position\"  # live config read"
echo "  ags -i shell request \"launcher toggle\"            # open the launcher"
echo "  ags -i shell request \"notifications toggle-centre\" # open the notification centre"
echo "  ags -i shell request \"keyboard toggle\"            # OSK (if keyboard.enabled)"
echo "  ags -i shell request \"promptd ping\"               # promptd alive (pong)"
echo "  ags -i shell request \"polkit status\"              # polkit agent registered"
echo "  ags -i shell request \"files ping\"                 # files alive (pong)"
echo "  ags -i shell request \"media ping\"                 # media alive (pong)"
echo ""
echo "Dev islands (isolated restarts; shell stopped):"
echo "  ags run apps/notes/app.ts                      # or any <app>/app.ts"
echo "  systemctl --user start tinshell-shell.service           # or any per-app unit"
echo ""
echo "Manual follow-ups (if any were printed above):"
echo "  - AUR packages not installed → yay -S <pkgs>"
echo "  - hyprgrass plugin → sudo hyprpm add <repo> && sudo hyprpm reload"
echo "  - re-login for the input group to take effect"
echo "  - reboot (or modprobe reload) for asus_nb_wmi tablet_mode_sw"
