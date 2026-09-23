/**
 * promptd config schema — TypeBox source of truth (the JSON is generated;
 * keep edits in this file).
 * Generated artifact: apps/promptd/config.schema.json (scripts/gen-config-schemas.ts).
 * Loader subset: common/config/loader.ts.
 */
import { obj, type Static } from "../../common/config/schema-build.ts"

export const schema = obj({})

export type Config = Static<typeof schema>

/** x-tier placement (loader ancestor-fallback). "" = the root node. */
export const tiers: Record<string, never> = {}
