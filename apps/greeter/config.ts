/**
 * greeter config — the login screen's knobs + the DOCK config the strip renders.
 *
 * The greeter's own store is bound to the DEPLOYED config dir
 * (/etc/greetd/tinshell-greeter), NOT the user config dir: the greeter runs as the
 * `greeter` user pre-login and cannot read the session user's home. install.sh ships
 * config.defaults.json / config.schema.json / config.json there (read-only for
 * the greeter — the login screen never writes config). Preview mode
 * (TINSHELL_GREETER_PREVIEW=1, run as the session user) reads the same
 * path — before the first deploy the file is absent and the loader falls back
 * to defaults.
 *
 * `dockConfigView()` — the SAME store machinery, over the DOCK's config: the
 * applet strip mounts the shared renderer with the dock's appearance/geometry,
 * and the dock's config module is the one owner of those values. The greeter
 * user cannot read the session user's home, so the view resolves the dock config dir:
 *
 *   1. the dock's own config dir (dev/preview/lock — the LIVE dock config, the
 *      exact values the dock paints; also what `tinshell-mode` dev work reads);
 *   2. /etc/greetd/tinshell-greeter/dock — the deployed copy of the dock's config
 *      trio (install.sh), the pre-login greeter's only route to the live
 *      values.
 *
 * Neither present → there is no honest appearance to paint, so the strip
 * reports the alarm and stays out (the card still maps). A bundled-defaults
 * snapshot is deliberately NOT used: it drifts silently the moment the dock's
 * config changes, which is exactly the "cheap copy" the strip must not be.
 */

import GLib from "gi://GLib"
import type { AppletConfig, AppletConfigSource } from "@common/applets/config"
import { type ConfigFacade, createConfigFacade } from "@common/config/facade"
import {
  appConfigPath,
  appSchemaDir,
  type ConfigStore,
  createConfigStore,
} from "@common/config/loader"
import { log } from "@common/log/logger"

const DIR = "/etc/greetd/tinshell-greeter"

const store: ConfigStore = createConfigStore(DIR)

/** Read a value by dotted path. */
export function get<T = any>(path: string, fallback?: T): T {
  const v = store.get(path)
  return (v === undefined ? fallback : v) as T
}

/** The deployed copy of the dock's config trio (install.sh, root). */
const DEPLOYED_DOCK_CONFIG_DIR = "/etc/greetd/tinshell-greeter/dock"

interface DockConfigView {
  /** The dock's config every hosted applet and the shared renderer read. */
  config: AppletConfig
  /** The applet-facing config source: the facade's live mirror + change
   *  channel, WITHOUT the writer members — a greeter-side applet must never
   *  write into a user's home (the applet contract makes the writers
   *  optional). */
  source: AppletConfigSource
  /** The config dir the values came from (provenance). */
  dir: string
}

/** The values that decide the strip's look — logged so a stale or unexpected
 *  source is visible at a glance. */
function values(config: AppletConfig): string {
  const a = config.appearance
  const rgb = (c: { rgb: number[]; alpha: number }): string =>
    `rgb(${c.rgb.map((n: number) => n.toFixed(4)).join(",")})@${c.alpha}`
  return (
    `disc=${rgb(a.disc)} backdrop=${rgb(a.backdrop)} iconSize=${config.layout.iconSize}` +
    ` pillHeight=${config.layout.pillHeight} spacing=${config.layout.spacing}`
  )
}

/** A config dir is usable when its schema is readable — the loader reads
 *  schema + defaults + live from the dir (a dir without them yields no
 *  values). */
function hasSchema(dir: string): boolean {
  return GLib.file_test(GLib.build_filenamev([dir, "config.schema.json"]), GLib.FileTest.IS_REGULAR)
}

let cached: DockConfigView | null | undefined

/** Resolve the dock config the strip renders (see the module doc). Cached:
 *  the strip is rebuilt with the greeter window, the source never changes
 *  under a running process. */
export function dockConfigView(): DockConfigView | null {
  if (cached !== undefined) return cached
  const dir = [appSchemaDir("dock"), DEPLOYED_DOCK_CONFIG_DIR].find(hasSchema)
  if (!dir) {
    log(
      `[greeter-dock] ALARM: no dock config found (looked in ${appSchemaDir("dock")} and` +
        ` ${DEPLOYED_DOCK_CONFIG_DIR}) — the applet strip stays out rather than painting a stale snapshot.` +
        ` Deploy it: sudo ./install.sh (greeter dir) copies the dock config trio there.`,
    )
    cached = null
    return null
  }
  // The deployed dir carries its own root copy of the live values (install.sh); the tree
  // dir is paired with this machine's flat live file (~/.config/tinshell/dock.json).
  const livePath = dir === DEPLOYED_DOCK_CONFIG_DIR ? undefined : appConfigPath("dock")
  const facade: ConfigFacade = createConfigFacade(createConfigStore(dir, livePath))
  const config = facade.config as AppletConfig
  log(`[greeter-dock] dock config: source=${dir} ${values(config)}`)
  cached = {
    config,
    source: {
      config: facade.config,
      onConfigChanged: (cb) => facade.onConfigChanged(cb),
    },
    dir,
  }
  return cached
}
