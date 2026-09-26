/**
 * apps/promptd/hypr-rules.ts — promptd's compositor rules (generated into the
 * compositor config by `npm run gen:hypr-rules`, see common/hyprland/rule).
 *
 * Two surfaces, one owner: promptd's own dialog (frosted glass, like the
 * launcher) and the `yad` fallback window its clients exec when the service is
 * unreachable, which floats instead of tiling.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { PROMPTD_FALLBACK_CLASS, PROMPTD_NAMESPACE } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "promptd",
  identityModule: "apps/promptd/identity.ts",
  layer: [{ match: { namespace: PROMPTD_NAMESPACE }, blur: true, ignore_alpha: 0.2 }],
  window: [
    {
      name: "float-yad",
      match: { class: `^(${PROMPTD_FALLBACK_CLASS})$` },
      float: true,
    },
  ],
}

export default rules
