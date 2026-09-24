/**
 * files config schema — TypeBox source of truth (the JSON is generated;
 * keep edits in this file).
 * Generated artifact: apps/files/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 */
import { enumOf, obj, type Static, Type } from "../../common/config/schema-build.ts"

export const schema = obj({
  appearance: obj({
    cardColour: Type.String(),
    cardAlpha: Type.Number(),
    textColour: Type.String(),
    accentColour: Type.String(),
    selectionColour: Type.String(),
    hoverColour: Type.String(),
    fontSize: Type.Number(),
    iconSize: Type.Number(),
  }),
  window: obj({
    width: Type.Integer({ minimum: 520 }),
    height: Type.Integer({ minimum: 360 }),
  }),
  startup: obj({
    dir: Type.String(),
  }),
  view: obj({
    sortDirsFirst: Type.Boolean(),
    iconStyle: enumOf(["glyphs", "theme"]),
    showSize: Type.Boolean(),
    showModified: Type.Boolean(),
  }),
  timing: obj({
    reloadDebounceMs: Type.Integer({ minimum: 50 }),
  }),
  trash: obj({
    useTrash: Type.Boolean(),
    confirm: Type.Boolean(),
  }),
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, string> = {
  appearance: "restart",
  window: "restart",
  startup: "baked",
  view: "live",
  timing: "restart",
  trash: "live",
}
