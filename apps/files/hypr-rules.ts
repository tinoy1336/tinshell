/**
 * apps/files/hypr-rules.ts — the files window's compositor rules (generated into
 * the compositor config by `npm run gen:hypr-rules`, see common/hyprland/rule).
 *
 * Floats the browser; the frost is the compositor's global blur showing through
 * the translucent window. `size` is pinned on purpose — see `ConfigMapSize`.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { appIdPattern } from "../../common/hyprland/rule.ts"
import { FILES_APP_ID } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "files",
  identityModule: "apps/files/identity.ts",
  window: [
    {
      name: "files-float",
      match: { class: appIdPattern(FILES_APP_ID) },
      float: true,
      size: { app: "files", fallback: { width: 620, height: 390 } },
    },
  ],
}

export default rules
