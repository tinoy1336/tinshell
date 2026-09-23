/**
 * notifications config schema — TypeBox source of truth (the JSON is
 * generated — keep edits in this file).
 * Generated artifact: apps/notifications/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 */
import { arr, obj, type Static, Type } from "../../common/config/schema-build.ts"

export const schema = obj({
  dnd: obj({
    enabled: Type.Boolean(),
  }),
  popup: obj({
    width: Type.Integer({ minimum: 200, maximum: 800 }),
    timeout: Type.Number({ minimum: 0, maximum: 600 }),
    timeoutLow: Type.Number({ minimum: 0, maximum: 600 }),
    timeoutCritical: Type.Number({ minimum: 0, maximum: 600 }),
    maxVisible: Type.Integer({ minimum: 1, maximum: 20 }),
    spacing: Type.Integer({ minimum: 0, maximum: 64 }),
  }),
  centre: obj({
    width: Type.Integer({ minimum: 300, maximum: 1200 }),
    height: Type.Integer({ minimum: 300, maximum: 1600 }),
  }),
  grouping: obj({
    enabled: Type.Boolean(),
  }),
  code: obj({
    apps: arr(Type.String({ minLength: 1 })),
    keywords: obj({
      strong: arr(Type.String({ minLength: 1 })),
      weak: arr(Type.String({ minLength: 1 })),
      context: arr(Type.String({ minLength: 1 })),
    }),
  }),
  appearance: obj({
    cardRgb: arr(Type.Integer({ minimum: 0, maximum: 255 }), 3, 3),
    cardAlpha: Type.Number({ minimum: 0, maximum: 1 }),
    cardAlphaCritical: Type.Number({ minimum: 0, maximum: 1 }),
    radius: Type.Integer({ minimum: 0, maximum: 64 }),
    ink: Type.String({ minLength: 4, maxLength: 32 }),
    muted: Type.String({ minLength: 4, maxLength: 32 }),
    accent: Type.String({ minLength: 4, maxLength: 32 }),
    hoverBg: Type.String({ minLength: 4, maxLength: 64 }),
    focusBg: Type.String({ minLength: 4, maxLength: 64 }),
    closeBg: Type.String({ minLength: 4, maxLength: 64 }),
    closeBgHover: Type.String({ minLength: 4, maxLength: 64 }),
    actionBg: Type.String({ minLength: 4, maxLength: 64 }),
    iconSize: Type.Integer({ minimum: 16, maximum: 128 }),
    thumbnailSize: Type.Integer({ minimum: 40, maximum: 200 }),
    bodyImageRadius: Type.Integer({ minimum: 0, maximum: 32 }),
    summaryFontSize: Type.Integer({ minimum: 8, maximum: 32 }),
    bodyFontSize: Type.Integer({ minimum: 8, maximum: 32 }),
    timeFontSize: Type.Integer({ minimum: 8, maximum: 32 }),
  }),
  behaviour: obj({
    hideOnAction: Type.Boolean(),
  }),
  timing: obj({
    transitionMs: Type.Integer({ minimum: 0, maximum: 2000 }),
    collapseMs: Type.Integer({ minimum: 0, maximum: 2000 }),
  }),
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, string> = {
  dnd: "live",
  popup: "baked",
  centre: "baked",
  grouping: "live",
  code: "live",
  appearance: "baked",
  behaviour: "live",
  timing: "live",
}
