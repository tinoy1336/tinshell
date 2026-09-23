/**
 * Lua string-literal encoding — the ONE owner of the escaping the hyprctl
 * DISPATCH path uses: every command `common/hyprland/dispatch` hands to
 * Hyprland's Lua evaluator (`hl.dsp.exec_cmd(…)`) is encoded here.
 *
 * Three other `hyprctl eval` chunks still build their literal locally, each
 * interpolating a number or an already regex-escaped title rather than free
 * text: `apps/notes/session.ts:51` (`luaEscape`, used at `:88` — it also
 * regex-escapes the title for the rule's `^…$` match, so only its Lua half is
 * this job), `apps/annotate/window.tsx:301` (a long-bracket literal over a slot
 * counter and a monotonic timestamp), and `common/applets/panel-framework.tsx:90`,
 * `:97`, `:110` (literals inside a shell-parsed `hyprctl eval '…'` command
 * line, over the follow_mouse number).
 *
 * A short literal is delimited by `"` (or `'`) and ends at the first unescaped
 * line break, so the encoder must escape the delimiter, the backslash and every
 * control character. The literal is DOUBLE-quoted, which leaves `'` untouched —
 * an argument list that was shell-quoted (`common/subprocess/quote` `shq`)
 * carries both kinds of quote and a literal backslash, and every one of those
 * bytes must come back out of the Lua parser unchanged, because the decoded
 * string is what the `sh -c` behind `hl.dsp.exec_cmd` re-parses.
 *
 * Control characters are emitted as three-digit decimal escapes (`\010` = LF):
 * one rule with no gap over the C0 range, and no dependence on which named
 * escapes the embedded Lua build accepts.
 */
export function luaStringLiteral(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const code = s.charCodeAt(i)
    if (ch === "\\") out += "\\\\"
    else if (ch === '"') out += '\\"'
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString().padStart(3, "0")}`
    else out += ch
  }
  return `${out}"`
}
