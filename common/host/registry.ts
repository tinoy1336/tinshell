/**
 * common/host/registry — the universal entry's static import map.
 *
 * Mirrors common/shell/apps.json (the DATA manifest read by tinshell-host.sh and
 * tinshell-mode.sh) in CODE: esbuild needs constant import specifiers, so every
 * app's module resolution is written out here once. apps.json is the
 * source of truth for NAMES + units + laziness; this file is the source of
 * truth for HOW the entry reaches each app's exports. common/shell/new-app.sh
 * writes BOTH when scaffolding a new app (two sources of truth, one command).
 *
 * Export-name note: the lazy
 * apps export their unmount under the ALIAS name "unmount"
 * (`export { unmountX as unmount }`), polkit exports no css.
 *
 * `boot` (lazy apps only): replicates the per-app island app.ts main() body
 * EXACTLY — mount order + cold-start window opening (argv forwarded from
 * run.sh) — so an eager lazy member of a set behaves byte-identically to
 * `ags run apps/<app>/app.ts`. `unmount` is that member's teardown on the
 * quit path (the entry's `<instance>` quit command), mirroring the island's
 * own `<app> quit`; `quitOnLastWindow` mirrors the
 * window-removed → quit hook the files/media islands connect (live only
 * when NOT isShell).
 */
import GLib from "gi://GLib"
import { registerLazyApp } from "@common/app/lazy"
import { ignore } from "@common/log/logger"
import { appStateFilePath } from "@common/state"
import { assertModuleExports, resolveModuleExports } from "./registry-exports"

interface AppModule {
  [key: string]: any
}

interface RegistryEntry {
  /** Dynamic import with a CONSTANT specifier (esbuild resolves + bundles). */
  mod: () => Promise<AppModule>
  /** Export name of the mount function (from apps.json "mount"). */
  mount: string
  /** Export name of the css string (from apps.json "css"; polkit: none). */
  css?: string
  /** Export name of the unmount hook (from apps.json "unmount") — the lazy
   *  loader's unload teardown AND the entry quit path's teardown for an eager
   *  lazy member. */
  unmount?: string
  /** Lazy desktop app (from apps.json "lazy"). */
  lazy?: boolean
  /** Durable boot-restore signal (restoreLoadedApps): when truthy at boot the
   *  app is restored even without a runtime loaded-set entry. Used by notes
   *  (its state file — XDG-state-dir state.json via common/state — records
   *  the open-window set durably; see notesSessionRestoreWanted). Evaluated
   *  in the production shell on every boot; in a resident island only when
   *  the island's own loaded-set memory file is absent (restoreLoadedApps —
   *  the durable signal is global, so a present memory file must stay
   *  authoritative per island). */
  restoreIf?: () => boolean
  /** Island main() parity for an EAGER lazy member (mount + cold-start argv). */
  boot?: (argv: string[]) => void
  /** Island window-removed → quit hook parity (files, media). */
  quitOnLastWindow?: boolean
}

export const REGISTRY: Record<string, RegistryEntry> = {
  dock: {
    mod: () => import("@apps/dock/mount"),
    mount: "dockMount",
    css: "dockCss",
  },
  launcher: {
    mod: () => import("@apps/launcher/mount"),
    mount: "launcherMount",
    css: "launcherCss",
  },
  notifications: {
    mod: () => import("@apps/notifications/mount"),
    mount: "notificationsMount",
    css: "notificationsCss",
  },
  keyboard: {
    mod: () => import("@apps/keyboard/mount"),
    mount: "keyboardMount",
    css: "keyboardCss",
  },
  clipboard: {
    mod: () => import("@apps/clipboard/mount"),
    mount: "clipboardMount",
    css: "clipboardCss",
  },
  promptd: {
    mod: () => import("@apps/promptd/mount"),
    mount: "mountPromptd",
    css: "promptdCss",
  },
  portal: {
    mod: () => import("@apps/portal/mount"),
    mount: "mountPortal",
    css: "portalCss",
  },
  polkit: {
    mod: () => import("@apps/polkit/mount"),
    mount: "mountPolkit",
  },
  notes: {
    mod: () => import("@apps/notes/mount"),
    mount: "mountNotes",
    css: "notesCss",
    unmount: "unmount",
    lazy: true,
    // Durable restore signal: notes mirrors its open windows in its state
    // file (state.json under the app's XDG state dir via the shared
    // common/state store — survives logout + any XDG_RUNTIME_DIR cleanup),
    // so a host restart restores them even when the runtime loaded-set is
    // empty/missing. Must NOT import notes — the app stays lazy until
    // restore actually loads it.
    restoreIf: notesSessionRestoreWanted,
    boot(argv: string[]): void {
      // notes island app.ts main() parity — openNewNote BEFORE mountNotes.
      void import("@apps/notes/notes").then(({ openNewNote, openNoteByName }) => {
        const [action, name] = argv
        if (action === "open" && name) openNoteByName(name)
        else openNewNote()
        // mountNotes runs AFTER the window opens — see boot sequencing below.
        void import("@apps/notes/mount").then((m) => m.mountNotes())
      })
    },
  },
  files: {
    mod: () => import("@apps/files/mount"),
    mount: "mountFiles",
    css: "filesCss",
    unmount: "unmount",
    lazy: true,
    quitOnLastWindow: true,
    boot(argv: string[]): void {
      // files island app.ts main() parity — mountFiles() then openPath(path).
      void Promise.all([import("@apps/files/mount"), import("@apps/files/window")]).then(
        ([m, w]) => {
          const [action, ...rest] = argv
          const path = action === "open" && rest.length ? rest.join(" ") : undefined
          m.mountFiles()
          w.openPath(path)
        },
      )
    },
  },
  annotate: {
    mod: () => import("@apps/annotate/mount"),
    mount: "mountAnnotate",
    css: "annotateCss",
    unmount: "unmount",
    lazy: true,
    boot(argv: string[]): void {
      // annotate island app.ts main() parity — mountAnnotate() then
      // openEditor(file|null) (bare start opens an empty window).
      void Promise.all([import("@apps/annotate/mount"), import("@apps/annotate/window")]).then(
        ([m, w]) => {
          const [action, file] = argv
          m.mountAnnotate()
          if (action === "open" && file) w.openEditor(file)
          else w.openEditor(null)
        },
      )
    },
  },
  media: {
    mod: () => import("@apps/media/mount"),
    mount: "mountMedia",
    css: "mediaCss",
    unmount: "unmount",
    lazy: true,
    quitOnLastWindow: true,
    boot(argv: string[]): void {
      // media island app.ts main() parity — mountMedia() (MPRIS first)
      // then openPath(path).
      void Promise.all([import("@apps/media/mount"), import("@apps/media/window")]).then(
        ([m, w]) => {
          const [action, ...rest] = argv
          const path = action === "open" && rest.length ? rest.join(" ") : undefined
          m.mountMedia()
          w.openPath(path)
        },
      )
    },
  },

  // ── new-app.sh inserts new REGISTRY entries ABOVE this line ──
}

