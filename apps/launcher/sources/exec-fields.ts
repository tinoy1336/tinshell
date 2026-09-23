/**
 * Exec field codes — the freedesktop `Exec` key's placeholders expanded
 * against a LAUNCH CONTEXT.
 *
 * The desktop entry spec allows an Exec to carry field codes instead of fixed
 * arguments: `%f`/`%F` (local files), `%u`/`%U` (URLs), `%c` (the entry's
 * name), `%k` (the entry's .desktop path), `%i` (the entry's icon, as
 * `--icon <icon>`), `%%` (a literal `%`). A launch that carries no file has
 * nothing to expand the file codes into, and the spec has no empty-argument
 * form for them: the argument is OMITTED.
 *
 * Pure (no gi, no GTK): the launcher parses the entry's Exec into argv with
 * `GLib.shell_parse_argv` and hands the argv here; the result is joined back
 * into the shell command the pinned launch runs. Kept separate from the
 * launcher's row/entry code so its semantics are assertable without a session
 * (see exec-fields.probe.ts).
 */

/** What the launch carries, per placeholder family. */
export interface ExecFields {
  /** Local files: `%f` (one), `%F` (all). A launch with no file omits both. */
  files?: string[]
  /** URLs: `%u` (one), `%U` (all). A launch of a local file passes its URI. */
  urls?: string[]
  /** The entry's name (`%c`). */
  name?: string
  /** The themed icon the entry declares (`%i`); absent = both args omitted. */
  iconName?: string | null
  /** The entry's own .desktop path (`%k`). */
  desktopPath?: string | null
}

/** Deprecated in the spec, dropped on sight: `%d %D %n %N %v %m`. */

/**
 * Expand every token's field codes. A token whose codes all expand away is
 * DROPPED with its argument (spec: the argument is omitted, never empty), and
 * the multi-value codes expand to one argument per value.
 */
export function expandExec(argv: string[], fields: ExecFields = {}): string[] {
  const out: string[] = []
  for (const token of argv) {
    if (!token.includes("%")) {
      out.push(token)
      continue
    }
    const alone = expandAlone(token, fields)
    if (alone) {
      out.push(...alone)
      continue
    }
    const text = expandText(token, fields)
    if (text !== "") out.push(text)
  }
  return out
}

/** A code that IS the whole token, so it may expand to several arguments —
 *  `null` when the token is not exactly one code. */
function expandAlone(token: string, fields: ExecFields): string[] | null {
  const files = fields.files ?? []
  const urls = fields.urls ?? []
  switch (token) {
    case "%f":
      return files.length > 0 ? [files[0]] : []
    case "%F":
      return files
    case "%u":
      return urls.length > 0 ? [urls[0]] : []
    case "%U":
      return urls
    case "%c":
      return fields.name ? [fields.name] : []
    case "%k":
      return fields.desktopPath ? [fields.desktopPath] : []
    case "%i":
      return fields.iconName ? ["--icon", fields.iconName] : []
    default:
      return null
  }
}

/** Codes embedded in a longer token: substituted into the token's text (a
 *  multi-valued code joins with a space, the spec's own reading of an
 *  embedded placeholder). */
function expandText(token: string, fields: ExecFields): string {
  let out = ""
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]
    if (ch !== "%") {
      out += ch
      continue
    }
    const code = token[i + 1]
    if (code === undefined) {
      out += "%"
      continue
    }
    i++
    out += codeText(code, fields)
  }
  return out
}

function codeText(code: string, fields: ExecFields): string {
  const files = fields.files ?? []
  const urls = fields.urls ?? []
  switch (code) {
    case "%":
      return "%"
    case "f":
      return files[0] ?? ""
    case "F":
      return files.join(" ")
    case "u":
      return urls[0] ?? ""
    case "U":
      return urls.join(" ")
    case "c":
      return fields.name ?? ""
    case "k":
      return fields.desktopPath ?? ""
    case "i":
      return fields.iconName ? `--icon ${fields.iconName}` : ""
    default:
      return ""
  }
}
