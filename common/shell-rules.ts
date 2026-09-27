/**
 * common/shell-rules.ts — the shell's own compositor integration (generated
 * into the compositor config by `npm run gen:hypr-rules`, see
 * common/hyprland/rule).
 *
 * The shell owns no compositor RULE: it passes no layer-shell namespace and
 * sets no window app_id, so there is no name for a rule to match and no
 * identity module for this set to point at — the generated header leaves its
 * `source:` line out. What the shell owns here is its START: the unit that
 * brings the shell up.
 *
 * It also owns its own restart key. The key is rendered from this tree, so a
 * tree that cannot render is a tree whose restart key may be missing; the
 * recovery paths that do not depend on it are the always-inline terminal key
 * (SUPER + Return) plus `common/shell/restart-shell.sh` run by hand, and a TTY
 * `systemctl --user restart tinshell-shell`.
 */
import type { HyprRuleSet } from "./hyprland/rule.ts"

const rules: HyprRuleSet = {
  owner: "shell",
  bind: [
    {
      keys: "SUPER + SHIFT + B",
      cmd: "common/shell/restart-shell.sh",
      note: "Restarts the live shell (shell first, island second); the unit's ExecStartPre (tinshell-bus-wait.sh shell) absorbs the bus-name release, so no manual sleep. Keybind exec has no ~/.local/bin in PATH, so the command is a path under the tree root.",
    },
  ],
  start: [
    {
      cmd: "systemctl --user start tinshell-shell",
      note: "graphical-session.target never activates in this session (start-hyprland, no uwsm), so the unit's WantedBy= wiring cannot bring it up; this hook is what does. A start of an already-active unit is a no-op.",
    },
  ],
}

export default rules
