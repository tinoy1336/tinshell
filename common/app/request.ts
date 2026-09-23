/**
 * Request-token normalization — shared by every app's request handler.
 *
 * ags passes argv as received on the CLI: `ags -i <app> request "config set k v"`
 * sends ONE element ["config set k v"] (the quoted string is not re-split). But
 * a caller may also pass multiple unquoted args → ["config","set","k","v"].
 * Normalize: if an element contains whitespace, split it on whitespace;
 * otherwise treat each argv element as its own token. Empty elements drop.
 */
export function normalizeRequestArgv(argv: string[]): string[] {
  const tokens: string[] = []
  for (const a of argv) {
    if (a.includes(" ")) tokens.push(...a.trim().split(/\s+/).filter(Boolean))
    else if (a) tokens.push(a)
  }
  return tokens
}
