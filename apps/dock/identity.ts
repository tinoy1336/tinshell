/**
 * apps/dock/identity.ts — the dock's Wayland identity names.
 *
 * The compositor selects the dock's surfaces by layer-shell namespace, so the
 * names live here once: the surfaces pass them, and the generated compositor
 * rules (apps/dock/hypr-rules.ts) match them through the same constants.
 * Renaming one of these is therefore a rename of the surface everywhere.
 */

/** Every dock layer surface starts with this — the family the `dock-.*` blur
 *  and no-animation layer rules select. */
export const DOCK_NAMESPACE_PREFIX = "dock-"

/** The dock band itself — ONE shared surface per monitor. */
export const DOCK_PILL_NAMESPACE = `${DOCK_NAMESPACE_PREFIX}pill`

/** An open applet menu (its scrim shares this one). */
export const DOCK_MENU_NAMESPACE = `${DOCK_NAMESPACE_PREFIX}menu`

/** The invisible full-screen click-catcher behind an open applet menu. */
export const DOCK_MENU_SCRIM_NAMESPACE = `${DOCK_NAMESPACE_PREFIX}menu-scrim`

/** The corner surface a dragged panel is cancelled on. */
export const DOCK_CORNER_NAMESPACE = `${DOCK_NAMESPACE_PREFIX}corner`
