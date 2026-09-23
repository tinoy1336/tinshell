/**
 * annotate config schema — TypeBox source of truth (the JSON is generated;
 * keep edits in this file).
 * Generated artifact: apps/annotate/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 */
import { arr, openObj, type Static, Type } from "../../common/config/schema-build.ts"

export const schema = openObj({
  appearance: openObj({
    cardColour: Type.String(),
    cardAlpha: Type.Number(),
    textColour: Type.String(),
    accentColour: Type.String(),
    selectionColour: Type.String(),
    hoverColour: Type.String(),
    fontSize: Type.Number(),
  }),
  window: openObj({
    defaultWidth: Type.Integer(),
    defaultHeight: Type.Integer(),
  }),
  tools: openObj({
    lineWidth: Type.Number(),
    fontSize: Type.Number(),
    colours: arr(Type.String()),
  }),
  export: openObj({
    suffix: Type.String(),
    copyToClipboard: Type.Boolean(),
  }),
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, string> = {
  appearance: "restart",
  window: "restart",
}
