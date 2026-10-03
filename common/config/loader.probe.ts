/**
 * Live-set probe — the config store's set path announces what it mutates.
 *
 * Why it exists: `setLive` is the ONE live-mutation primitive, and every set
 * path above it — the store's own `set`, app-store's `set`, and therefore
 * every `<app> config set` — writes the live tree through it. A set that mutates
 * the tree and announces nothing leaves the app's `onConfigChanged` mirrors on
 * the old value until the process restarts, and no warm path shows it: the
 * config file holds the new value, the request replies "ok", and only the live
 * surface keeps the old one. The probe drives a REAL store over a temp dir
 * (never an app's own config) so the announcement is observable on its own:
 *
 *  - a set that changes the value fires the change channel, and the new value
 *    reads back at the path,
 *  - a set of the value already there fires nothing (no spurious redraw),
 *    including an equal-but-freshly-built object or array,
 *  - a set the walk refuses (an intermediate that is not an object) reports
 *    false and fires nothing,
 *  - `applyToLive` keeps announcing, and the stable mirror keeps its identity
 *    across a set and an in-place re-seed,
 *  - the store's own `set()` validates, mutates and persists, and reaches the
 *    listeners with the value already visible on the mirror,
 *  - an identical re-seed announces nothing (the content filter),
 *  - through app-store, `set()` reaches the store's own listeners.
 *
 * The probe reads and writes no live config of this machine and no file inside
 * the repository: its schema, defaults and fixture app directory all live under
 * a scratch root it creates in the temp dir and removes at the end of the run,
 * and it repoints `TINSHELL_HOME` at that root before building the app store,
 * so the fixture app directory is never the repository's own `apps/`.
 *
 * `XDG_CONFIG_HOME` must name a scratch directory as well — GLib resolves the
 * user config dir once per process, before any probe code runs, so a probe
 * cannot repoint it from inside; the probe RUNNER sets it, and a hand run
 * without it fails its "under a scratch root" check instead of writing into
 * `~/.config`.
 *
 * Run (bundled — this module imports GI):
 *   ags bundle --gtk 4 common/config/loader.probe.ts /tmp/loader-probe.sh
 *   XDG_CONFIG_HOME=$(mktemp -d) timeout 90 bash /tmp/loader-probe.sh
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createAppStore } from "@common/config/app-store"
import { createConfigStore } from "@common/config/loader"

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

const join = (...parts: string[]): string => GLib.build_filenamev(parts)
function write(path: string, text: string): void {
  GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755)
  if (!GLib.file_set_contents(path, text)) throw new Error(`cannot write ${path}`)
}
function removeTree(path: string): void {
  const file = Gio.File.new_for_path(path)
  if (!file.query_exists(null)) return
  if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY) {
    const children = file.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    for (;;) {
      const info = children.next_file(null)
      if (!info) break
      removeTree(join(path, info.get_name()))
    }
    children.close(null)
    GLib.rmdir(path)
    return
  }
  GLib.unlink(path)
}

const SCHEMA = {
  type: "object",
  properties: {
    appearance: { type: "object", properties: { accent: { type: "string", "x-tier": "live" } } },
    window: { type: "object", properties: { width: { type: "number", "x-tier": "baked" } } },
    box: { type: "object", additionalProperties: true },
    list: { type: "array", items: { type: "number" } },
  },
}
const DEFAULTS = {
  appearance: { accent: "#abc" },
  window: { width: 800 },
  box: { a: 1, b: { c: 2 } },
  list: [1, 2],
}

const ROOT = join(GLib.get_tmp_dir(), `loader-probe-${GLib.get_monotonic_time()}`)
/** The tree the runner started this process in — captured before the probe
 *  redirects `TINSHELL_HOME`, so the run can assert it wrote nothing there. */
const REPO_ROOT = GLib.getenv("TINSHELL_HOME") ?? ""
GLib.setenv("TINSHELL_HOME", join(ROOT, "tree"), true)
GLib.setenv("XDG_CONFIG_HOME", join(ROOT, "config"), true)

// ── the loader: setLive announces a real change, and only a real change ──

const storeDir = join(ROOT, "store")
write(join(storeDir, "config.schema.json"), JSON.stringify(SCHEMA, null, 2))
write(join(storeDir, "config.defaults.json"), JSON.stringify(DEFAULTS, null, 2))

const store = createConfigStore(storeDir)
let fired = 0
const seen: unknown[] = []
store.onConfigChanged(() => {
  fired++
  seen.push(store.get("appearance.accent"))
})

check("defaults seed the live tree", store.get("appearance.accent"), "#abc")

check("setLive reports success", store.setLive("appearance.accent", "#111"), true)
check("a changing set fires the change channel once", fired, 1)
check("the new value reads back at the path", store.get("appearance.accent"), "#111")

