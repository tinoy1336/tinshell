/** Shell-quote a string for inclusion in a bash -c command. Single quotes
 *  handle everything except embedded single quotes, which are escaped —
 *  no shell injection from SSIDs, passwords, paths, or filenames.
 *  A command string built this way and handed to a Lua dispatch must be encoded
 *  as a Lua literal, not re-escaped: see `common/hyprland/lua-string`. */
export function shq(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'"
}
