/**
 * common/host/entry — the UNIVERSAL entry point (tinshell-host distributor).
 * ONE static file serves EVERY instance shape: singleton
 * islands, arbitrary combos, and the full shell preset. The app set is
 * selected at RUNTIME from the environment — no code is ever generated:
 *
 *   TINSHELL_HOST_SET="dock,notifications" TINSHELL_HOST_INSTANCE="dock.notifications"
 *   TINSHELL_SHELL=0|1  (set by tinshell-host.sh — see the rule below)
 *
 * Instance composition rules:
 *   - Eager members (non-lazy, or lazy IN the set): dynamic imports resolved
 *     at TOP LEVEL, BEFORE createApp — portal's ownName() claims the impl
 *     name at module import time, before Gtk init (a Gtk-init-first order
 *     blocks ~25s on the portal Settings interface while the frontend waits
 *     for our name). Eager members are
 *     NEVER imported inside main().
 *   - Lazy NOT in set: registered via registerLazyApp (the lazy registration
 *     contract in common/host/registry.ts: graceMs 60s) — loaded on first
 *     request, unloaded
 *     after idle grace.
 *   - TINSHELL_SHELL=1 is set by the HOST script iff the set has an EAGER member
 *     (a surface/service is hosted → resident). WITHOUT it, a loaded lazy
 *     app's last-window close would quit the whole instance (notes.ts:166
 *     `if (!isShell) app.quit()`; scheduleUnload no-ops when notes isn't
 *     registered). A pure-lazy singleton (e.g. `tinshell-host start notes`) has an
 *     EMPTY eager set → nothing is lazy-registered (see below) → TINSHELL_SHELL
 *     unset → quit-on-close live → standalone island semantics. The entry
 *     READS
 *     the flag (via common/app/mode) and warns on a mismatch with its own
 *     computation — the host script is the single writer.
 *   - Unknown app in TINSHELL_HOST_SET = hard error (never silently mount nothing).
 *   - Lazy-app session-restore (common/app/lazy restoreLoadedApps): every
 *     RESIDENT instance that lazy-registers not-in-set apps restores them at
 *     boot — the production shell AND dev islands/combos. Each instance
 *     restores from ITS OWN per-owner loaded-set memory (the shell keeps
 *     lazy-loaded.json; other instances get
 *     lazy-loaded-<instance>.json), plus each lazy app's own durable
 *     open-state signal (notes: state.json — registry restoreIf),
 *     which islands honour only when their own memory file is absent. An
 *     eager notes/files/etc. instance opens its own windows via boot —
 *     restore never touches eager members.
 *   - Eager lazy members boot via registry `boot` hooks (island app.ts main()
 *     parity: cold-start "open <x>" argv, mount order, quit-on-last-window),
 *     and are torn down on the instance quit path (`<instance> quit`) through
 *     their module's `unmount` — the same teardown the lazy loader runs.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { applyAppCss, restoreLoadedApps, unloadAll } from "@common/app/lazy"
import { isShell } from "@common/app/mode"
import { ignore, log } from "@common/log/logger"
import theme from "@common/shell/theme.css"
import { buildStampText, registerBuildStampRequest } from "./build-stamp"
import {
  CANONICAL_ORDER,
  LAZY_APPS,
  REGISTRY,
  registerLazyApps,
  resolveAppModule,
} from "./registry"

// NOTE: no static `ags/gtk4/app` (and no static common/app/start) import — the
// toolkit loads only when the instance actually starts (below).

void (async () => {
  const set = (GLib.getenv("TINSHELL_HOST_SET") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (set.length === 0) {
    throw new Error(
      "[host-entry] TINSHELL_HOST_SET is empty — no apps to host. " +
        "Launch instances via tinshell-host.sh (it always sets TINSHELL_HOST_SET + TINSHELL_HOST_INSTANCE).",
    )
  }
  for (const name of set) {
    if (!REGISTRY[name]) {
      throw new Error(
        `[host-entry] unknown app '${name}' in TINSHELL_HOST_SET='${GLib.getenv("TINSHELL_HOST_SET")}' — ` +
          "not in common/host/registry.ts / apps.json (add it via new-app.sh).",
      )
    }
  }
  const instance = GLib.getenv("TINSHELL_HOST_INSTANCE")
  if (!instance) {
    throw new Error(
      "[host-entry] TINSHELL_HOST_INSTANCE is unset — the host script must always name the instance.",
    )
  }
  const eagerSet = set.filter((a) => !REGISTRY[a].lazy)
  const lazyInSet = set.filter((a) => REGISTRY[a].lazy)
  const lazyNotInSet = LAZY_APPS.filter((a) => !set.includes(a))

  // `<instance> debug build`: which bundle this instance is running and which
  // sources it was built from (the stamp the bundler injected). Instance-keyed
  // like `<instance> quit`, so it adds no namespace of its own — the
  // single-app-host probe in tinshell-host.sh counts namespaces.
  registerBuildStampRequest(instance, () => [`set: ${set.join(",")}`])

  // isShell consistency check (host script owns the flag — see header):
  // resident iff the set hosts any EAGER member (a pure-lazy set is a
  // standalone island → TINSHELL_SHELL unset → quit-on-close live).
  const expectedShell = eagerSet.length > 0
  if (expectedShell !== isShell) {
    console.error(
      `[host-entry] WARNING: TINSHELL_SHELL=${GLib.getenv("TINSHELL_SHELL")} but eager-in-set=` +
        `${eagerSet.join(",") || "(none)"} — instance '${instance}' lifecycle gate may be wrong ` +
        `(expected isShell=${expectedShell}). Launch via tinshell-host.sh.`,
    )
  }

  // Eager modules resolve BEFORE createApp (portal ownName-at-import rule).
  // A member whose declared mount/css/unmount export does not exist on its
  // module is logged (named app + missing export) and SKIPPED: the instance
  // still boots and every other member works (resolveAppModule —
  // common/host/registry-exports).
  const mods: Record<string, Record<string, any>> = {}
  for (const name of CANONICAL_ORDER) {
    if (!eagerSet.includes(name)) continue
    const mod = await resolveAppModule(name)
    if (mod) mods[name] = mod
  }

  // Notifications one-owner diagnostic (island app.ts parity): shout when
  // org.freedesktop.Notifications already has an owner — AstalNotifd fails
  // SILENTLY, so probe the bus BEFORE claiming.
  if (eagerSet.includes("notifications") && !isShell) {
    try {
      const reply = Gio.DBus.session.call_sync(
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "GetNameOwner",
        GLib.Variant.new("(s)", ["org.freedesktop.Notifications"]),
        GLib.VariantType.new("(s)"),
        Gio.DBusCallFlags.NONE,
        2000,
        null,
      )
      if (reply) {
        const who = (reply.deepUnpack() as [string])[0] ?? "unknown"
        console.error(
          `[notifications] WARNING: org.freedesktop.Notifications already owned by ${who} ` +
            `(one-owner rule violated — stop the other instance).`,
        )
      }
    } catch (e) {
      // No owner on the bus — this instance claims the daemon (expected).
      ignore("notifications bus-owner probe", e)
    }
  }

  // CSS: shared theme first, then EAGER members' css in canonical order (each
  // already includes the theme — identical rules, last-wins). Lazy members
  // never join this string: a lazy-not-in-set app injects its own provider on
  // load, and an in-set lazy member (whose module is NOT resolved before
  // createApp) gets the SAME provider through applyAppCss in main() below —
  // one CSS mechanism for every lazy app.
  const cssParts = [theme]
  for (const name of CANONICAL_ORDER) {
    const entry = REGISTRY[name]
    if (entry.css && eagerSet.includes(name)) {
      cssParts.push(mods[name]?.[entry.css] ?? "")
    }
  }

  // Lazy registration is EXACTLY lazyApps \ set — never "all lazy apps,
  // runtime-skipped" (that model silently makes every island a partial
  // shell). And it happens ONLY when the instance is resident (eager
  // member present): a pure-lazy set registers NOTHING — it is a standalone
  // island session (quit-on-close live), and the router cold-starts a fresh
  // instance per request like a run.sh island.
  if (eagerSet.length > 0) registerLazyApps(lazyNotInSet)

  const teardown = async (): Promise<void> => {
    // The lazy apps this instance hosts are torn down here — each one's own
    // unmount IS its teardown (notes flushes + drops its session, media
    // releases MPRIS + stops its pipelines, files destroys the browser).
    // The lazy-not-in-set registrations unload through the loader; an EAGER
    // lazy member (a pure-lazy island's own app, e.g. `tinshell-host start
    // notes`) is not registered with the loader, so its module's unmount is
    // called directly.
    if (lazyNotInSet.length > 0) await unloadAll()
    for (const name of CANONICAL_ORDER) {
      if (!lazyInSet.includes(name)) continue
      const entry = REGISTRY[name]
      if (!entry.unmount) continue
      const mod = await resolveAppModule(name)
      if (!mod) continue
      mod[entry.unmount]()
    }
  }

  // Eager members in canonical order (surfaces first — one-owner names).
  // A member skipped by the export guard has no resolved module and is left
  // unmounted.
  const mountEager = (): void => {
    for (const name of CANONICAL_ORDER) {
      if (!eagerSet.includes(name)) continue
      mods[name]?.[REGISTRY[name].mount]?.()
    }
  }

  // Gtk enters here and only here — `ags/gtk4/app` is imported dynamically by
  // common/app/start.ts.
  const { createApp } = await import("@common/app/start")
  createApp({
    instanceName: instance,
    css: cssParts.join("\n"),
    main(...argv: string[]) {
      mountEager()
      // Startup stamp: which bundle this instance runs and which sources it
      // was built from — the ONE log sink the shell owns receives it (a dev
      // island keeps its own sink). Pre-built artifacts are the launch path
      // (tinshell-warm.service + tinshell-boot.sh warm every artifact), so the state of
      // the artifact a surface is running has to be observable from the
      // surface itself, not only from the filesystem.
      log(`[host-entry] instance '${instance}' (${set.join(",")}): ${buildStampText()}`)
      // Lazy IN-set members mount eagerly via their island-parity boot hooks
      // (cold-start "open <x>" argv forwarded by run.sh → gjs argv → here),
      // with their own stylesheet applied FIRST through the loader's CSS
      // mechanism (applyAppCss): the loader cannot do it here — an in-set
      // member is never lazy-REGISTERED — and cssParts cannot either, because
      // lazy modules are not resolved before createApp. Without it a pure-lazy
      // island boots with the shared theme only. A member the export guard
      // skipped is logged and left unmounted.
      for (const name of CANONICAL_ORDER) {
        if (!lazyInSet.includes(name)) continue
        void (async () => {
          const entry = REGISTRY[name]
          const mod = await resolveAppModule(name)
          if (!mod) return
          if (entry.css) await applyAppCss(name, mod[entry.css])
          if (entry.boot) {
            entry.boot(argv)
          } else {
            mod[entry.mount]()
          }
        })()
      }
      // Lazy-app restore — runs in every resident instance that
      // lazy-registers apps (shell AND dev islands/combos); restoreLoadedApps
      // no-ops when the lazy registry is empty (pure-lazy islands boot via
      // their own lazyInSet hook above and restore nothing). Each instance
      // restores the lazy apps ITS OWN per-owner loaded-set memory records
      // (the shell's lazy-loaded.json; other instances'
      // lazy-loaded-<instance>.json) plus, when its memory is absent or it is
      // the shell, the durable restoreIf signals — so a dock island restart
      // brings notes windows back exactly like a shell restart does.
      void restoreLoadedApps()
    },
    onQuit: teardown,
    // Island quit-on-last-window parity for eager lazy members (files/media
    // app.ts window-removed hook); start.ts gates it on !isShell itself.
    quitOnLastWindow: lazyInSet.some((n) => REGISTRY[n].quitOnLastWindow),
  })
})().catch((e: unknown) => {
  console.error(`[host-entry] FATAL: ${String(e)}`)
  throw e
})
