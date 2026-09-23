/**
 * notes config schema — TypeBox source of truth (the JSON is generated;
 * keep edits in this file).
 * Generated artifact: apps/notes/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 */
import { obj, openObj, type Static, Type } from "../../common/config/schema-build.ts"

export const schema = openObj({
  appearance: openObj({
    cardColour: Type.String(),
    cardAlpha: Type.Number(),
    textColour: Type.String(),
    caretColour: Type.String(),
    selectionColour: Type.String(),
    fontSize: Type.Number(),
  }),
  window: openObj({
    width: Type.Integer(),
    height: Type.Integer(),
    padding: Type.Integer(),
  }),
  storage: openObj({
    dir: Type.String(),
    maxFiles: Type.Integer({ minimum: 1, maximum: 10000 }),
  }),
  export: openObj({
    defaultDir: Type.String(),
  }),
  timing: openObj({
    saveDebounceMs: Type.Integer(),
  }),
  session: obj({
    enabled: Type.Boolean(),
    pollMs: Type.Integer({ minimum: 250 }),
  }),
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, string> = {
  appearance: "restart",
  window: "restart",
  timing: "restart",
  session: "restart",
}
