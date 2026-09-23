/**
 * Shared `<app> config get|set|reload|all` request handlers.
 *
 * Every addressable app exposes the same four config subcommands over its
 * request API; this module is the one canonical implementation. Apps call
 * `registerConfigCommands(prefix, api, opts?)` with their own config facade
 * (per-app config.ts) instead of re-rolling handler blocks + a local
 * coerceValue.
 *
 * Standardized reply contract:
 *   config get    <path>   → JSON.stringify(v) | "error: unknown path: <path>"
 *                            | "error: usage: config get <dotted.path>"
 *   config set    <path> <v> → "ok" | "error: <reason>" (schema rejection or
 *                            an {ok:false} set result) | onSet hook reply
 *   config reload           → "reloaded" (a reload rejection surfaces as
 *                            "error: <msg>" via the registry's async catch)
 *   config all              → JSON.stringify(whole config) — registered only
 *                            when api.all is provided
 *
 * Values are coerced to the existing field's type by `coerceValue`
 * (number → Number, boolean → "true"/"1", else the raw string). Apps with
 * extra value shapes pass `opts.coerce`: `createArrayAwareCoerce` is the ONE
 * rule for paths whose value is an ARRAY (a JSON array argument parses, every
 * other path uses `coerceValue`).
 */
import { register } from "./registry"

/**
 * Coerce a CLI string to the existing field's type (per-app convention).
 * `get` reads the current value at `path` to learn the target type.
 */
export function coerceValue(get: (path: string) => any, path: string, raw: string): any {
  const existing = get(path)
  if (typeof existing === "number") {
    const n = Number(raw)
    return Number.isNaN(n) ? raw : n
  }
  if (typeof existing === "boolean") return raw === "true" || raw === "1"
  return raw
}

/**
 * The shared coercion for paths whose current value is an ARRAY: a JSON array
 * argument is parsed, and a non-array argument (or one that will not parse)
 * falls back to the raw string; every other path uses `coerceValue`. `get`
 * reads the current value at `path`, so the rule follows the field's type the
 * same way `coerceValue` does. Pass the result as `opts.coerce`:
 *
 *   registerConfigCommands("keyboard", api, { coerce: createArrayAwareCoerce(api.get) })
 */
export function createArrayAwareCoerce(
  get: (path: string) => any,
): (path: string, raw: string) => any {
  return (path, raw) => {
    if (Array.isArray(get(path))) {
      try {
        const arr = JSON.parse(raw)
        return Array.isArray(arr) ? arr : raw
      } catch {
        return raw
      }
    }
    return coerceValue(get, path, raw)
  }
}

/** The app's config facade, as re-exported by its per-app config.ts. */
interface ConfigCommandsApi {
  /** Dotted-path read (defaults guarantee every known path exists). */
  get: (path: string) => any
  /** Dotted-path write; may return {ok:false,error} for schema rejections. */
  set: (path: string, value: any) => { ok: boolean; error?: string } | void
  /** Re-read config.json + validate (atomic). */
  reloadConfig: () => Promise<void> | void
  /** Whole-config read; when omitted the `config all` command is not registered. */
  all?: () => any
}

interface ConfigCommandsOpts {
  /**
   * Post-set hook (live-tier side effects). A string return replaces the
   * "ok" reply; void keeps it.
   */
  onSet?: (path: string) => string | void
  /**
   * Custom coercion for extra value shapes; defaults to `coerceValue` over
   * api.get.
   */
  coerce?: (path: string, raw: string) => any
}

/** Register the four `<prefix> config …` handlers against the shared registry. */
export function registerConfigCommands(
  prefix: string,
  api: ConfigCommandsApi,
  opts?: ConfigCommandsOpts,
): void {
  const coerce = opts?.coerce ?? ((path: string, raw: string) => coerceValue(api.get, path, raw))

  register([prefix, "config", "get"], (tokens, res) => {
    if (!tokens[0]) return res("error: usage: config get <dotted.path>")
    const v = api.get(tokens[0])
    res(v === undefined ? "error: unknown path: " + tokens[0] : JSON.stringify(v))
  })

  register([prefix, "config", "set"], (tokens, res) => {
    if (tokens.length < 2) return res("error: usage: config set <dotted.path> <value>")
    const value = coerce(tokens[0], tokens.slice(1).join(" "))
    const r = api.set(tokens[0], value)
    if (r && typeof r === "object" && r.ok === false) return res(`error: ${r.error}`)
    const hook = opts?.onSet?.(tokens[0])
    res(hook ?? "ok")
  })

  register([prefix, "config", "reload"], async (_t, res) => {
    await Promise.resolve(api.reloadConfig())
    res("reloaded")
  })

  if (api.all) {
    register([prefix, "config", "all"], (_t, res) => {
      res(JSON.stringify(api.all!()))
    })
  }
}
