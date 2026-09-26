/**
 * apps/portal/hypr-rules.ts — the portal dialog's compositor rules (generated
 * into the compositor config by `npm run gen:hypr-rules`, see
 * common/hyprland/rule).
 *
 * Floats + rounds the FileChooser dialog; the frost is the compositor's global
 * blur through the translucent window. `size` is pinned on purpose — see
 * `ConfigMapSize`.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { appIdPattern } from "../../common/hyprland/rule.ts"
import { PORTAL_APP_ID } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "portal",
  identityModule: "apps/portal/identity.ts",
  window: [
    {
      name: "portal-float",
      match: { class: appIdPattern(PORTAL_APP_ID) },
      float: true,
      rounding: 14,
      size: { app: "portal", fallback: { width: 630, height: 420 } },
      decorate: true,
      border_size: 1,
    },
  ],
}

export default rules
