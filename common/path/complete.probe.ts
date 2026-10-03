/**
 * complete.probe — path expansion, globbing and enumeration
 * (common/path/complete.ts).
 *
 * Every typed path in the suite runs through this module: the launcher's `!p`
 * bang and its Tab cycle, promptd's input dialog, the dock's screengrab
 * save-location row, the card path bar's Ctrl-L entry. Its failures are quiet —
 * a tilde form that stops expanding opens nothing, a glob that stops matching
 * offers no rows, an enumeration that follows the wrong shape suggests a file
 * the user cannot commit. The probe builds its OWN fixture directory under the
 * temp dir (including a name with a space), drives every form against it, and
 * removes it in a `finally`.
 *
 * Relative-prefix resolution is asserted through `expandPath`, which resolves
 * against the working directory; completion itself is driven on absolute paths
 * so the result does not depend on where the probe was started.
 *
 * Run (bundled — this module imports Gio/GLib):
 *   ags bundle --gtk 4 common/path/complete.probe.ts /tmp/complete-probe.sh
 *   timeout 90 bash /tmp/complete-probe.sh
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import {
  completePath,
  expandPath,
  expandTilde,
  GLOB_MAX_RESULTS,
  globPath,
  isGlobQuery,
  isPathShaped,
} from "./complete.ts"

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}

const home = GLib.get_home_dir()
const cwd = GLib.get_current_dir()

// ── tilde expansion: tilde ONLY ──
check("a bare tilde is home", expandTilde("~"), home)
check("*/x is home/x", expandTilde("~/x"), `${home}/x`)
check("a relative path is left alone", expandTilde("a/b"), "a/b")
check("an empty string stays empty", expandTilde(""), "")
check("a tilde mid-path is not expanded", expandTilde("/a/~/b"), "/a/~/b")

// ── the absolute form ──
check("an empty path expands to home", expandPath(""), home)
check("a bare tilde expands to home", expandPath("~"), home)
check("~/x expands under home", expandPath("~/x"), `${home}/x`)
check(
  "a relative prefix resolves against the working directory",
  expandPath("somefile"),
  `${cwd}/somefile`,
)
check("a relative path with a slash resolves too", expandPath("a/b"), `${cwd}/a/b`)

// ── the shape rule and the glob rule ──
for (const shaped of ["/x", "~/x", "./x", "../x"])
  check(`'${shaped}' is path-shaped`, isPathShaped(shaped), true)
for (const unshaped of ["music", "", "hello world"])
  check(`'${unshaped}' is not path-shaped`, isPathShaped(unshaped), false)
for (const glob of ["*", "a*", "?x", "x/?y"])
  check(`'${glob}' is a glob query`, isGlobQuery(glob), true)
for (const plain of ["abc", "", "a b"])
  check(`'${plain}' is not a glob query`, isGlobQuery(plain), false)

// ── the fixture ──
const dir = GLib.build_filenamev([
  GLib.get_tmp_dir(),
  `tinshell-complete-probe-${GLib.get_monotonic_time()}`,
])
const spaced = GLib.build_filenamev([dir, "beta dir"])
const writer = (path: string, body: string): void => {
  const file = Gio.File.new_for_path(path)
  file.replace_contents(
    new TextEncoder().encode(body),
    null,
    false,
    Gio.FileCreateFlags.REPLACE_DESTINATION,
    null,
  )
}

try {
  GLib.mkdir_with_parents(GLib.build_filenamev([dir, "alpha"]), 0o755)
  GLib.mkdir_with_parents(spaced, 0o755)
  writer(GLib.build_filenamev([dir, "apple.txt"]), "a")
  writer(GLib.build_filenamev([dir, "apricot.md"]), "b")
  writer(GLib.build_filenamev([spaced, "note.txt"]), "c")
  for (let i = 0; i < GLOB_MAX_RESULTS + 3; i++) {
    writer(GLib.build_filenamev([dir, `match-${String(i).padStart(3, "0")}.txt`]), "x")
  }

  // ── enumeration ──
  const named = completePath(`${dir}/ap`)
  check("a prefix suggests both matches", named.map((s) => s.name).sort(), [
    "apple.txt",
    "apricot.md",
  ])
  check(
    "a suggestion is absolute",
    named.every((s) => s.path.startsWith(dir)),
    true,
  )
  check(
    "a file suggestion is not marked as a directory",
    named.every((s) => !s.isDir),
    true,
  )

  const dirs = completePath(`${dir}/`, { dirsOnly: true })
  check("dirsOnly lists the directories", dirs.map((s) => s.name).sort(), ["alpha", "beta dir"])
  check(
    "dirsOnly marks them as directories",
    dirs.every((s) => s.isDir),
    true,
  )

  const spacedHit = completePath(`${dir}/beta`)
  check(
    "a directory with a space is suggested",
    spacedHit.map((s) => s.name),
    ["beta dir"],
  )
  check("its path keeps the space", spacedHit[0].path, spaced)

  check("an unmatched prefix suggests nothing", completePath(`${dir}/zz`).length, 0)
  check(
    "no trailing slash on a suggested directory",
    completePath(`${dir}/a`).some((s) => s.path.endsWith("/")),
    false,
  )

  // ── globbing ──
  const globbed = globPath(`${dir}/match-*.txt`)
  check("a glob is capped at the documented bound", globbed.suggestions.length, GLOB_MAX_RESULTS)
  check("a glob reports how many matches the cap hid", globbed.hidden, 3)
  check(
    "a glob's suggestions are files in that directory",
    globbed.suggestions.every((s) => s.path.startsWith(dir) && !s.isDir),
    true,
  )
  const narrow = globPath(`${dir}/apple.*`)
  check("a narrow glob matches only what it names", narrow.suggestions.length, 1)
  check("the match is the file", narrow.suggestions[0].name, "apple.txt")
  check("a glob with no match is empty", globPath(`${dir}/nothing-*.txt`).suggestions.length, 0)
  check("the glob cap is a positive count", GLOB_MAX_RESULTS > 0, true)

  // ── the negative direction: a directory that does not exist enumerates nothing ──
  check("a missing directory suggests nothing", completePath(`${dir}/gone/deep`).length, 0)
} finally {
  const remove = (path: string): void => {
    const file = Gio.File.new_for_path(path)
    if (!file.query_exists(null)) return
    if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY) {
      const children = file.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
      for (;;) {
        const info = children.next_file(null)
        if (!info) break
        remove(GLib.build_filenamev([path, info.get_name()]))
      }
      children.close(null)
      GLib.rmdir(path)
      return
    }
    GLib.unlink(path)
  }
  remove(dir)
  check("the fixture directory is gone", GLib.file_test(dir, GLib.FileTest.EXISTS), false)
}

const failed = checks.filter(
  ([, actual, expected]) => JSON.stringify(actual) !== JSON.stringify(expected),
)
for (const [name, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`complete probe failed: ${failed.length} check(s)`)
