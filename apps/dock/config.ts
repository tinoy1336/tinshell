/**
 * dock config — the dock app's OWN store (apps/dock/config.{defaults,schema,json})
 * exposed as the dock's config store.
 *
 * The dock runs inside the shell process and standalone as its own island. This
 * module owns the dock's config store (createConfigStore — no shared surface
 * registry) and exports that store itself: consumers call its own vocabulary
 * (`get`, `set`, `tierOf`, `validateBatch`, `queueWrite`, `applyToLive`,
 * `onConfigChanged`, `reload`, …).
 *
 * `config` is the store's stable mirror (identity never changes — see
 * common/config/loader.ts). The tier MECHANISM
 * (metadata + change notification) is per-store; the tier RESPONSE
 * (rebuild/redraw) is registered dock-side via onConfigChanged in
 * commands/config.ts (rebuildDocks/redrawAllDocks). onConfigChanged fires only
 * on DOCK config changes.
 *
 * The typed `Config` shape is DERIVED from the TypeBox schema
 * (config.schema.ts — the source of truth; config.schema.json is generated),
 * not hand-mirrored: editing the schema updates the type.
 */
import { appConfigPath, appSchemaDir, createConfigStore } from "@common/config/loader"
import type { Config } from "./config.schema.ts"

export const dock = createConfigStore(appSchemaDir("dock"), appConfigPath("dock"))

// ── Live config object (typed view of the dock subtree mirror) ──

export const config = dock.config as Config
