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
    selectionColour: Type.String(),
    textColour: Type.String(),
    accentColour: Type.String(),
    hoverColour: Type.String(),
  }),
  window: obj({
    width: Type.Integer({ minimum: 400 }),
    height: Type.Integer({ minimum: 240 }),
  }),
  timing: obj({
    autoHideMs: Type.Integer({ minimum: 0 }),
    pollIntervalMs: Type.Integer({ minimum: 250 }),
  }),
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, string> = {
  appearance: "restart",
  window: "restart",
  timing: "restart",
}
