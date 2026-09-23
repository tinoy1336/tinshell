/**
 * polkit entry point — boots the TINSHELL app via the shared start helper.
 *
 * instanceName "polkit" → owns the io.Astal.polkit bus (addressed via
 * `ags -i polkit request|quit`). This is the DEV island; production runs
 * inside the shell instance — see ./mount.
 *
 * Launch path: run.sh (shared bundler, per-app hashed outfile) — never bare
 * `ags run`. See polkit/AGENTS.md and the root AGENTS.md (multi-app rules).
 */
import { createApp } from "@common/app/start"
import { mountPolkit } from "./mount"

createApp({
  instanceName: "polkit",
  css: "", // no windows — all UI lives in promptd. Keep empty + commented.
  main() {
    mountPolkit()
  },
})
