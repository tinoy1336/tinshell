import GLib from "gi://GLib"

/**
 * The project's root directory on disk — the ONE place that answers "where does
 * this tree live".
 *
 * TINSHELL_HOME is exported by the host scripts when a launcher sets it up; when
 * it is unset (the running shell does not set it) the dev checkout at
 * ~/dev/tinshell is the truth. Every consumer that needs the tree — config
 * schema/defaults, the router script, app assets, launcher spawn targets —
 * resolves it HERE, so a stale path cannot hide in a second copy of this rule.
 */
export function treeRoot(): string {
  const env = GLib.getenv("TINSHELL_HOME")
  if (env && env !== "") return env
  return GLib.build_filenamev([GLib.get_home_dir(), "dev", "tinshell"])
}
