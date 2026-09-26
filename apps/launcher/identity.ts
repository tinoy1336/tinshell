/**
 * apps/launcher/identity.ts — the launcher's Wayland identity name.
 *
 * The compositor selects the launcher's layer surface by namespace, so the name
 * lives here once: the surface passes it and the generated compositor rule
 * (apps/launcher/hypr-rules.ts) matches it through the same constant.
 */

/** The launcher's layer-shell namespace. */
export const LAUNCHER_NAMESPACE = "launcher"
