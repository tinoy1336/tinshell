/**
 * launcher config schema — TypeBox source of truth (the JSON is generated —
 * keep edits in this file).
 * Generated artifact: apps/launcher/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 */
import { arr, enumOf, obj, type Static, Type } from "../../common/config/schema-build.ts"

export const schema = obj({
  window: obj({
    width: Type.Number({ minimum: 0.05, maximum: 1 }),
    maxWidth: Type.Integer({ minimum: 200 }),
  }),
  /** Result entries the card shows before it SCROLLS instead of growing
   *  (`@common/scroll` + `Launcher.tsx`). */
  listHeight: Type.Integer({ minimum: 1, maximum: 20 }),
  sources: obj({
    applications: Type.Boolean(),
    calc: Type.Boolean(),
    time: Type.Boolean(),
    units: Type.Boolean(),
    bangs: Type.Boolean(),
    emoji: Type.Boolean(),
  }),
  calc: obj({
    debounceMs: Type.Integer({ minimum: 0 }),
    timeoutMs: Type.Integer({ minimum: 100 }),
  }),
  currency: obj({
    cacheMs: Type.Integer({ minimum: 0 }),
    timeoutMs: Type.Integer({ minimum: 100 }),
  }),
  bangs: obj({
    browserFirefox: Type.String(),
    browserChromium: Type.String(),
    searchUrl: Type.String(),
  }),
  grid: obj({
    columns: Type.Integer({ minimum: 2, maximum: 16 }),
    glyphSize: Type.Integer({ minimum: 12, maximum: 64 }),
    /** Rows of the emoji grid visible at once — the rest of the matches scroll
     *  (the grid is uncapped: every match the search returns is rendered). */
    visibleRows: Type.Integer({ minimum: 1, maximum: 12 }),
  }),
  insert: obj({
    mode: enumOf(["paste", "type", "copy"]),
    typer: enumOf(["wtype", "ydotool"]),
    delayMs: Type.Integer({ minimum: 0, maximum: 2000 }),
    restoreClipboard: Type.Boolean(),
    restoreDelayMs: Type.Integer({ minimum: 0, maximum: 5000 }),
    /** Window classes whose paste chord is Ctrl+Shift+V (terminals). */
    terminalClasses: arr(Type.String(), 0, 64),
  }),
  recents: obj({
    /** Cap of the persisted usage map. */
    max: Type.Integer({ minimum: 1, maximum: 200 }),
    /** How many recents the empty-query glyph grid shows. */
    limit: Type.Integer({ minimum: 1, maximum: 64 }),
  }),
  appearance: obj({
    accentColour: Type.String({ minLength: 4, maxLength: 32 }),
    selectionColour: Type.String({ minLength: 4, maxLength: 64 }),
    hoverColour: Type.String({ minLength: 4, maxLength: 64 }),
  }),
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, string> = {
  grid: "baked",
  appearance: "baked",
}
