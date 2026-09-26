/**
 * apps/media/hypr-rules.ts — the media window's compositor rules (generated into
 * the compositor config by `npm run gen:hypr-rules`, see common/hyprland/rule).
 *
 * Floats + rounds every media window (frost = the compositor's global blur
 * through the translucent window, `size` pinned per `ConfigMapSize`), and
 * cascades instances 2+ so consecutive windows do not stack invisibly.
 */
import type { HyprRuleSet, WindowRuleSpec } from "../../common/hyprland/rule.ts"
import { appIdPattern } from "../../common/hyprland/rule.ts"
import { MEDIA_APP_ID, MEDIA_WINDOW_TITLE } from "./identity.ts"

/** Where the second instance lands and how far each following one steps away
 *  from it — one step right and down per instance. */
const CASCADE_FIRST = { x: 400, y: 40 }
const CASCADE_STEP = 40

/** Instances 2..6 are offset; past that the cascade repeats the last rule (the
 *  window titles are unbounded, the config is not). */
const CASCADE_LIMIT = 6

function cascadeRules(): WindowRuleSpec[] {
  const rules: WindowRuleSpec[] = []
  for (let instance = 2; instance <= CASCADE_LIMIT; instance++) {
    rules.push({
      name: `${MEDIA_WINDOW_TITLE}-${instance}`,
      match: { title: `^${MEDIA_WINDOW_TITLE}-${instance}$` },
      move: {
        x: CASCADE_FIRST.x + CASCADE_STEP * (instance - 2),
        y: CASCADE_FIRST.y + CASCADE_STEP * (instance - 2),
      },
    })
  }
  return rules
}

const rules: HyprRuleSet = {
  owner: "media",
  identityModule: "apps/media/identity.ts",
  note: "The cascade below positions each instance by RULE because the window cannot do it itself: GTK4 has no API to position a window after it is mapped, and the compositor centres every float on the same spot, so instances 2+ would stack invisibly. Each move rule selects one instance by its title.",
  window: [
    {
      name: "media-float",
      match: { class: appIdPattern(MEDIA_APP_ID) },
      float: true,
      rounding: 14,
      size: { app: "media", fallback: { width: 670, height: 380 } },
      decorate: true,
      border_size: 1,
    },
    ...cascadeRules(),
  ],
}

export default rules
