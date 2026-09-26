/**
 * apps/files/identity.ts — the files window's Wayland identity name.
 *
 * The compositor selects the files window by app_id, so the name lives here
 * once: the card frame sets it and the generated compositor rule
 * (apps/files/hypr-rules.ts) matches it through the same constant.
 */

/** Files' Wayland app_id — the default GTK4 app_id would be the SHELL's
 *  (`io.Astal.shell`), which no per-app rule can select. */
export const FILES_APP_ID = "io.Astal.files"
