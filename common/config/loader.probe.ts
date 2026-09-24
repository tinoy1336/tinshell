/**
 * Live-set probe — the config store's set path announces what it mutates.
 *
 * Why it exists: `setLive` is the ONE live-mutation primitive, and every set
 * path above it — the facade's `set`/`setLive`, app-store's `set`, and therefore
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
 *  - `applyToLive` keeps announcing,
 *  - through the facade, `set()` reaches the listeners with the value already
 *    visible on the stable mirror,
 *  - through app-store, `set()` reaches the store's own listeners.
 *
 * The probe reads and writes no live config of this machine: its schema,
 * defaults and live file all live under a scratch dir in the temp dir, and the
 * app-store section is pointed at a scratch tree and config home through
 * TINSHELL_HOME / XDG_CONFIG_HOME.
 *
 * Run:
 *   ags bundle --gtk 4 common/config/loader.probe.ts /tmp/loader-probe.sh
 *   TINSHELL_HOME=/tmp/loader-probe/tree XDG_CONFIG_HOME=/tmp/loader-probe/config \
 *     bash /tmp/loader-probe.sh          # exit 1 on any violated invariant
 */
import GLib from "gi://GLib"
import { createAppStore } from "@common/config/app-store"
import { createConfigFacade } from "@common/config/facade"
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

const ROOT = join(GLib.get_tmp_dir(), "loader-probe")

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

// ── the facade: set() reaches its listeners with the mirror already updated ──

const facade = createConfigFacade(store)
check("the facade mirror starts in sync", facade.config.window.width, 1)

let facadeFired = 0
let facadeSeen: unknown
let facadeMirror: unknown
facade.onConfigChanged(() => {
  facadeFired++
  facadeSeen = facade.get("window.width")
  facadeMirror = facade.config.window.width
})

check("facade set reports ok", facade.set("window.width", 810).ok, true)
check("facade set fires its listeners", facadeFired, 1)
check("with the new value readable through the facade", facadeSeen, 810)
check("and already visible on the stable mirror", facadeMirror, 810)

facade.set("window.width", 810)
check("facade set of the value already there fires nothing", facadeFired, 1)

check("facade set of an unknown path is rejected", facade.set("appearance.nope", "x").ok, false)
check("and fires nothing", facadeFired, 1)

facade.setLive("window.width", 820)
check("facade setLive routes through the same announcement", facadeFired, 2)
check("the mirror follows", facade.config.window.width, 820)

// ── app-store: the other set path over the same store ──

const tree = GLib.getenv("TINSHELL_HOME")
const configHome = GLib.getenv("XDG_CONFIG_HOME")
if (!tree || !configHome) {
  throw new Error("run with TINSHELL_HOME and XDG_CONFIG_HOME pointed at scratch dirs")
}
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
