/**
 * keyboard config schema — TypeBox source of truth (the JSON is generated —
 * keep edits in this file).
 * Generated artifact: apps/keyboard/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 */
import { arr, enumOf, obj, type Static, Type } from "../../common/config/schema-build.ts"

export const schema = obj({
  layout: enumOf(["standard", "thumbs"]),
  keyScale: Type.Number(),
  repeat: obj({
    delayMs: Type.Integer(),
    rateHz: Type.Number(),
  }),
  appearance: obj({
    panel: obj({
      rgb: arr(Type.Number({ minimum: 0, maximum: 1 }), 3, 3),
      alpha: Type.Number({ minimum: 0, maximum: 1 }),
    }),
    key: obj({
      rgb: arr(Type.Number({ minimum: 0, maximum: 1 }), 3, 3),
      alpha: Type.Number({ minimum: 0, maximum: 1 }),
    }),
    keyAction: obj({
      rgb: arr(Type.Number({ minimum: 0, maximum: 1 }), 3, 3),
      alpha: Type.Number({ minimum: 0, maximum: 1 }),
    }),
    keyPressed: obj({
      rgb: arr(Type.Number({ minimum: 0, maximum: 1 }), 3, 3),
      alpha: Type.Number({ minimum: 0, maximum: 1 }),
    }),
    text: obj({
      rgb: arr(Type.Number({ minimum: 0, maximum: 1 }), 3, 3),
      alpha: Type.Number({ minimum: 0, maximum: 1 }),
    }),
  }),
  enabled: Type.Boolean(),
  showMode: enumOf(["auto", "show", "hide"]),
  autoTextApps: arr(Type.String()),
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, string> = {
  "": "live",
  layout: "live",
  keyScale: "live",
  repeat: "live",
  appearance: "live",
  enabled: "restart",
  showMode: "live",
  autoTextApps: "live",
}
