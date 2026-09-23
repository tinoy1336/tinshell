#!/usr/bin/env bash
# new-app.sh <name> [--desktop] — scaffold a new TINSHELL app into apps/<name>.
#
# Generates the app skeleton (app.ts, mount.ts, commands.ts, style.css,
# config trio, AGENTS.md stub) AND wires the two hosting sources of truth in
# the SAME command (forgetting is impossible):
#   1. common/shell/apps.json   — the manifest (tinshell-host.sh + tinshell-mode read it)
#   2. common/host/registry.ts  — the static import map (universal entry)
# plus prints the integration checklist (setup.sh hooks, Hyprland rule,
# route-map). Nothing else is auto-wired — the checklist is the contract
# (missing a step silently breaks fresh-machine bootstraps).
#
#   new-app.sh mytool            → standalone app (service-ish; add a dev unit
#                                  to systemd/ if it needs one)
#   new-app.sh mytool --desktop  → on-demand desktop app (lazy in the shell;
#                                  no unit by design)
set -euo pipefail

NAME="${1:?usage: new-app.sh <name> [--desktop]}"
DESKTOP="${2:-}"
TINSHELL_HOME="$(cd "$(dirname "$0")/../.." && pwd)" # common/shell → repo root
APP_DIR="$TINSHELL_HOME/apps/$NAME"
MANIFEST="$TINSHELL_HOME/common/shell/apps.json"
REGISTRY="$TINSHELL_HOME/common/host/registry.ts"

if [ "$DESKTOP" != "" ] && [ "$DESKTOP" != "--desktop" ]; then
 echo "new-app: unknown flag '$DESKTOP' (only --desktop)" >&2
 exit 1
fi
if [ -e "$APP_DIR" ]; then
 echo "new-app: $APP_DIR already exists" >&2
 exit 1
fi

mkdir -p "$APP_DIR"

# ── app.ts ──
cat >"$APP_DIR/app.ts" <<EOF
/**
 * $NAME entry point — boots the TINSHELL app via the shared start helper.
 *
 * instanceName "$NAME" → owns the io.Astal.$NAME bus (addressed via
 * \`ags -i $NAME request|quit\` / inside the shell: \`ags -i shell request "$NAME …"\`).
 * Production runs inside the shell instance via the universal entry
 * (common/host/entry.ts + registry.ts) — see ./mount. $([ "$DESKTOP" = "--desktop" ] && echo "On-demand desktop app: no systemd unit; LAZY in the shell (load on first request, unload after 60s grace — exports unmount)." || echo "Standalone app: add a dev unit to systemd/ if it needs one (copy an existing template).")
 *
 * app.ts stays the bare \`ags run apps/$NAME/app.ts\` debug entry + per-app
 * tsc target — the LAUNCH path for every shape is tinshell-host.sh (root
 * AGENTS.md). Never bare \`ags run\` in production contexts.
 */
import { createApp } from "../../common/app/start"
import { ${NAME}Css, ${NAME}Mount } from "./mount"

createApp({
  instanceName: "$NAME",
  css: ${NAME}Css,
  main() {
    ${NAME}Mount()
  },
})
EOF

# ── mount.ts ──
cat >"$APP_DIR/mount.ts" <<EOF
/**
 * $NAME mount — the shared builder (the island app.ts AND the universal
 * entry's registry both reach it).
 *
 * Registers commands (side-effect imports, prefixed ["$NAME", …]), builds
 * windows. Must NOT call app.quit(), own
 * an instance name, or read argv — those stay in the island app.ts. Gate any
 * quit-on-close on \`isShell\` (\`../../common/app/mode\`) and skip the per-app log
 * sink in the PRODUCTION shell only (\`isProductionShell\` — one global sink).
 */
import "./commands" // side-effect: registers request handlers
import { fileSink, setSink } from "../../common/log/logger"
import { isProductionShell } from "../../common/app/mode"
import theme from "../../common/shell/theme.css"
import style from "./style.css"

if (!isProductionShell) {
  setSink(fileSink("/tmp/tinshell-$NAME-debug.log"), "[$NAME]")
}

export const ${NAME}Css = theme + "\n" + style

export function ${NAME}Mount(): void {
  // Build windows / register state here.
}
EOF

# ── commands.ts ──
cat >"$APP_DIR/commands.ts" <<EOF
/**
 * $NAME request handlers — \`ags -i shell request "$NAME …"\` (island:
 * \`ags -i $NAME request "$NAME …"\`). PREFIXED registration is mandatory:
 * the registry is process-global in the shell.
 */
import { register } from "../../common/commands/registry"

register(["$NAME", "ping"], (_args, res) => {
  res("pong")
})
EOF

# ── style.css ──
cat >"$APP_DIR/style.css" <<'EOF'
/* app styles — see ../../common/shell/theme.css for shared primitives. */
EOF

# ── config trio ──
cat >"$APP_DIR/config.defaults.json" <<'EOF'
{}
EOF
# Schema SOURCE (TypeBox) — config.schema.json is a GENERATED artifact:
# run \`npm run gen:schemas\` (scripts/gen-config-schemas.ts) after edits.
cat >"$APP_DIR/config.schema.ts" <<'EOF'
/**
 * $NAME config schema — TypeBox source of truth (common/config/schema-build.ts).
 * Generated artifact: config.schema.json — run \`npm run gen:schemas\`.
 * Loader subset: common/config/loader.ts.
 */
