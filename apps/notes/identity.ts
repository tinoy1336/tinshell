/**
 * apps/notes/identity.ts — the notes window's Wayland identity name.
 *
 * The compositor selects a note window by app_id, so the name lives here once:
 * every note window sets it (common/window/app-id `setAppId`) and the generated
 * compositor rule (apps/notes/hypr-rules.ts) matches it through the same
 * constant.
 */

/** Notes' Wayland app_id — the default GTK4 app_id would be the SHELL's
 *  (`io.Astal.shell`), which no per-app rule can select. */
export const NOTES_APP_ID = "io.Astal.notes"
