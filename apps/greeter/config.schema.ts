/**
 * greeter config schema — TypeBox source of truth (converted from the
 * hand-written JSON; keep edits in this file).
 * Generated artifact: apps/greeter/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 */
import { arr, obj, type Static, Type } from "../../common/config/schema-build.ts"

export const schema = obj({
  defaultUser: Type.String(),
  defaultSession: Type.String(),
  appearance: obj({
    timeFormat: Type.String(),
    dateFormat: Type.String(),
    clockVisible: Type.Boolean(),
    sessionPickerVisible: Type.Boolean(),
    userFieldVisible: Type.Boolean(),
    cardWidth: Type.Integer({ minimum: 280, maximum: 900 }),
    fieldWidth: Type.Integer({ minimum: 180, maximum: 700 }),
  }),
  dock: obj({
    // REAL dock applet subset (@common/applets), ordered.
    // Appearance/geometry knobs (iconSize, pillHeight, spacing, colours) come
    // from the dock's BUNDLED DEFAULTS (strip/Strip.tsx passes them as the
    // hosted applets' live config view) — the greeter owns no config store.
    // Only host placement is configurable here.
    applets: arr(Type.String(), 1),
    marginBottom: Type.Integer({ minimum: 0, maximum: 200 }),
  }),
})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, never> = {}
