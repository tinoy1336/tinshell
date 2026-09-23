/**
 * Registry export-name assertion — PURE module (no gi:// imports), so it is
 * importable by a plain-Node probe as well as by common/host/registry.ts.
 *
 * apps.json + common/host/registry.ts declare, per app, the EXPORT NAMES the
 * host resolves on the app's mount module (`mount`, optional `css`, optional
 * `unmount`). A wrong declared name (e.g. `mount: "emojiMount"` when the
 * module exports `mountEmoji`) resolves `undefined`: the host calls
 * `undefined()`, the lazy loader catches the TypeError, logs it to the
 * journal, resolves `ensureLoaded` false — and the request still answers
 * `"ok"` with no window. Silent.
 *
 * The guard turns that class of typo into a named failure at the single point
 * where a module is first resolved, so the mount/css/unmount declaration is
 * validated against the module's real export surface. Two entry points over
 * ONE set of checks:
 *   - `assertModuleExports` throws the named `RegistryExportError` (tests and
 *     tooling that want the failure as an exception).
 *   - `resolveModuleExports` logs the same named error through the caller's
 *     sink and returns null instead, so the HOST skips exactly that app: a
 *     misdeclared app must never take an instance down at boot — the rest of
 *     the set still boots and works, and the log line stays loud (it names the
 *     app and every missing export).
 */

interface ExportDecl {
  /** Declared mount export name (required). */
  mount: string
  /** Declared css export name (optional; must be a string when declared). */
  css?: string
  /** Declared unmount export name (optional; must be a function when declared). */
  unmount?: string
}

/** Named error: the app module does not provide the declared export(s). */
export class RegistryExportError extends Error {
  readonly app: string
  readonly missing: string[]
  constructor(app: string, missing: string[]) {
    super(`[registry] app '${app}' module is missing declared export(s): ${missing.join(", ")}`)
    this.name = "RegistryExportError"
    this.app = app
    this.missing = missing
  }
}

/** Declared export names `mod` does not provide (a non-string `css` and a
 *  non-function `unmount` count as missing, exactly like an absent name). */
function missingExports(decl: ExportDecl, mod: Record<string, any> | undefined | null): string[] {
  const missing: string[] = []
  if (!mod || typeof mod[decl.mount] !== "function") missing.push(decl.mount)
  if (decl.css && (!mod || typeof mod[decl.css] !== "string")) missing.push(decl.css)
  if (decl.unmount && (!mod || typeof mod[decl.unmount] !== "function")) missing.push(decl.unmount)
  return missing
}

/**
 * Throw `RegistryExportError` when `mod` does not actually provide the
 * declared exports. `mod` is the resolved app module namespace.
 */
export function assertModuleExports(
  app: string,
  decl: ExportDecl,
  mod: Record<string, any> | undefined | null,
): void {
  const missing = missingExports(decl, mod)
  if (missing.length > 0) throw new RegistryExportError(app, missing)
}

/**
 * The SKIP variant of the guard — the HOST's resolution path. Returns `mod`
 * when every declared export exists; otherwise the named
 * `RegistryExportError` (app + missing export names) goes to `log` and null is
 * returned, so the caller skips that one app and the instance boots without
 * it. Never throws.
 */
export function resolveModuleExports<T extends Record<string, any>>(
  app: string,
  decl: ExportDecl,
  mod: T | undefined | null,
  log: (message: string) => void,
): T | null {
  const missing = missingExports(decl, mod)
  if (missing.length === 0) return mod as T
  log(new RegistryExportError(app, missing).message)
  return null
}