import { obj, type Static } from "../../common/config/schema-build.ts"

export const schema = obj({})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, never> = {}
EOF
cat >"$APP_DIR/config.json" <<'EOF'
{}
EOF
cat >"$APP_DIR/config.ts" <<EOF
/**
 * $NAME config — the app's OWN store + facade
 * (apps/$NAME/config.{defaults,schema,json}; on-disk dir
 * ~/dev/tinshell/apps/$NAME via appSchemaDir — root AGENTS.md convention).
 * The app owns its store: createConfigStore(appSchemaDir(name), appConfigPath(name)) wrapped in
 * the generic facade from \`../../common/config/facade.ts\` (stable mirror +
 * get/set/applyToLive/queueWrite/onConfigChanged) — see a surface app's
 * config.ts (e.g. apps/keyboard/config.ts).
 */
import { type ConfigFacade, createConfigFacade } from "../../common/config/facade"
import { appConfigPath, appSchemaDir, createConfigStore } from "../../common/config/loader"

const $NAME = createConfigFacade(createConfigStore(appSchemaDir("$NAME"), appConfigPath("$NAME")))

/** The facade (onConfigChanged fires only on $NAME changes). */
export const store: ConfigFacade = $NAME

/** The live $NAME config (namespace subtree mirror; read directly — never
 *  cache: config set mutates it in place). */
export const config = $NAME.config
EOF

# ── AGENTS.md stub ──
cat >"$APP_DIR/AGENTS.md" <<EOF
# AGENTS.md — $NAME

Brief: what this app does, its windows, its commands. **READ the root
\`~/dev/tinshell/AGENTS.md\` FIRST** (bus naming, router, tinshell-host launch
path, lazy loading, common modules).

- Hosting: production = the shell instance hosts $NAME via the universal
  entry (registry.ts); dev island = \`tinshell-host start $NAME\` (or
  \`ags run apps/$NAME/app.ts\` for debugging).
- Router: \`$NAME=shell,$NAME\` in \`common/shell/route-map.conf\`.
- Commands: \`["$NAME", …]\` prefixed.
EOF

# ── wire the manifest (apps.json) ──
if [ "$DESKTOP" = "--desktop" ]; then
  jq --arg n "$NAME" --arg css "${NAME}Css" --arg mount "${NAME}Mount" \
    '.[$n] = { css: $css, mount: $mount, unmount: "unmount", lazy: true }' "$MANIFEST" >"$MANIFEST.tmp"
else
  jq --arg n "$NAME" --arg css "${NAME}Css" --arg mount "${NAME}Mount" \
    '.[$n] = { css: $css, mount: $mount }' "$MANIFEST" >"$MANIFEST.tmp"
fi
mv "$MANIFEST.tmp" "$MANIFEST"

# ── wire the registry (registry.ts) ──
if [ "$DESKTOP" = "--desktop" ]; then
  REG_ENTRY="  $NAME: {
    mod: () => import(\"@apps/$NAME/mount\"),
    mount: \"${NAME}Mount\",
    css: \"${NAME}Css\",
    unmount: \"unmount\",
    lazy: true,
  },"
else
  REG_ENTRY="  $NAME: {
    mod: () => import(\"@apps/$NAME/mount\"),
    mount: \"${NAME}Mount\",
    css: \"${NAME}Css\",
  },"
fi
python3 - "$REGISTRY" "$REG_ENTRY" "$NAME" "$DESKTOP" <<'PYEOF'
import sys
path, entry, name, desktop = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
src = open(path).read()
marker = "  // ── new-app.sh inserts new REGISTRY entries ABOVE this line ──"
order_marker = "  // ── new-app.sh appends new apps ABOVE this line ──"
assert marker in src and order_marker in src, "registry.ts markers missing"
src = src.replace(marker, entry + "\n\n" + marker, 1)
src = src.replace(order_marker, f'  "{name}",\n' + order_marker, 1)
if desktop == "--desktop":
    # LAZY_APPS is what both host shapes iterate to register a lazy prefix —
    # an entry missing here means the app has no namespace and every request
    # answers "unknown command".
    lazy_marker = 'export const LAZY_APPS = ['
    i = src.index(lazy_marker)
    j = src.index("]", i)
    src = src[:j] + f', "{name}"' + src[j:]
open(path, "w").write(src)
PYEOF

echo "scaffolded $APP_DIR (+ manifest + registry entries — both sources of truth wired)"
echo ""
echo "INTEGRATION CHECKLIST (root AGENTS.md — do ALL of these):"
echo "  1. common/shell/route-map.conf — add: $NAME=shell,$NAME"
echo "  2. systemd/ — add a dev unit ONLY if the app needs one (copy an existing template; on-demand desktop apps skip it). Manifest 'unit' field goes in apps.json."
echo "  3. hyprland.lua — add a blur layerrule for the app's window namespace (or a float windowrule for desktop windows)."
echo "  4. Wire keybinds/launch hooks through common/shell/tinshell-route.sh (the router finds any live host + cold-starts via tinshell-host)."
echo "  5. tsc --noEmit + a fresh bundle: TINSHELL_BUNDLE_FORCE=1 tinshell-host.sh warm shell"
