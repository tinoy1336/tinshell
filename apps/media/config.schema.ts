/**
 * media config schema — TypeBox source of truth (the JSON is generated;
 * keep edits in this file).
 * Generated artifact: apps/media/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 */
import { obj, type Static, Type } from "../../common/config/schema-build.ts"

export const schema = obj({
  appearance: obj({
    cardColour: Type.String(),
    cardAlpha: Type.Number(),
    rounding: Type.Integer({ minimum: 0, maximum: 48 }),
    selectionColour: Type.String(),
    textColour: Type.String(),
    accentColour: Type.String(),
    hoverColour: Type.String(),
    fontSize: Type.Integer({ minimum: 10 }),
    iconSize: Type.Integer({ minimum: 10 }),
  }),
  window: obj({
    width: Type.Integer({ minimum: 400 }),
    height: Type.Integer({ minimum: 240 }),
  }),
  timing: obj({
    autoHideMs: Type.Integer({ minimum: 0 }),
    pollIntervalMs: Type.Integer({ minimum: 250 }),
  }),
  startup: obj({
    dir: Type.String(),
  }),
  view: obj({
    showPlaylist: Type.Boolean(),
    showThumbnail: Type.Boolean(),
    showTimestamps: Type.Boolean(),
  }),
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, string> = {
  appearance: "restart",
  window: "restart",
  timing: "restart",
  startup: "baked",
  view: "live",
}
