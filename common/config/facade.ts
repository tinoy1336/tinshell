/**
 * Config facade — generic app-facing wrapper over a ConfigStore (loader).
 *
 * The store's raw `config` object is REPLACED on reload (applyToLive mutates
 * in place, but reload seeds fresh subtrees), so a held reference would go
 * stale. The facade wraps a store with:
 *   - a STABLE mirror object (`config`) whose identity never changes — app
 *     code holds const references and reads properties live; the mirror is
 *     re-synced IN PLACE from the store's live config on every change.
 *   - change listeners filtered per-store (a facade over one store only ever
 *     fires for that store's changes — no cross-namespace noise).
 *   - the validated set/applyToLive/reload API the config request handlers
 *     and app code share.
 *
 * This is generic infrastructure (like loader.ts) — it knows nothing about
 * which apps exist. Every app with a config store builds its own facade here
 * or in its config.ts; no module enumerates the surface list.
 */
import type { ConfigStore, Tier } from "./loader"

/** Facade over ONE config store. */
export interface ConfigFacade {
  /** Stable mirror of this store's live config (mutated in place). */
  readonly config: any
  get(path: string, fallback?: any): any
  setLive(path: string, value: any): boolean
  checkType(path: string, value: any): string | null
  validateBatch(pairs: { path: string; value: any }[]): {
    ok: boolean
    errors: string[]
  }
  tierOf(path: string): Tier
  applyToLive(clone: any): void
  onConfigChanged(cb: () => void): () => void
  getDefaults(): any
  queueWrite(source: any): Promise<boolean>
  reload(): Promise<{ ok: boolean; error?: string; warnings: string[] }>
  /** Validate + mutate + persist. Returns {ok:false,error} on schema
   *  rejection (the config set handler replies "error: …"), {ok:true} on
   *  success. */
  set(path: string, value: any): { ok: boolean; error?: string }
  /** Whole live config (read-only by convention). */
  all(): any
}

/** Build the facade for one store. One facade per store — module scope in
 *  the owning config.ts, so every importer shares the same instance. */
export function createConfigFacade(store: ConfigStore): ConfigFacade {
  // Stable mirror — the ONE object app code sees as `config`. Identity never
  // changes; syncStable() copies the live config's contents into it in place
  // (the loader replaces subtree objects on reload, so a raw `store.config`
  // reference would go stale).
  const stable: any = {}
  function syncStable(): void {
    const fresh = store.config
    for (const k of Object.keys(stable)) delete stable[k]
    if (fresh) Object.assign(stable, fresh)
  }
  syncStable()

  // Change filter: subscribe once to the base store, fire our listeners only
  // when this store's config's JSON actually changed.
  const listeners: Array<() => void> = []
  let snapshot = JSON.stringify(stable)
  store.onConfigChanged(() => {
    syncStable()
    const next = JSON.stringify(stable)
    if (next !== snapshot) {
      snapshot = next
      for (const cb of listeners) cb()
    }
  })

  function fireChanged(): void {
    snapshot = JSON.stringify(stable)
    for (const cb of listeners) cb()
  }

  return {
    get config() {
      return stable
    },
    get(path, fallback) {
      const v = store.get(path)
      return v === undefined ? fallback : v
    },
    setLive(path, value) {
      const ok = store.setLive(path, value)
      syncStable()
      return ok
    },
    checkType(path, value) {
      return store.checkType(path, value)
    },
    validateBatch(pairs) {
      return store.validateBatch(pairs)
    },
    tierOf(path) {
      return store.tierOf(path)
    },
    applyToLive(clone) {
      // Replace the live config in place, then resync the mirror + fire our
      // listeners.
      const target = store.config
      for (const k of Object.keys(target)) delete target[k]
      Object.assign(target, clone)
      syncStable()
      fireChanged()
    },
    onConfigChanged(cb) {
      listeners.push(cb)
      return () => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    getDefaults() {
      return store.getDefaults()
    },
    queueWrite(source) {
      return store.queueWrite(source)
    },
    reload() {
      return store.reload()
    },
    set(path, value) {
      const err = store.checkType(path, value)
      if (err) return { ok: false, error: err }
      store.setLive(path, value)
      syncStable()
      store.queueWrite(store.config)
      return { ok: true }
    },
    all() {
      return stable
    },
  }
}