check(
  "setLive of the value already there reports success",
  store.setLive("appearance.accent", "#111"),
  true,
)
check("a no-op set fires nothing", fired, 1)

check("setLive reports success on a second key", store.setLive("window.width", 900), true)
check("and fires the channel", fired, 2)
check("the second key reads back", store.get("window.width"), 900)
check("setLive of the value already there fires nothing again", fired, 2)

check(
  "an equal-but-fresh object is not a change",
  store.setLive("box", { a: 1, b: { c: 2 } }),
  true,
)
check("so it fires nothing", fired, 2)
check("an equal-but-fresh array is not a change", store.setLive("list", [1, 2]), true)
check("so it fires nothing either", fired, 2)
check("a differing object IS a change", store.setLive("box", { a: 1, b: { c: 3 } }), true)
check("and fires", fired, 3)

check(
  "a set under a non-object intermediate is refused",
  store.setLive("appearance.accent.deep", 1),
  false,
)
check("and fires nothing", fired, 3)

store.applyToLive({ appearance: { accent: "#222" }, window: { width: 1 } })
check("applyToLive still announces", fired, 4)
check("applyToLive replaced the tree", store.get("appearance.accent"), "#222")
check("the channel saw the value at the time it fired", seen[seen.length - 1], "#222")

// ── the store's own set path: validated, persisted, announced once ──

let setFired = 0
let setSeen: unknown
let setMirror: unknown
store.onConfigChanged(() => {
  setFired++
  setSeen = store.get("window.width")
  setMirror = store.config.window.width
})

check("set reports ok", store.set("window.width", 810).ok, true)
check("set fires the change channel", setFired, 1)
check("with the new value readable", setSeen, 810)
check("and already visible on the stable mirror", setMirror, 810)

store.set("window.width", 810)
check("set of the value already there fires nothing", setFired, 1)

check("set of an unknown path is rejected", store.set("appearance.nope", "x").ok, false)
check("and fires nothing", setFired, 1)

// ── the moved guarantees: identity and the content filter ──

const held = store.config
check("the mirror is the store's own config object", held, store.config)
check("the whole-config read is the same object", store.all(), store.config)
store.setLive("window.width", 820)
check("the mirror identity survives a set", store.config, held)
store.applyToLive({ appearance: { accent: "#333" }, window: { width: 12 } })
check("the mirror identity survives applyToLive", store.config, held)
check("and the mirror holds the new value", held.window.width, 12)

let reFired = 0
store.onConfigChanged(() => {
  reFired++
})
store.applyToLive({ appearance: { accent: "#333" }, window: { width: 12 } })
check("an identical re-seed fires nothing (the content filter)", reFired, 0)
store.setLive("window.width", 13)
check("a real change still fires", reFired, 1)

// ── app-store: the other set path over the same store ──

const tree = GLib.getenv("TINSHELL_HOME") as string
const appDir = join(tree, "apps", "probeapp")
write(join(appDir, "config.schema.json"), JSON.stringify(SCHEMA, null, 2))
write(join(appDir, "config.defaults.json"), JSON.stringify(DEFAULTS, null, 2))

const app = createAppStore("probeapp")
check("the app store loaded its defaults", app.get("window.width"), 800)

let appFired = 0
let appSeen: unknown
app.store.onConfigChanged(() => {
  appFired++
  appSeen = app.get("window.width")
})

check("app-store set reports ok", app.set("window.width", 830).ok, true)
check("app-store set fires the store's listeners", appFired, 1)
check("with the new value readable", appSeen, 830)
check("and the live object moved", app.all().window.width, 830)

app.set("window.width", 830)
check("app-store set of the value already there fires nothing", appFired, 1)

check("app-store set of an unknown path is rejected", app.set("appearance.nope", "x").ok, false)
check("and fires nothing", appFired, 1)

// ── the scratch tree is the only thing this probe touched ──

const livePath = join(GLib.get_user_config_dir(), "tinshell", "probeapp.json")
check(
  "the app store's live path is under a scratch root, not the repository",
  livePath.startsWith(GLib.get_tmp_dir()) && (REPO_ROOT === "" || !livePath.startsWith(REPO_ROOT)),
  true,
)
check(
  "the repository gained no fixture app directory",
  REPO_ROOT === "" || !GLib.file_test(join(REPO_ROOT, "apps", "probeapp"), GLib.FileTest.EXISTS),
  true,
)
removeTree(ROOT)
check("the scratch root is removed by the run", GLib.file_test(ROOT, GLib.FileTest.EXISTS), false)

// ── verdict ──

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`loader probe failed: ${failed.length} check(s)`)
