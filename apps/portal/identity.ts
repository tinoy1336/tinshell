/**
 * apps/portal/identity.ts — the portal dialog's Wayland identity name.
 *
 * The compositor selects the FileChooser dialog by app_id, so the name lives
 * here once: the card frame sets it and the generated compositor rule
 * (apps/portal/hypr-rules.ts) matches it through the same constant.
 */

/** The portal's Wayland app_id — the default GTK4 app_id would be the SHELL's
 *  (`io.Astal.shell`), which no per-app rule can select. */
export const PORTAL_APP_ID = "io.Astal.portal"
