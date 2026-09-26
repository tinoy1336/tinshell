/**
 * apps/notifications/identity.ts — the notifications surface's Wayland identity
 * names.
 *
 * The compositor selects both surfaces by layer-shell namespace, so the names
 * live here once: the surfaces pass them and the generated compositor rule
 * (apps/notifications/hypr-rules.ts) matches the family through the prefix.
 */

/** Both notification surfaces start with this — the family the `notifications-.*`
 *  blur layer rule selects. */
export const NOTIFICATIONS_NAMESPACE_PREFIX = "notifications-"

/** The notification centre (notification history + inhibitor controls). */
export const NOTIFICATIONS_CENTRE_NAMESPACE = `${NOTIFICATIONS_NAMESPACE_PREFIX}centre`

/** The transient popup overlay every notification is drawn in. */
export const NOTIFICATIONS_POPUP_NAMESPACE = `${NOTIFICATIONS_NAMESPACE_PREFIX}popup`
