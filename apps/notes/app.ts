/**
 * notes entry point — boots the TINSHELL app via the shared start helper.
 *
 * instanceName "notes" → owns the io.Astal.notes bus (addressed via
 * `ags -i notes request|quit`). This is the DEV island: NO systemd unit, the
 * app is launched on demand (SUPER+N / SUPER+SHIFT+N → ensure-new.sh) and quits
 * when the last note closes. Production runs inside the shell instance
 * — see ./mount (there the quit-on-close is disabled).
 *
 * Launch path: run.sh (shared bundler, per-app hashed outfile) — never bare
 * `ags run`. See notes/AGENTS.md and the root AGENTS.md (multi-app rules).
 */
import { createApp } from "@common/app/start"
import { mountNotes, notesCss } from "./mount"
import { flushAll, openNewNote, openNoteByName } from "./notes"

createApp({
  instanceName: "notes",
  css: notesCss,
  main(...argv: string[]) {
    // Cold start. Default = one fresh note (SUPER+N → ensure-new.sh fresh →
    // router → `notes fresh`; a cold press's own command cancels this default
    // instead of opening a second note — see notes.ts openNewNote). With args
    // (`run.sh open foo` — the `!n` bang path) the requested note opens
    // directly instead. run.sh forwards extra argv.
    const [action, name] = argv
    if (action === "open" && name) openNoteByName(name)
    else openNewNote()
    mountNotes()
  },
  onQuit() {
    flushAll()
  },
})
