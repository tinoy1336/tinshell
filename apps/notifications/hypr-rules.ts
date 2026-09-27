/**
 * apps/notifications/hypr-rules.ts — the notifications surface's compositor
 * rules (generated into the compositor config by `npm run gen:hypr-rules`, see
 * common/hyprland/rule).
 *
 * Frosted glass for both notification surfaces: the popup overlay and the
 * centre share one rule, selected by their namespace prefix.
 *
 * The centre's key is declared here too: it routes through the notifications
 * entry point, which resolves the live instance that owns the surface.
 */
import type { HyprRuleSet } from "../../common/hyprland/rule.ts"
import { NOTIFICATIONS_NAMESPACE_PREFIX } from "./identity.ts"

const rules: HyprRuleSet = {
  owner: "notifications",
  identityModule: "apps/notifications/identity.ts",
  layer: [
    { match: { namespace: `${NOTIFICATIONS_NAMESPACE_PREFIX}.*` }, blur: true, ignore_alpha: 0.2 },
  ],
  bind: [
    {
      keys: "SUPER + TAB",
      cmd: "common/shell/tinshell-route.sh notifications toggle-centre",
      note: "Toggles the notifications centre (SUPER + N is the notes key). Keybind exec has no ~/.local/bin in PATH, so the command is a path under the tree root.",
    },
  ],
}

export default rules
