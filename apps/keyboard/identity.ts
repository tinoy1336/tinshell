/**
 * apps/keyboard/identity.ts — the on-screen keyboard's Wayland identity name.
 *
 * The compositor selects the keyboard by layer-shell namespace, so the name
 * lives here once: the surface passes it and the generated compositor rule
 * (apps/keyboard/hypr-rules.ts) matches it through the same constants.
 */

/** The keyboard's surfaces start with this — the family the `keyboard-.*` blur
 *  layer rule selects. */
export const KEYBOARD_NAMESPACE_PREFIX = "keyboard-"

/** The keyboard's one bottom-anchored full-width layer surface. */
export const KEYBOARD_MAIN_NAMESPACE = `${KEYBOARD_NAMESPACE_PREFIX}main`
