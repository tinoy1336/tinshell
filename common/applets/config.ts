/**
 * Applet config contract — the config types the applet layer is built against.
 *
 * Each host supplies its OWN source at mount time through the AppletContext
 * (`config` = the source's live mirror, `store` = the source itself), so the
 * shared machinery and applet mounts never reach for a bound global: the
 * dock passes its config facade, the greeter its bundled defaults.
 *
 * The mirror is LIVE, never a one-time snapshot: applets read
 * `config.appearance.*` / `config.timing.*` inside cairo draw functions and
 * poll callbacks, not only at construction.
 */
import type { AppletConfig } from "./config.schema.ts"

export type { AppletConfig }

/** The config source a host supplies. A `ConfigFacade`
 *  (common/config/facade.ts) satisfies it DIRECTLY — the writer members below
 *  are named after the facade's own (`applyToLive` / `getDefaults` /
 *  `queueWrite`), so a host passes its facade with no adapter. The greeter
 *  passes a plain frozen defaults object with a no-op change channel and no
 *  writer. */
export interface AppletConfigSource {
  readonly config: unknown
  onConfigChanged(cb: () => void): () => void
  /** Replace the live config in place (the settings menus' apply path). */
  applyToLive?(clone: unknown): void
  /** The store's defaults tree. */
  getDefaults?(): unknown
  /** Validate + persist a config tree. */
  queueWrite?(source: unknown): Promise<boolean>
}
