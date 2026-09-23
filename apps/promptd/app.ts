/**
 * promptd entry point — boots the TINSHELL app via the shared start helper.
 *
 * instanceName "promptd" → owns the io.Astal.promptd bus (addressed via
 * `ags -i promptd request|quit`). This is the DEV island; production runs
 * inside the shell instance — see ./mount.
 *
 * Launch path: run.sh (shared bundler, per-app hashed outfile) — never bare
 * `ags run`. See promptd/AGENTS.md and the root AGENTS.md (multi-app rules).
 */
import { createApp } from "@common/app/start"
import { mountPromptd, promptdCss } from "./mount"

createApp({
  instanceName: "promptd",
  css: promptdCss,
  main() {
    mountPromptd()
  },
})
