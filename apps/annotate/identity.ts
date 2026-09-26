/**
 * apps/annotate/identity.ts — the annotate window's Wayland identity name.
 *
 * The compositor selects the editor by app_id, so the name lives here once: the
 * card frame sets it and the generated compositor rule
 * (apps/annotate/hypr-rules.ts) matches it through the same constant.
 */

/** Annotate's Wayland app_id — the default GTK4 app_id would be the SHELL's
 *  (`io.Astal.shell`), which no per-app rule can select. */
export const ANNOTATE_APP_ID = "io.Astal.annotate"
