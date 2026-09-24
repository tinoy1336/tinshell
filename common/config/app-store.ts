/**
 * app-store — the per-app config binding shared by the on-demand desktop apps.
 *
 * Wraps `createConfigStore` (common/config/loader) with the boilerplate every
 * standalone app needs: the `apps/<name>` dir of this tree, the
 * `get`/`all`/`set`/`reloadConfig` facade, and a rejection sink for
 * schema-rejected writes and failed reloads. The typed config shape stays
 * app-side (cast the `config` object to the app's interface).
 *
 * Reads are direct property accesses on the live `config` object — never
 * cache, since `config set` mutates it in place.
 */
import { appConfigPath, appSchemaDir, type ConfigStore, createConfigStore } from "./loader"

interface AppStore {
  /** The bound ConfigStore (tier metadata, batch validation, change events). */
  store: ConfigStore
  /** The live config object (read properties directly; never cache). */
  config: any
  /** Dotted-path read; `fallback` wins when the path resolves to undefined
   *  (config.defaults.json normally guarantees every known path exists). */
  get<T = any>(path: string, fallback?: T): T
  /** The whole live config object (read-only access by convention). */
  all(): any
  /** Schema-validated dotted-path set + serialized persist. The store's own
   *  `setLive` announces the change, so `store.onConfigChanged` subscribers
   *  see it without a restart. */
  set(path: string, value: any): { ok: boolean; error?: string }
  /** Atomic re-read of config.json + validation. */
  reloadConfig(): Promise<void>
}

/**
 * Bind an app's config store + facade. `opts.onReject` receives schema
 * rejections and reload failures (default: console.warn).
 */
export function createAppStore(
  appName: string,
  opts?: { onReject?: (msg: string) => void },
): AppStore {
  const store: ConfigStore = createConfigStore(appSchemaDir(appName), appConfigPath(appName))
  const reject = (msg: string): void => {
    if (opts?.onReject) opts.onReject(msg)
    else console.warn(msg)
  }

  const config = store.config

  return {
    store,
    config,
    get<T = any>(path: string, fallback?: T): T {
      const v = store.get(path)
      return (v === undefined ? fallback : v) as T
    },
    all(): any {
      return config
    },
    set(path: string, value: any): { ok: boolean; error?: string } {
      const err = store.checkType(path, value)
      if (err) {
        reject(`config set rejected: ${err}`)
        return { ok: false, error: err }
      }
      store.setLive(path, value)
      store.queueWrite(config)
      return { ok: true }
    },
    reloadConfig(): Promise<void> {
      return store.reload().then((r) => {
        if (!r.ok) reject(`config reload failed: ${r.error}`)
      })
    },
  }
}
