/**
 * navigate-path.probe — reproducible probe for the path resolution the files
 * REQUEST route performs (`apps/files/window.tsx`'s handle `navigate`).
 *
 * Why it exists: `files navigate <path>` hands the RAW request tokens
 * (`apps/files/commands.ts`) to the window handle, and the handle resolves them
 * through `absolutePath` (./fs) before the listing sees them. The resolved
 * value is what the window titles, what the directory monitor watches, what the
 * free-space probe reads and what the enumeration lists — so a resolution that
 * goes missing is invisible on every warm path (open/new resolve before they
 * navigate) and observable nowhere else. The probe drives the REAL
 * `absolutePath` over the token shapes a request can carry and pins the two
 * properties the route depends on:
 *
 *  - the resolved token passes the directory gate while the raw token does not,
 *    and
 *  - two spellings of one directory canonicalize to the same string, which is
 *    what the listing's same-path no-op test compares.
 *
 * Headless: no window, no TINSHELL instance, no display connection — Gio/GLib only.
 * The negative control assumes no directory named `~` sits under the working
 * directory (the repo root when run as documented below).
 *
 * Run:
 *   ags bundle --gtk 4 apps/files/navigate-path.probe.ts /tmp/navigate-path-probe.sh
 *   bash /tmp/navigate-path-probe.sh          # exit 1 on any violated invariant
 */
import GLib from "gi://GLib"
import { absolutePath, checkDir } from "./fs"

const home = GLib.get_home_dir()
const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

// ── a request token resolves to the directory the window will actually show ──
check("`~` resolves to the home directory", absolutePath("~"), home)
check("`~/` resolves to the home directory", absolutePath("~/"), home)
check("`<home>/.` resolves to the home directory", absolutePath(`${home}/.`), home)
check("`<home>/` resolves to the canonical form", absolutePath(`${home}/`), home)
check("a `file://` token resolves to the path", absolutePath(`file://${home}`), home)

// ── the raw token is not a path, so the directory gate must reject it ──
check("the raw `~` token does not pass the directory gate", checkDir("~").ok, false)
check("the resolved token passes the directory gate", checkDir(absolutePath("~")).ok, true)

// ── resolution is idempotent, which the handle's resolve-before-navigate is ──
check("resolving twice is resolving once", absolutePath(absolutePath("~/")), absolutePath("~/"))

// ── the listing's same-path no-op compares RESOLVED paths ──
check(
  "a spelling variant IS the current directory once resolved",
  absolutePath(`${home}/./`) === home,
  true,
)
check("the raw variant is not", `${home}/./` === home, false)

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`navigate-path probe failed: ${failed.length} check(s)`)
