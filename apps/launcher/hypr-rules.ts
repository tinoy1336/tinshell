/**
 * apps/launcher/hypr-rules.ts — the launcher's compositor rules (generated into
 * the compositor config by `npm run gen:hypr-rules`, see common/hyprland/rule).
 *
 * Frosted glass: the compositor blurs the launcher's translucent layer surface.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { LAUNCHER_NAMESPACE } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "launcher",
  identityModule: "apps/launcher/identity.ts",
  layer: [{ match: { namespace: LAUNCHER_NAMESPACE }, blur: true, ignore_alpha: 0.2 }],
}

export default rules
