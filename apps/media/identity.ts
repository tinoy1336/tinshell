/**
 * apps/media/identity.ts — the media window's Wayland identity names.
 *
 * The compositor selects a media window by app_id and its cascade position by
 * title, so both names live here once: the window sets them and the generated
 * compositor rules (apps/media/hypr-rules.ts) match them through the same
 * constants.
 */

/** Media's Wayland app_id — the default GTK4 app_id would be the SHELL's
 *  (`io.Astal.shell`), which no per-app rule can select. */
export const MEDIA_APP_ID = "io.Astal.media"

/** The window TITLE stem: the first instance is titled exactly this, instance N
 *  is `<stem>-N`. Invisible (the window has no titlebar) and never the file
 *  name — a filename in the title would stop the window matching its cascade
 *  rule. */
export const MEDIA_WINDOW_TITLE = "media"
