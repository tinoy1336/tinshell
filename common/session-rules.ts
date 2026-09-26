/**
 * common/session-rules.ts — the session-transition overlay's compositor rules
 * (generated into the compositor config by `npm run gen:hypr-rules`, see
 * common/hyprland/rule).
 *
 * The full-screen "Locking…"/"Logging out…" scrim (common/session.tsx) carries
 * no CSS frost of its own: the compositor blurs it through this layer rule and
 * `no_anim` puts it on screen at once — the overlay must cover the logind →
 * hypridle → lock-bundle handover, so an animated entrance would show the
 * desktop it is covering.
 */
import type { HyprRuleSet } from "./hyprland/rule.ts"
import { SESSION_OVERLAY_NAMESPACE } from "./session-identity.ts"

const rules: HyprRuleSet = {
  owner: "session",
  identityModule: "common/session-identity.ts",
  layer: [
    {
      match: { namespace: SESSION_OVERLAY_NAMESPACE },
      blur: true,
      ignore_alpha: 0.2,
      no_anim: true,
    },
  ],
}

export default rules
