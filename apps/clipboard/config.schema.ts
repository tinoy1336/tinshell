/**
 * clipboard config schema — TypeBox source of truth (the JSON is generated —
 * keep edits in this file).
 * Generated artifact: apps/clipboard/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 */
import { arr, obj, type Static, Type } from "../../common/config/schema-build.ts"

export const schema = obj({
  capture: Type.Boolean(),
  maxEntries: Type.Integer({ minimum: 1, maximum: 500 }),
  persistImages: Type.Boolean(),
  window: obj({
    width: Type.Number({ minimum: 0.05, maximum: 1 }),
    maxWidth: Type.Integer({ minimum: 200 }),
    maxHeight: Type.Integer({ minimum: 120 }),
  }),
  appearance: obj({
    cardRgb: arr(Type.Integer({ minimum: 0, maximum: 255 }), 3, 3),
    cardAlpha: Type.Number({ minimum: 0, maximum: 1 }),
    radius: Type.Integer({ minimum: 0, maximum: 64 }),
    ink: Type.String({ minLength: 4, maxLength: 32 }),
    muted: Type.String({ minLength: 4, maxLength: 64 }),
    accent: Type.String({ minLength: 4, maxLength: 32 }),
    hoverBg: Type.String({ minLength: 4, maxLength: 64 }),
    focusBg: Type.String({ minLength: 4, maxLength: 64 }),
  }),
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, string> = {
  "": "live",
  capture: "restart",
  maxEntries: "live",
  persistImages: "live",
  window: "baked",
  appearance: "baked",
}
