/**
 * apps/promptd/identity.ts — the identity names the compositor matches for
 * promptd: its own dialog's layer namespace, and the window class of the
 * fallback dialog its clients exec.
 */

/** promptd's own dialog — the layer-shell namespace of the prompt window. */
export const PROMPTD_NAMESPACE = "promptd"

/** The WM_CLASS of `yad`, the fallback dialog `clients/promptd-client.sh` execs
 *  when promptd is unreachable. The class is yad's own default (the clients pass
 *  no `--class`), so this constant names a foreign program's class rather than
 *  one of our own strings. */
export const PROMPTD_FALLBACK_CLASS = "yad"
