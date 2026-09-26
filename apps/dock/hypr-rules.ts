/**
 * apps/dock/hypr-rules.ts — the dock's compositor rules (generated into the
 * compositor config by `npm run gen:hypr-rules`, see common/hyprland/rule).
 *
 * The frost comes from the compositor's global blur through these layer rules,
 * and `no_anim` keeps the applet pill and its popups from being animated by the
 * compositor — they animate themselves.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { DOCK_NAMESPACE_PREFIX, DOCK_PILL_NAMESPACE } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "dock",
  identityModule: "apps/dock/identity.ts",
  layer: [
    { match: { namespace: `${DOCK_NAMESPACE_PREFIX}.*` }, blur: true, ignore_alpha: 0.05 },
    { match: { namespace: `${DOCK_NAMESPACE_PREFIX}.*` }, no_anim: true },
    { match: { namespace: DOCK_PILL_NAMESPACE }, blur: true, ignore_alpha: 0.05 },
  ],
}

export default rules
