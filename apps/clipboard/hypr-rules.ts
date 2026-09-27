/**
 * apps/clipboard/hypr-rules.ts — the clipboard picker's compositor rules
 * (generated into the compositor config by `npm run gen:hypr-rules`, see
 * common/hyprland/rule).
 *
 * Frosted glass: the picker is its own popup surface, so its frost is its own
 * rule rather than the dock's.
 *
 * The key that opens the picker is declared here with it (SUPER + V is the float
 * toggle): it routes through the clipboard entry point, which resolves the live
 * instance that owns the surface.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { CLIPBOARD_PICKER_NAMESPACE } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "clipboard",
  identityModule: "apps/clipboard/identity.ts",
  layer: [{ match: { namespace: CLIPBOARD_PICKER_NAMESPACE }, blur: true, ignore_alpha: 0.2 }],
  bind: [
    {
      keys: "SUPER + SHIFT + V",
      cmd: "common/shell/tinshell-route.sh clipboard toggle",
      note: "Toggles the picker. Keybind exec has no ~/.local/bin in PATH, so the command is a path under the tree root.",
    },
  ],
}

export default rules
