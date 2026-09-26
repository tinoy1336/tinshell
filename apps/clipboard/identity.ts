/**
 * apps/clipboard/identity.ts — the clipboard picker's Wayland identity name.
 *
 * The compositor selects the picker by layer-shell namespace, so the name lives
 * here once: the surface passes it and the generated compositor rule
 * (apps/clipboard/hypr-rules.ts) matches it through the same constant.
 */

/** The clipboard picker's layer-shell namespace. */
export const CLIPBOARD_PICKER_NAMESPACE = "clipboard-picker"