/** Canonical eager order — surfaces first (one-owner names), then services.
 *  The entry mounts set members in this order; lazy members mount after
 *  the eager ones (they are at the end of the list anyway). */
export const CANONICAL_ORDER = [
  "dock",
  "launcher",
  "notifications",
  "keyboard",
  "clipboard",
  "promptd",
  "portal",
  "polkit",
  "notes",
  "files",
  "annotate",
  "media",
  // ── new-app.sh appends new apps ABOVE this line ──
]

/** The on-demand desktop apps (apps.json "lazy": true). */
export const LAZY_APPS = ["notes", "files", "annotate", "media"]

/** Register every lazy app NOT in the eager set (the shell-preset path).
 *  The lazy registration contract: graceMs 60s, mount/unmount/css resolved
 *  through the registry (module-cache rule:
 *  command handlers register once, forever; mount() re-arms state). */
export function registerLazyApps(notInSet: string[]): void {
  for (const name of LAZY_APPS) {
    if (!notInSet.includes(name)) continue
    const entry = REGISTRY[name]
    registerLazyApp(name, {
      graceMs: 60_000,
      restoreIf: entry.restoreIf,
      load: async () => {
        const m = await entry.mod()
        // Named failure when the declared export names do not exist on the
        // module (the silent `mount: "emojiMount"` bug class) — see
        // ./registry-exports. The loader's loadApp catches this: the app is
        // skipped (state back to unloaded, error logged) and the request that
        // triggered the load answers `error: failed to load app '<name>'` —
        // the instance keeps running.
        assertRegistryExports(name, m)
        return {
          mount: m[entry.mount],
          unmount: entry.unmount ? m[entry.unmount] : () => {},
          css: entry.css ? m[entry.css] : "",
        }
      },
    })
  }
}

/** Resolve an app's module and validate it against this app's DECLARED
 *  export names (`mount` / `css` / `unmount` from REGISTRY). A declaration
 *  that does not match the module is logged as the named
 *  `RegistryExportError` (app + missing export names) and resolves `null` so
 *  the caller SKIPS that app — one misdeclared app must never take the whole
 *  instance down at boot (common/host/registry-exports.resolveModuleExports). */
export async function resolveAppModule(app: string): Promise<AppModule | null> {
  const mod = await REGISTRY[app].mod()
  return resolveModuleExports(app, REGISTRY[app], mod, (message) =>
    console.error(`[registry] ${message} — the app is skipped; the instance boots without it`),
  )
}

/** Assert a resolved app module provides this app's DECLARED export names.
 *  Throws RegistryExportError — the lazy loader's registration path, whose
 *  loadApp catch turns it into a logged skip. */
export function assertRegistryExports(app: string, mod: AppModule): void {
  assertModuleExports(app, REGISTRY[app], mod)
}

// ── notes durable boot-restore predicate ──
// True when the durable session file records ≥1 open note whose file still
// exists (exactly what restoreOnce would re-open). Evaluated by
// restoreLoadedApps at boot in the production shell (always) and in a
// resident island whose own loaded-set memory is absent (per-instance files
// — see common/app/lazy), so notes reopens at a host restart without a first
// request even if the runtime loaded set is missing or was cleared. Reads the
// CANONICAL state file (appStateFilePath("notes") — the common/state store
// path session.ts writes to). Never imports notes — the app stays
// lazy until restore actually loads it.
function notesSessionRestoreWanted(): boolean {
  const restorableIn = (path: string): boolean => {
    try {
      const [ok, contents] = GLib.file_get_contents(path)
      if (!ok || !contents) return false
      const parsed = JSON.parse(new TextDecoder().decode(contents)) as {
        notes?: Array<{ path?: unknown }>
      }
      if (!parsed || !Array.isArray(parsed.notes)) return false
      return parsed.notes.some(
        (n) => typeof n?.path === "string" && GLib.file_test(n.path, GLib.FileTest.EXISTS),
      )
    } catch (e) {
      // A missing/corrupt notes state file means "nothing to restore"; log it
      // because a silent false here is indistinguishable from a real read
      // failure (the notes restore path depends on this predicate).
      ignore("notes restore-state read", e)
      return false
    }
  }
  return restorableIn(appStateFilePath("notes"))
}
