import GLib from "gi://GLib"

/**
 * The project's root directory on disk — the ONE place that answers "where does
 * this tree live".
 *
 * TINSHELL_HOME is what names the tree, and the host scripts export it for every
 * instance they spawn, so an app process always sees the checkout it was launched
 * from — wherever that is. When it is unset (a bare `ags run` debug entry, which
 * bypasses the host scripts) the fallback is the default development checkout
 * under the home directory. Every consumer that needs the tree — config
 * schema/defaults, the router script, app assets, launcher spawn targets —
 * resolves it HERE, so a stale path cannot hide in a second copy of this rule.
 */

/** The default development checkout, relative to the home directory — used only
 *  when TINSHELL_HOME is unset. */
const DEV_TREE_RELATIVE = ["dev", "tinshell"]

export function treeRoot(): string {
  const env = GLib.getenv("TINSHELL_HOME")
  if (env && env !== "") return env
  return GLib.build_filenamev([GLib.get_home_dir(), ...DEV_TREE_RELATIVE])
}
