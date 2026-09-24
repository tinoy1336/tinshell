/**
 * files view state — the runtime view filter behind the hidden-entries toggle.
 *
 * One `common/state` store (app "files"), state file
 * `~/.local/state/tinshell/apps/files/state.json`. `showHidden` is not
 * configuration: the browser surface flips it (the header's hidden-entries
 * button, Ctrl+H, `files toggle-hidden`), several times in a session, and the
 * value IS the filter the listing renders with. Persisted in the config file it
 * made every toggle dirty a file the dotfiles repo tracks, so its durable copy
 * lives in the state dir — `~/.config` stays backup-worthy config, while a wipe
 * of `~/.local/state` loses only re-derivable UI intent.
 *
 * The rest of `view.*` (`sortDirsFirst`, `iconStyle`, `showSize`,
 * `showModified`) and `trash.*` stay in config: those are preferences a user
 * sets deliberately, never values the surface writes while it runs.
 */
import { createStateStore } from "@common/state"
import { store as configStore, get as getConfig } from "./config"

const viewState = createStateStore({
  app: "files",
  version: 1,
  keys: { showHidden: (v) => typeof v === "boolean" },
})

/**
 * Whether hidden entries are listed: the store's value when it holds one,
 * otherwise the `view.showHidden` config key a pre-store build persisted it in
 * — still readable after the schema drop, because the loader's initial load
 * merges the live file without schema filtering — otherwise hidden entries are
 * filtered out. A real value therefore always beats the default.
 */
export function showHidden(): boolean {
  const stored = viewState.get("showHidden")
  if (typeof stored === "boolean") return stored
  const legacy = getConfig<boolean | undefined>("view.showHidden")
  return typeof legacy === "boolean" ? legacy : false
}

/** Persist the filter. The caller repaints the windows that render it. */
export function setShowHidden(value: boolean): void {
  viewState.set("showHidden", value)
}

/**
 * Carry the view filter across from the config file it used to be persisted in.
 *
 * The store's own value wins when it has one; otherwise the `view.showHidden`
 * key a pre-store build wrote is copied across, so the filter the browser was
 * in does not change at the switch. The key is then PRUNED from the live tree:
 * the root schema is closed (`additionalProperties: false`), so a leftover
 * unknown key would make the next `files config reload` refuse the file. The
 * prune uses the primitives the app's own config path already uses
 * (`applyToLive` + the serialized write chain) and is idempotent — a second
 * mount finds nothing to drop and writes nothing.
 *
 * Called from `mountFiles`, the files app's own mount: no process that merely
 * reads something from this app writes its config.
 */
export function migrateShowHiddenFromConfig(): void {
  if (typeof viewState.get("showHidden") !== "boolean") {
    const legacy = getConfig<boolean | undefined>("view.showHidden")
    if (typeof legacy === "boolean") viewState.set("showHidden", legacy)
  }
  const live = configStore.config
  const view = live?.view
  if (!view || typeof view !== "object" || !("showHidden" in view)) return
  const clone = JSON.parse(JSON.stringify(live))
  delete clone.view.showHidden
  configStore.applyToLive(clone)
  void configStore.queueWrite(clone)
}
