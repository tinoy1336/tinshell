/**
 * portal config schema — TypeBox source of truth (the JSON is generated;
 * keep edits in this file).
 * Generated artifact: apps/portal/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 */
import { obj, type Static, Type } from "../../common/config/schema-build.ts"

export const schema = obj({
  appearance: obj({
    cardColour: Type.String(),
    cardAlpha: Type.Number(),
    textColour: Type.String(),
    accentColour: Type.String(),
    selectionColour: Type.String(),
    hoverColour: Type.String(),
    fontSize: Type.Number(),
  }),
  window: obj({
    defaultWidth: Type.Integer({ minimum: 520 }),
    defaultHeight: Type.Integer({ minimum: 360 }),
  }),
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, string> = {
  appearance: "restart",
  window: "restart",
}
