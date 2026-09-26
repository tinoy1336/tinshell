/**
 * apps/annotate/hypr-rules.ts — the annotate window's compositor rules
 * (generated into the compositor config by `npm run gen:hypr-rules`, see
 * common/hyprland/rule).
 *
 * Floats + rounds the editor and pins its map size (`ConfigMapSize`). Position
 * is NOT pinned here: annotate cascades itself with a per-open runtime rule
 * registered from its own window code.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { appIdPattern } from "../../common/hyprland/rule.ts"
import { ANNOTATE_APP_ID } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "annotate",
  identityModule: "apps/annotate/identity.ts",
  window: [
    {
      name: "annotate-float",
      match: { class: appIdPattern(ANNOTATE_APP_ID) },
      float: true,
      rounding: 14,
      size: { app: "annotate", fallback: { width: 630, height: 450 } },
      decorate: true,
      border_size: 1,
    },
  ],
}

export default rules
