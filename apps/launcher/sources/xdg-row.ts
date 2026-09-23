/**
 * The ONE "open this with the desktop's own handler" row the path and URL
 * sources offer: `Open — <target>`, described by what the desktop associates
 * with it, activated by spawning `xdg-open <target>`.
 *
 * `xdg-open` resolves the association itself, so the launcher names no handler
 * for the spawn — the description states what the desktop currently associates
 * with the type or scheme, which is a read, not a promise. The spawn is argv
 * form (a target with spaces or quotes stays one token) and returns once the
 * handler has been launched, so the timeout is a spawn budget, not an
 * application budget. A non-zero exit is logged under the caller's `tag` and
 * never surfaced: the row's job ends when the launcher hides.
 */
import { run } from "@common/subprocess/run"
import { log } from "../log"
import type { Result } from "../types"

const XDG_OPEN_TIMEOUT_MS = 10_000

export function xdgOpenRow(o: {
  /** The path or URL handed to xdg-open. */
  target: string
  /** Row title — defaults to `Open — <target>`; a caller states its own when
   *  the row is a bang's (`Search Wikipedia: …`). */
  title?: string
  /** Log-line prefix — the calling source's own name (`paths`, `urls`). */
  tag: string
  /** Secondary line: the handler the desktop associates with the target. */
  description: string
  icon: string
  category: Result["category"]
  /** Mark the row as a BANG PREVIEW row — the launcher gives that kind a
   *  second description line (`../row-caps.ts`). */
  preview?: boolean
}): Result {
  return {
    title: o.title ?? `Open — ${o.target}`,
    description: o.description,
    icon: o.icon,
    category: o.category,
    preview: o.preview,
    run: () => {
      // argv form: no shell, so a target with spaces or quotes stays one token.
      run(["xdg-open", o.target], { timeoutMs: XDG_OPEN_TIMEOUT_MS })
        .then((r) => {
          if (r.exit !== 0) log(`${o.tag}: xdg-open ${o.target} exited ${r.exit}`)
        })
        .catch((e) => log(`${o.tag}: xdg-open ${o.target} failed: ${(e as Error).message}`))
      return true // hide after opening
    },
  }
}
