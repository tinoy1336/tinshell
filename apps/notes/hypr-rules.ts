/**
 * apps/notes/hypr-rules.ts — the notes window's compositor rules (generated into
 * the compositor config by `npm run gen:hypr-rules`, see common/hyprland/rule).
 *
 * Floats + rounds a note; the frost is the compositor's global blur showing
 * through the translucent window (a window rule has no per-window blur key).
 * `size` is pinned on purpose — see `ConfigMapSize`.
 *
 * The two keys that open a note are declared here with the window they open;
 * both go through `ensure-new.sh`, which resolves the live instance hosting notes
 * and cold-starts one when none is up.
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
  bind: [
    {
      keys: "SUPER + N",
      cmd: "apps/notes/ensure-new.sh fresh",
      note: "Opens a fresh EMPTY note. Keybind exec has no ~/.local/bin in PATH, so the command is a path under the tree root.",
    },
    {
      keys: "SUPER + SHIFT + N",
      cmd: "apps/notes/ensure-new.sh new",
      note: "Reopens the most recently closed note, or a fresh blank one when there is none.",
    },
  ],
}

export default rules
