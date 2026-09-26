/**
 * apps/keyboard/hypr-rules.ts — the on-screen keyboard's compositor rules
 * (generated into the compositor config by `npm run gen:hypr-rules`, see
 * common/hyprland/rule).
 *
 * Frosted glass: the keyboard is a translucent layer surface over the desktop.
 * It has no keybind — it is touch-first.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { KEYBOARD_NAMESPACE_PREFIX } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "keyboard",
  identityModule: "apps/keyboard/identity.ts",
  layer: [
    { match: { namespace: `${KEYBOARD_NAMESPACE_PREFIX}.*` }, blur: true, ignore_alpha: 0.2 },
  ],
}

export default rules
