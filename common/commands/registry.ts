/**
 * Hierarchical command registry — the request-dispatch framework.
 *
 * Commands register at import time via `register(path, handler)`. The
 * dispatcher walks registered nodes at request time, finding the first
 * matching handler and passing it the remaining tokens + the response callback.
 *
 * Handlers may be sync or async (returning a Promise). Async rejections and
 * sync throws are caught and surfaced as error responses.
 *
 * Every app uses it: the dock registers deep paths (debug overflow move-drag),
 * the launcher flat top-level commands.
 * Per-app handler modules (config,
 * debug, menu, tablet, toggle, apps) register against this registry; the
 * registry itself is app-agnostic.
 */

// ── Types ──

export type Handler = (args: string[], res: (response: string) => void) => void | Promise<void>

interface CmdNode {
  handler?: Handler
  children: Record<string, CmdNode>
}

// ── Registry ──

const root: Record<string, CmdNode> = {}

/**
 * Register a handler at a path. Intermediate nodes are created automatically.
 * Only one handler per node — re-registering overwrites silently (last wins).
 *
 *   register(["config", "reload"], handleReload)
 */
export function register(path: string[], handler: Handler): void {
  let level = root
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]
    if (!level[seg]) level[seg] = { children: {} }
    level = level[seg].children
  }
  const leaf = path[path.length - 1]
  if (!level[leaf]) level[leaf] = { children: {} }
  level[leaf].handler = handler
}

/** Create nodes WITHOUT a handler — pre-declare a namespace (e.g. a lazy
 *  app's prefix) so `request ""` lists it before its commands register.
 *  Dispatch skips handler-less nodes and walks deeper, so subcommands are
 *  never shadowed (registering a stub handler on the namespace node would
 *  intercept every request for the app). */
export function ensureNamespace(path: string[]): void {
  let level = root
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]
    if (!level[seg]) level[seg] = { children: {} }
    level = level[seg].children
  }
}

/** Is a HANDLER registered at `path`? A namespace stub does not count. Lets a
 *  caller defer to an app that already owns a command — `createApp` uses it to
 *  leave an app's own richer `<instance> quit` in place. */
export function has(path: string[]): boolean {
  let level = root
  for (let i = 0; i < path.length; i++) {
    const node = level[path[i]]
    if (!node) return false
    if (i === path.length - 1) return node.handler !== undefined
    level = node.children
  }
  return false
}

// ── Dispatch ──

/**
 * Walk the command tree for `tokens`, call the first handler found, and pass
 * remaining tokens as args + `res` for the response. When no handler matches,
 * responds with an error listing available commands at that level.
 */
export function dispatch(tokens: string[], res: (response: string) => void): void {
  if (tokens.length === 0) {
    const avail = Object.keys(root).join(", ")
    res(avail ? `available commands: ${avail}` : "no commands registered")
    return
  }

  let level = root
  for (let i = 0; i < tokens.length; i++) {
    const seg = tokens[i]
    const node = level[seg]
    if (!node) {
      const avail = Object.keys(level).join(", ")
      const prefix = tokens.slice(0, i).join(" ")
      const ctx = prefix ? ` under '${prefix}'` : ""
      res(`error: unknown command '${seg}'${ctx}. Available: ${avail}`)
      return
    }
    if (node.handler) {
      callHandler(node.handler, tokens.slice(i + 1), res)
      return
    }
    // Walk deeper
    level = node.children
  }
  // All tokens consumed at a non-leaf → list subcommands.
  const prefix = tokens.join(" ")
  const avail = Object.keys(level).join(", ")
  res(`${prefix}: available subcommands: ${avail}`)
}

/** Call a handler, forwarding the rest of the tokens. Async rejections and
 *  sync throws are caught and surfaced as error responses. */
function callHandler(handler: Handler, args: string[], res: (response: string) => void): void {
  try {
    const result = handler(args, res)
    if (result instanceof Promise) {
      result.catch((e: any) => res(`error: ${e?.message ?? e}`))
    }
  } catch (e: any) {
    res(`error: ${e?.message ?? e}`)
  }
}
