/**
 * apps/dock/hypr-rules.ts — the dock's compositor rules (generated into the
 * compositor config by `npm run gen:hypr-rules`, see common/hyprland/rule).
 *
 * The frost comes from the compositor's global blur through these layer rules,
 * and `no_anim` keeps the applet pill and its popups from being animated by the
 * compositor — they animate themselves.
 *
 * The dock also owns the Print key: the capture has to run in the live instance
 * that hosts the screengrab applet, and this fragment is rendered with the dock,
 * so the key travels with the applet host. The workspace keys 10 and 11 follow
 * the workspaces slider applet's step count — the surface that dictates them
 * declares them, so the two cannot drift apart.
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
  bind: [
    {
      keys: "Print",
      cmd: "common/shell/ensure-screengrab.sh",
      note: "Region capture inside the live instance that hosts the screengrab applet — the applet's notification action is dispatched in-process, so the capture has to run there. Keybind exec has no ~/.local/bin in PATH, so the command is a path under the tree root.",
    },
    {
      keys: "SUPER + 0",
      dispatch: { kind: "focus", workspace: 10 },
      note: "Workspace 10 is the 10th step of the dock's workspaces slider: the key exists because the applet renders that many steps.",
    },
    { keys: "SUPER + SHIFT + 0", dispatch: { kind: "move", workspace: 10 } },
    {
      keys: "SUPER + MINUS",
      dispatch: { kind: "focus", workspace: 11 },
      note: "Workspace 11 is the 11th step of the same slider.",
    },
    { keys: "SUPER + SHIFT + MINUS", dispatch: { kind: "move", workspace: 11 } },
  ],
}

export default rules
