/**
 * common/host/build-stamp — this bundle's build identity, read at runtime.
 *
 * Every wrapper the bundler writes carries the identity of its build
 * (common/shell/bundle-stamp.sh injects `TINSHELL_BUILD_STORE`, the artifact store
 * this bundle belongs to, and `TINSHELL_BUILD_STAMP`, one
 * `<artifact> <fingerprint> <built-at-epoch>` triple), so a running process can
 * state what it is running without reading anything — the identity travels
 * with the bundle, including a copy deployed into /etc/greetd/.
 *
 * The store path travels WITH the bundle and is never resolved here: the store
 * is decided in one place (bundle_store_dir, common/shell/bundle-stamp.sh) and
 * a second spelling in this file would let a running process and the freshness
 * gates disagree about which artifacts exist.
 *
 * The fingerprint is the sha256 `npm run check:builds` re-derives from the
 * current tree, so a bundle that predates an edit is visible from the process
 * itself rather than only from the filesystem. The on-disk comparison covers
 * the second half of that question: a running bundle whose cached stamp has
 * moved on was superseded by a newer build and only a restart loads it.
 */
import GLib from "gi://GLib"
import { register } from "@common/commands/registry"

type BuildStamp = { artifact: string; fingerprint: string; builtAt: number }

/** What the bundle's own store holds for this artifact. */
type DiskStamp =
  | { state: "no-store" }
  | { state: "unreadable" }
  | { state: "read"; fingerprint: string }

/** The stamp the bundler injected into THIS bundle, or null when it was not
 *  built by the bundler (bare `ags run`, a hand-run `ags bundle`). */
export function buildStamp(): BuildStamp | null {
  const raw = GLib.getenv("TINSHELL_BUILD_STAMP")
  if (!raw) return null
  const [artifact, fingerprint, builtAt] = raw.trim().split(" ")
  if (!artifact || !fingerprint) return null
  return { artifact, fingerprint, builtAt: Number(builtAt) || 0 }
}

function localTime(epoch: number): string {
  if (!epoch) return "unknown"
  return GLib.DateTime.new_from_unix_local(epoch).format("%Y-%m-%d %H:%M:%S") ?? "unknown"
}

/** One startup line: what this bundle is, which sources produced it and which
 *  store it came from — a boot running an artifact built into another store
 *  says so on the first line. */
export function buildStampText(): string {
  const stamp = buildStamp()
  if (!stamp) return "built outside the bundler (no build stamp on this bundle)"
  const store = GLib.getenv("TINSHELL_BUILD_STORE")
  const from = store ? ` from store ${store}` : " (no store named on this bundle)"
  return `${stamp.artifact} built from sources ${stamp.fingerprint.slice(0, 12)} at ${localTime(stamp.builtAt)}${from}`
}

/** The fingerprint recorded in this bundle's store stamp sidecar
 *  (`<TINSHELL_BUILD_STORE>/<artifact>/build-stamp.json`), or the reason it could
 *  not be read: a bundle that carries no store (built before the store was
 *  injected) names nothing, and an unreadable sidecar is a deployed bundle
 *  running as another user or an artifact that was never built here. */
function onDiskStamp(artifact: string): DiskStamp {
  const store = GLib.getenv("TINSHELL_BUILD_STORE")
  if (!store) return { state: "no-store" }
  const path = `${store}/${artifact}/build-stamp.json`
  try {
    const [ok, bytes] = GLib.file_get_contents(path)
    if (!ok) return { state: "unreadable" }
    const parsed = JSON.parse(new TextDecoder().decode(bytes as Uint8Array)) as {
      fingerprint?: string
    }
    if (!parsed.fingerprint) return { state: "unreadable" }
    return { state: "read", fingerprint: parsed.fingerprint }
  } catch {
    return { state: "unreadable" }
  }
}

/** The report a `debug build` request answers with. */
export function buildStampLines(): string[] {
  const stamp = buildStamp()
  if (!stamp) {
    return [
      "artifact: (none)",
      "stamp: missing — this bundle was not produced by common/shell/run.sh, apps/greeter/build.sh or apps/greeter/build-lock.sh",
    ]
  }
  const lines = [
    `artifact: ${stamp.artifact}`,
    `fingerprint: ${stamp.fingerprint}`,
    `built: ${localTime(stamp.builtAt)}`,
  ]
  const store = GLib.getenv("TINSHELL_BUILD_STORE")
  lines.push(store ? `store: ${store}` : "store: unknown — this bundle carries no TINSHELL_BUILD_STORE")
  const disk = onDiskStamp(stamp.artifact)
  if (disk.state === "no-store") lines.push("on-disk: unknown (this bundle names no store)")
  else if (disk.state === "unreadable")
    lines.push("on-disk: unknown (no cache stamp sidecar readable)")
  else if (disk.fingerprint === stamp.fingerprint)
    lines.push(`on-disk: matches (${disk.fingerprint.slice(0, 12)})`)
  else
    lines.push(
      `on-disk: DIFFERS (${disk.fingerprint.slice(0, 12)}) — a newer build is cached; a restart loads it`,
    )
  lines.push(
    "freshness: npm run check:builds re-derives every artifact's fingerprint from the sources",
  )
  return lines
}

/** Register `<instance> debug build` — the same instance-keyed shape
 *  `createApp` gives `<instance> quit`, so it adds no namespace of its own.
 *  `extra` supplies host-specific context lines (the host entry adds the set). */
export function registerBuildStampRequest(instance: string, extra?: () => string[]): void {
  register([instance, "debug", "build"], (_args, res) => {
    res([`instance: ${instance}`, ...(extra?.() ?? []), ...buildStampLines()].join("\n"))
  })
}
