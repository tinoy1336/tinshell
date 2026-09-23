/**
 * dock config schema — TypeBox source of truth (converted from the
 * hand-written JSON; keep edits in this file).
 * Generated artifact: apps/dock/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 *
 * The applet-facing roots (`layout`, `fonts`, `timing`, `appearance`,
 * `screengrab.dir`) are owned by common/applets/config.schema.ts and composed
 * here with the dock-only roots (`applets`, the rest of `screengrab`). The
 * composition preserves the generated property order.
 *
 * Imports stay relative: the generator runs this module under plain Node,
 * which has no tsconfig-paths mapping for `@common`.
 */
import {
  appearance as appletAppearance,
  fonts as appletFonts,
  layout as appletLayout,
  screengrab as appletScreengrab,
  timing as appletTiming,
} from "../../common/applets/config.schema.ts"
import { arr, enumOf, obj, type Static } from "../../common/config/schema-build.ts"

export const schema = obj({
  applets: arr(
    enumOf([
      "performance",
      "battery",
      "media",
      "volume",
      "brightness",
      "screengrab",
      "wifi",
      "bluetooth",
      "lockSession",
      "power",
      "workspaces",
      "keyboard",
    ]),
  ),
  layout: appletLayout,
  fonts: appletFonts,
  timing: appletTiming,
  appearance: appletAppearance,
  screengrab: appletScreengrab,
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, string> = {
  "": "live",
  applets: "baked",
  layout: "baked",
  fonts: "live",
  timing: "live",
  "timing.poll": "restart",
  appearance: "live",
}
