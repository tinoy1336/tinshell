/**
 * apps/notes/hypr-rules.ts — the notes window's compositor rules (generated into
 * the compositor config by `npm run gen:hypr-rules`, see common/hyprland/rule).
 *
 * Floats + rounds a note; the frost is the compositor's global blur showing
 * through the translucent window (a window rule has no per-window blur key).
 * `size` is pinned on purpose — see `ConfigMapSize`.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { appIdPattern } from "../../common/hyprland/rule.ts"
import { NOTES_APP_ID } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "notes",
  identityModule: "apps/notes/identity.ts",
  window: [
    {
      name: "notes-float",
      match: { class: appIdPattern(NOTES_APP_ID) },
      float: true,
      rounding: 14,
      size: { app: "notes", fallback: { width: 250, height: 250 } },
      decorate: true,
      border_size: 1,
    },
  ],
}

export default rules
