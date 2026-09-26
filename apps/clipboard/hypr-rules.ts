/**
 * apps/clipboard/hypr-rules.ts — the clipboard picker's compositor rules
 * (generated into the compositor config by `npm run gen:hypr-rules`, see
 * common/hyprland/rule).
 *
 * Frosted glass: the picker is its own popup surface, so its frost is its own
 * rule rather than the dock's.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { CLIPBOARD_PICKER_NAMESPACE } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "clipboard",
  identityModule: "apps/clipboard/identity.ts",
  layer: [{ match: { namespace: CLIPBOARD_PICKER_NAMESPACE }, blur: true, ignore_alpha: 0.2 }],
}

export default rules
