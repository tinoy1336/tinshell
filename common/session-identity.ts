/**
 * common/session-identity.ts — the session-transition overlay's Wayland
 * identity name.
 *
 * The compositor selects the scrim by layer-shell namespace, so the name lives
 * here once: the surface passes it and the generated compositor rule
 * (common/session-rules.ts) matches it through the same constant. This module
 * holds no GTK import on purpose — the rule generator loads it under plain
 * Node, which is why the constant cannot live in `session.tsx` itself.
 */

/** The scrim's layer-shell namespace; also the window's own CSS class. */
export const SESSION_OVERLAY_NAMESPACE = "session-overlay"
