/**
 * apps/launcher/hypr-rules.ts — the launcher's compositor rules (generated into
 * the compositor config by `npm run gen:hypr-rules`, see common/hyprland/rule).
 *
 * Frosted glass: the compositor blurs the launcher's translucent layer surface.
 *
 * The two keys that summon the launcher are declared here with the surface they
 * open: they route through the launcher's entry-point scripts, which resolve the
 * live instance through the router and cold-start one when none is up.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { LAUNCHER_NAMESPACE } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "launcher",
  identityModule: "apps/launcher/identity.ts",
  layer: [{ match: { namespace: LAUNCHER_NAMESPACE }, blur: true, ignore_alpha: 0.2 }],
  bind: [
    {
      keys: "SUPER + Space",
      cmd: "common/shell/ensure-launcher-toggle.sh",
      note: "Launcher entry point: toggles the live instance, cold-starting one when none is up. Keybind exec has no ~/.local/bin in PATH, so the command is a path under the tree root.",
    },
    {
      keys: "SUPER + period",
      cmd: "common/shell/ensure-launcher-emoji.sh",
      note: "Emoji mode: opens the launcher in emoji mode, closes it when already there, switches it otherwise.",
    },
  ],
}

export default rules
