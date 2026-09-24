# AGENTS.md — TINSHELL notes app

Part of the TINSHELL multi-app home. **READ the repository root `AGENTS.md` FIRST** —
the multi-app rules (one app = one explicitly-named bus, launch path via
`tinshell-host.sh` (the universal bundle), `ags -i <app> request` addressing, onboarding, common
modules) apply to everything in this file. This file is the app-specific
spec; the root file is the cross-app contract.

`notes` is a floating desktop notes app — a sticky-style multi-window note
taker with the suite's frosted aesthetic. One note = one plain `Gtk.Window`
(a normal XDG toplevel, NOT layer-shell), so Hyprland's window management
(float rule, rounding, move/resize) applies to notes like any other window.

## SPEC MAINTENANCE

- **The spec in this file is the source of truth.** When code changes alter
  behaviour, visuals, or architecture, update this file as part of the change
  — autonomously, not as a follow-up. Give a summary of spec changes after
  each code edit that affects it. If spec and code disagree, the spec is
  wrong until updated.

## Identity

| | |
| --- | --- |
| Instance / bus | `notes` (`io.Astal.notes`) |
| Unit | **NONE — by design.** On-demand desktop app: SUPER+N (fresh note) / SUPER+SHIFT+N (reopen a closed note) launch it; the ISLAND quits when the last note closes. In SHELL the app is LAZY: not loaded until the first `notes …` request, unloaded ~60s after the last note closes (`scheduleUnload("notes")` in notes.ts; `unmountNotes()` tears each window down through the one close path — flush → registry drop → destroy — and resets module state). No long-running surface, no crash-restart needed. |
| Window class | `io.Astal.notes` — set per-window via `common/window/app-id` `setAppId` (the GTK4 app_id defaults to the shell's `io.Astal.shell` in the merged instance, which would miss the `notes-float` rule); matched by hyprland.lua |
| Launch path | `run.sh` → shared bundler (per-app hashed outfile). Cold start (no argv) opens one fresh note after a short grace (§Launch path); warm presses go through the bus. |

## Launch path & lifecycle

- **SUPER+N** (hyprland.lua) runs `notes/ensure-new.sh fresh` and
  **SUPER+SHIFT+N** runs the same wrapper with `new` — a thin wrapper over the
  router (`tinshell-route.sh notes <action>`, shell-first per
  `route-map.conf`). The router probes the live instances for the `notes`
  namespace (the shell lists it from boot — lazy prefixes are pre-declared),
  forwards the action to the first that serves it, and only when NOTHING live
  serves notes does it cold-start the map's first instance under a `flock` keyed
  on that instance, wait for a servable dispatcher and then forward the same
  request — so the action runs exactly once per press either way, and a second
  press in the ~1-3s bundle window blocks on that lock and lands as a normal
  request against the instance
  that came up. The two actions are `fresh` (§Mod+N below) and `new` (§Reopen a
  closed note).
- **A press that cold-starts the app still yields ONE note.** The cold start
  reaches the app before the press's forwarded request does, so the instance's
  own default window and that request would each open a note. The cold-start
  default is therefore DEFERRED (`COLD_START_GRACE_MS`, notes.ts
  `openNewNote`) and cancelled by the first window-opening action — the press's
  own request — so exactly one window of the action the press asked for comes
  up: `fresh` for SUPER+N, `new` for SUPER+SHIFT+N. A start nobody requests a
  window of (bare `tinshell-host start notes`, `tinshell-mode island notes`, `run.sh
  notes`) lets the default fire and opens one fresh empty note, and `run.sh
  notes open foo` opens `foo` directly without arming it. The opposite order is
  covered too: a request that lands BEFORE the boot hook reaches the default
  marks it resolved, so it is never armed. The default reaches the app both
  ways the island boots — app.ts `main()` (no argv) and the host registry's
  island-parity `boot` hook.
- The app quits when the LAST note window closes (`window-removed` → no
  windows left → `app.quit()`), immediately — no idle linger (closed is
  closed). Cold starts are
  fine (~0.3s to a note window with the bundle cache AND the GPU-wake pins:
  hyprland.lua's `hl.env` pins — `VK_ICD_FILENAMES` + the EGL pin — are what
  keep the dGPU suspended; keep them). Explicit `ags -i notes quit`
  quits immediately too.
- Logs: `fileSink` → `/tmp/tinshell-notes-debug.log` (launched from a keybind —
  stdout/stderr are lost, same as the dock).
- Quit explicitly: `ags -i shell quit` (shell) / `ags -i notes quit` (dev island).

## Request API

| Command | Args | Returns |
| --- | --- | --- |
| `ping` | — | `pong` |
| `fresh` | — | `ok` — the Mod+N action: opens a brand-new EMPTY note, focused. The closed-note history is never consulted, so it cannot resurrect a note the user closed |
| `new` | — | `ok` — the Mod+SHIFT+N action: reopens the most recently closed note (the same stack Ctrl+Shift+T pops, at the position + size it was closed at, focused), or opens a fresh blank note when that history holds nothing restorable (empty, or every entry's file gone) |
| `open` | `<name-or-path>` | `ok` or `error: <msg>` — CREATE-OR-OPEN: a missing note is created (the `!n` launcher bang opens any name). Name resolves inside the storage dir (`.md` appended if missing); a path with `/` is used as-is; `~` expands. Already-open notes are focused, never duplicated |
| `close` | `<name-or-path>` | `ok` or `error: <msg>` — closes the WINDOW of an OPEN note (app-internal close path: close-request → flush → registry drop). The FILE stays on disk (auto-save). Not-open/missing notes error |
| `list` | — | note file names (one per line) |
| `session` | — | live session-tracking state (path/addr/applied/entry) |
| `history` | — | the open notes' edit chains: JSON array of `{path, steps, at, folded, readOnly}` per window (see §Edit history) |
| `config get\|set\|reload\|all` | per convention | JSON value / `ok` / `reloaded` |

## Behaviour

### Window

- One `Gtk.Window` per note, class `io.Astal.notes`, CSS class `note`.
- **Frameless** (`set_titlebar(null)`) — no titlebar, no buttons, no UI
  elements of any kind. SUPER+Q (existing hyprland.lua bind) closes the
  focused note.
- Initial size: pinned by the `notes-float` Hyprland windowrule `size`,
  which hyprland.lua READS from config `window.width`/`window.height`
  (default 250×250 square) at config load — the config files stay the
  source of truth; a size change applies on `hyprctl reload` and affects
  only NEW notes (open notes keep their size). Min 220×160
  (`set_size_request`). Resizable interactively via the GENERIC Hyprland
  binds (SUPER+RMB drag, SUPER+CTRL+arrows) — those live in hyprland.lua
  and work on every window, not just notes.
  **WHY the rule pins the size:** Hyprland 0.52+ sends its own
  half-monitor default configure to fresh floating XDG windows whose first
  commit loses the startup race, and GTK4 obeys the nonzero configure —
  `set_default_size(250,250)` only won when the app's first commit landed
  first, so a new note could map at Hyprland's half-monitor default (half the
  1440×900@2x monitor in PHYSICAL px applied as logical). GTK4 has NO
  post-map resize API for XDG windows, so the app cannot correct it — the
  windowrule is the deterministic fix (hyprland.lua `notesConfigSize()`).
- Title = the first non-empty line of the note (truncated 48 chars), else the
  file name. Used by Hyprland window matching/overview; updates live.
- **No in-window drag grip.** The padding is pure
  visual breathing room and the text reuses the space. Moving notes uses the
  generic Hyprland move (SUPER+LMB drag). No padding GestureDrag
  (Gdk.Toplevel.begin_move) exists.

### Padding

- Uniform ring around the text (`.note-pad` CSS `padding`, config
  `window.padding`, default 8px) that follows the window's rounded corners
  naturally. Text view expands to fill the rest.

### Editing

- `Gtk.TextView` (word wrap, editable, visible caret), JetBrainsMono Nerd
  Font 16px (theme.css global font), light ink `#e6e6e6` on the dark card
  scrim, caret `#8ab5f7` (suite accent), blue-tinted selection. Thin
  translucent scrollbar on overflow (shared thin-pill family from
  `common/shell/theme.css`).

### Auto-save

- Buffer changes → `timing.saveDebounceMs` (400) NON-RESTARTING throttle →
  async write to the note's file via a SERIALIZED write chain (slow writes
  never interleave). The timer is set once and never restarted per keystroke
  — a classic debounce would let continuous typing NEVER save (an unbounded
  loss window on crash). `buffer.text` is read at fire time so
  interim keystrokes are included; worst-case lag = 400ms. Window focus-out
  (`notify::is-active` false) flushes pending edits early. Close and app
  shutdown flush SYNCHRONOUSLY (files are small).
  Files: `storage.dir` (default `~/.local/share/notes`),
  one `note-<YYYYMMDD-HHMMSS>.md` per note. The file is created on window
  open (even before the first keystroke).
- Empty buffer (cleared note) never enters the write chain — it goes
  through the sync path. A zero-length async write once never settled, and
  the chain is module-global: one never-settling write blocks EVERY note's
  autosave forever. `writeFileAsync` (`common/fs/files.ts`) uses
  `replace_contents_bytes_async` (GLib.Bytes) — the plain
  `replace_contents_async` does not copy its contents buffer and is
  unreliable for zero-length data.
- STORAGE CAP: `storage.maxFiles` (default 200) — after every write,
  `store.ts` `pruneStorageDir()` deletes the OLDEST `*.md` files (by mtime)
  beyond the cap, permanently, naming the victims in its log line. Only files
  inside `storage.dir` are pruned; notes opened by explicit path elsewhere are
  never touched. The mtime must be a REQUESTED `time::modified` attribute —
  see GOTCHA 17 (the cap's "oldest" sort depends on that attribute).
- Window close and app shutdown flush SYNCHRONOUSLY (files are small).
- The edit history (§Edit history) rides the SAME flushes: it is written after
  the content write on the throttle, on focus-out, on close and on unmount, so
  the chain is never staler than the file it describes.
- Reopen: `ags -i shell request "notes open <name>"` / `notes list` (island:
  `ags -i notes request "notes open <name>"`), or the launcher's `!n` bang
  (`launcher/sources/bangs.ts`).

### Session restore

- Open notes persist across shell restarts AND notes-app crashes: the set of
  open windows (path, workspace, x/y/w/h) is mirrored into the shared state
  store (`common/state.ts`) — canonical
  `~/.local/state/tinshell/apps/notes/state.json` under the XDG state dir (NOT
  the config dir), sync atomic writes with a 200ms debounce
  during geometry sampling (`session.pollMs` 2000).
  The SAME file + store also holds the closed-note history under key `closed`
  (§Reopen a closed note) — each entry the note's path plus the geometry it
  was closed at — and the per-note Ctrl+S save target under key `named`
  (§Save and save as file): one store, one atomic write, the same per-key validation on load.
  A `closed` entry written before entries carried geometry (a bare path) is
  still accepted, so an existing history is never dropped on load.
  The file is written by a
  light `hyprctl -j clients` poll (only while ≥1 note is open) PLUS a
  synchronous final-geometry sample (`GLib.spawn_command_line_sync`, ~5-15ms)
  in the untrack and flush paths BEFORE the state write — a
  move→close inside the poll interval persists the FINAL position, not the
  last sampled one; without the sync sample, a quick move+close would save
  stale geometry.
- The poll's FIRST tick after a note is tracked fires at 250ms (then the
  configured `session.pollMs` cadence), so a note that is moved and closed
  within the poll interval already has an address + a baseline entry to
  sample from — close/flush sample through that address and the closed-note
  history keeps the geometry (§Reopen a closed note).
- On the next `mountNotes()` (shell lazy-load or island cold start),
  `restoreOnce()` re-opens every entry whose file still exists — focus-free
  (windows present but never grab keyboard focus). Restored windows map
  content-invisible (`restoring` CSS gate in Note.tsx, applied whenever
  `restoring:true` — NOT nested under the grabFocus branch, which restore
  always skips; a nested form would never run and windows would flash during
  placement). `reveal()` lifts the gate once geometry is confirmed. Placement is MAP-TIME:
  before opening, a title-matched windowrule
  (`hl.window_rule` via `hyprctl eval` — runtime Lua; the dispatch path
  rejects window_rule) pins `workspace = "<ws> silent"`, `move`, `size` for
  each entry, so the window's FIRST commit is already fully placed — no
  visible init-at-cascade-spot-then-jump. Rules are appended after
  notes-float and last-win its class-wide size pin. The address-targeted
  dispatcher set (silent workspace move → resize → move) remains as a
  fallback; an accelerated 150ms poll runs until every restored note has
  settled, then the normal cadence resumes. Rules persist for the session
  (they match exact titles — bounded, harmless). Missing files are skipped
  and their entries PURGED from the state file.
- **Boot-time auto-restore:** boot-time
  lazy restore (`common/app/lazy restoreLoadedApps`) loads notes
  when the durable session file holds any entry whose note file still exists
  — the registry's `notesSessionRestoreWanted` predicate (`common/host/
  registry.ts`) is evaluated at production-shell boot and calls
  `ensureLoaded("notes")`, independent of the XDG_RUNTIME_DIR
  loaded-set memory. A resident island that lazy-hosts notes restores the
  same way: its own per-owner loaded-set memory (`lazy-loaded-<instance>.json`)
  normally drives it, and the same durable predicate is the backstop when
  that island's memory file is absent. That predicate reads state which is
  GLOBAL, not per-instance, so the restore is arbitrated by an exactly-once
  claim file (`restore-claim-notes` beside the memory files, owner instance +
  pid): the first LIVE instance to claim it restores the notes, every other
  booting instance skips them, a dead owner's claim is reclaimed. Without the
  claim, every resident instance starting with no memory file would open its
  own copy of the same note — N windows and N writers on one `.md`. So notes
  open at a crash/restart come back WITHOUT any press even when the runtime
  loaded-set is missing (it lives under
  XDG_RUNTIME_DIR and is cleared on logout). Empty session state → notes
  stays lazy (zero boot cost). The loaded-set memory (same-login restarts)
  is an ADDITIONAL trigger — either one brings notes back.
- A user CLOSE removes the entry — closing the last note leaves `notes: []`
  and nothing is resurrected. A crash leaves the file stale ON PURPOSE: that
  is what restore reads. A graceful shell stop (unmount) also leaves it stale,
  and deliberately so: the unmount tears every window down and drops every
  handle, but it never untracks a note — the per-note session untrack runs
  solely on the user-close path, so an unload neither looks like a user close
  nor destroys what the next start restores.
- Address assignment matches `hyprctl` clients (class `io.Astal.notes`) to
  notes by exact window title, then a 16-char prefix fallback, then registry
  order. Titles come from the first line — duplicate first-line notes rely on
  the order-based fallback.
- Config: `session.enabled` (default true), `session.pollMs` (default 2000,
  min 250; tier restart). Debug: `ags -i shell request "notes session"`
  dumps the live tracking state (path/addr/applied/entry).
- Limitations: no workspace-id validation (Hyprland clamps moves to missing
  workspaces), no monitor-bounds clamping on restore, and exact position
  restore depends on Hyprland honouring the move dispatch for the mapped float.

### Save and save as file (Ctrl+S / Ctrl+Shift+S)

- **Ctrl+S writes the file named by Ctrl+Shift+S** — silently, with no dialog
  and no notification. It is a normal save, not an export copy and NOT the
  autosave file.
- **Ctrl+S is INERT until a save-as has named a file**: the chord consumes the
  key and writes nothing. The note's own auto-save file (see §Auto-save) is
  never the Ctrl+S target — autosave keeps writing it on its own throttle,
  on close and on shutdown.
- The named target is remembered per note path in the state store (key
  `named`, §Session restore), so a note reopened by Ctrl+Shift+T / Mod+SHIFT+N, or
  restored after a shell restart / crash, still knows the file it was last
  saved to. The map is capped (100 entries, oldest dropped).
- Ctrl+Shift+S → promptd `input` dialog (`{mode: text, title: "save note as file",
  placeholder: <export.defaultDir>/<slug>.md}`) → write the buffer to the
  given path (mkdir -p parents) → `notify-send` with the path → that path
  becomes the note's Ctrl+S target.
- The dialog goes through the ROUTER — `~/.local/bin/tinshell-route promptd
  "input <b64>"` (shell-first per `route-map.conf`), never `ags -i promptd`:
  in production promptd is hosted INSIDE the shell instance and no `promptd`
  bus name exists, so a direct instance call answers `instance "promptd" is
  not runnning` and save-as would silently no-op (the reply is read off
  stdout, so the failure is indistinguishable from a cancel). The router
  probes the live instances, reaches the same dialog and forwards its reply.
- Cancel (`error: cancelled`) → silent no-op (an already-named target stays).
- Typing the path into the popup + Return exports the note's current buffer.
  A `saving` flag guards the textview + window key controllers against double-fire.

### Reopen a closed note (Ctrl+Shift+T / Mod+SHIFT+N)

- Ctrl+Shift+T reopens the most recently CLOSED note, focused; pressing it
  again steps back to the next older closed note. **Mod+SHIFT+N pops the SAME
  stack**: the SUPER+SHIFT+N keybind (`notes new`) reopens the most recent
  closed note, or creates a fresh blank note when the history holds nothing
  restorable — Mod+SHIFT+N is never dead. SUPER+N deliberately does NOT touch
  this stack: it always opens a fresh empty note (§Mod+N below).
- The stack lives in the app's state store (`common/state.ts`, app
  `notes`, key `closed`) — the same
  `~/.local/state/tinshell/apps/notes/state.json` the session uses, so it survives
  a lazy unload, a shell restart and a reboot instead of dying with the
  process. Each entry is `{path, geometry:{x,y,w,h}}`; `geometry` is absent
  for a note that never got a polled session entry (see below) and for an
  entry written before entries carried geometry — such a note reopens at
  Hyprland's default spot.
- Recording happens on the REAL close path only (the registry's
  `close-request` handler: flush → session drop → record → destroy). The
  close samples the note's FINAL geometry (the same sync `hyprctl -j clients`
  pass the session drop runs — `untrack` returns it) and stores it with the
  entry. An unmount or a bare destroy (lazy unload, shutdown) never records,
  so a restored session never pollutes the history.
- A path already in the stack moves to the front instead of repeating; the
  stack is capped at 20 entries (oldest dropped).
- Reopen re-mounts through the canonical create-or-open path (an
  already-open note is focused instead of duplicated). An entry whose FILE is
  gone (pruned by `storage.maxFiles`, deleted by hand) is dropped and the
  next older entry is tried — reopening would otherwise CREATE a fresh empty
  file under the old name.
- **The recorded geometry is restored through the session's map-time window
  rule**: a title-matched `hl.window_rule` (position + size) is registered via
  `hyprctl eval` and AWAITED before the window opens, so its first commit is
  already at the recorded spot — no default-spot flash, no dispatcher race.
  The rule deliberately does NOT pin a workspace (unlike a session restore,
  which rebuilds the prior workspace layout): a reopened note comes back on
  the workspace the user is on, only at its old position and size. The normal
  poll then tracks it there like any other note.
- An entry with no recorded geometry (a note closed before its first 250ms
  poll tick, or a legacy bare-path entry) lands on the current workspace at
  Hyprland's default spot.
- The chord is delivered to the FOCUSED note window, so it needs at least one
  open note: closing the LAST note quits the dev island, and in the shell it
  leaves the app windowless (no key receiver) until the next open (SUPER+N /
  SUPER+SHIFT+N, a launcher bang, or a boot restore).

### Edit history (Ctrl+Z / Ctrl+Y — survives a reopen)

- **Undo and redo are this app's own stack**, not GTK's: `history.ts` (pure
  model) over `history-store.ts` (files). GTK's per-buffer stack is switched
  OFF (`buffer.set_enable_undo(false)`, Note.tsx) so exactly one stack sits
  behind the chords — GTK's is per-widget, cannot be serialised and dies with
  the window, which is why a reopened note used to have no undo at all. The
  user-facing chords are GTK's own: **Ctrl+Z undo, Ctrl+Y redo, Ctrl+Shift+Z
  redo**, consumed in Note.tsx `onNoteKey` for the focused note window.
- **The chain**: `base` (the text at the oldest reachable point) plus steps
  `[0..at)` applied on top, where a step is a splice `{o, d, i}` — an offset,
  the text removed there and the text inserted there — with the caret offsets
  before/after (`cb`/`ca`). `at` is both the position of the current text and
  the size of the undo stack; a new edit truncates the redo tail. Steps are
  derived by diffing the previous buffer text against the current one, so the
  recorder needs no TextIter plumbing.
- **One file per note, in the app state dir**:
  `~/.local/state/tinshell/apps/notes/history-<pathKey>.json`
  (`appStateFilePath("notes", …)`; `pathKey` = 12 hex chars over the note's
  ABSOLUTE path, and the path is stored in the file and checked on load). Never
  `storage.dir`: `pruneStorageDir` deletes the oldest `*.md` by mtime beyond
  `storage.maxFiles` and `listNotes` lists every `*.md`, so a history file in
  there would be pruned and would show up in `notes list`. Never `state.json`:
  the shared store rewrites its whole file on every `set` and the boot-restore
  predicate reads it. The file is versioned (`v: 1`) and written through
  `writeFileSync` (temp file + rename, never torn).
- **Bounds**: 400 steps and 256 KiB of step payload per note — crossing either
  folds the oldest steps into `base` (64 at a time), which `notes history`
  reports as `folded`; undo therefore reaches back at most to the current
  `base`. A single coalesced step stops at 3000 chars, and a note past 256 KiB
  keeps no chain (it re-anchors to the current text). Retention: the newest 300
  history files are kept (oldest by mtime pruned, on the first load of a
  process and after every close).
- **Coalescing**: consecutive edits become ONE undo step while they stay the
  same kind (insert run or delete run), arrive within 800 ms, leave the caret
  where the previous step ended, and stay under the step ceiling. A newline in
  an inserted run, a caret jump, a focus-out or an undo request closes the step.
- **External change re-anchors, never replays.** Every chain is reconciled with
  the text on disk at window creation and again on focus-out: an exact match
  keeps the chain, ANY disagreement replaces it with the on-disk text (steps
  discarded, one log line `history: external change for <path> — history
  re-anchored`). A chain can therefore never revert an edit made by another
  editor, a sync tool or the user's own shell. Corollary: undo/redo also verify
  the text they are about to revert and refuse when the buffer disagrees
  (`undo`/`redo` return null), so a stale chain cannot corrupt a note either.
- **The history path NEVER writes the note's `.md`.** Undo changes the buffer;
  the existing auto-save writes the file, exactly as for any other edit.
- **A replay is not an edit**: while `applyReplay` runs, the recorder is told
  the change came from a replay (`origin: "replay"`) and records nothing, while
  the auto-save still runs — the note file must follow an undo. Undoing also
  puts the caret back where the edit was made and scrolls it into view.
- **Lifecycle**: the chain is read at `createNote` (which every open path goes
  through — `openNoteByName`, the session-restore opener and the Mod+SHIFT+N
  reopen) and written on the auto-save throttle (after the content write), on
  focus-out (plus the re-anchor re-check), in the close-request handler via
  `note.flush()` before `win.destroy()`, and in `unmountNotes` before each
  destroy. Module scope holds no chain: it belongs to the window.
- **Two processes**: a chain records its `owner` (`{instance, pid}`). A window
  that loads a chain owned by another LIVE instance marks it read-only (undo
  works from it, nothing is written), so a hand-started dev island cannot
  clobber the chain the shell is backing. The boot restore claim already makes
  exactly one instance the adopter at boot.
- Chords do nothing when there is nothing to do: a note with no chain (a fresh
  `note-<timestamp>.md`, or a Mod+SHIFT+N press that fell back to a blank note)
  has an empty stack, and undo past the base or redo past the top returns null.
- Probes (both re-runnable, neither touches the real notes or state):
  `node --experimental-strip-types apps/notes/history.probe.mjs` — fuzz
  undo/redo identity, the self-recording guard, folding at the caps, coalescing
  boundaries, re-anchoring in both directions, malformed files, the owner guard
  and the write cost at the payload cap; and, for the file side, under a scratch
  state dir —
  `XDG_STATE_HOME=$(mktemp -d) bash -c 'ags bundle --gtk 4 apps/notes/history-store.probe.ts /tmp/notes-history-store-probe.sh && bash /tmp/notes-history-store-probe.sh'`
  — the state-dir path, a save/load round trip, re-anchor through the real
  loader, a corrupt file, the owner guard, the retention prune, and that the
  note's own `.md` is never written by this layer.

### Mod+N (a fresh note)

- `notes fresh` (SUPER+N → `notes/ensure-new.sh fresh`) opens a brand-new
  EMPTY note window, focused: a new `note-<timestamp>.md` in the storage dir,
  empty buffer. It consults neither the closed-note history (§Reopen a closed
  note) nor the open-window set — a press always yields another blank note, it
  never focuses an existing one instead. That is the whole point of the key: a
  guaranteed fresh note, never a resurrection.
- The handler is notes.ts `openFreshNote`; the same window is what a cold press
  ends with, because the app's deferred cold-start default (§Launch path) is
  cancelled by this action.

## Aesthetics

- Frost: `window.note` background `rgba(10,12,17,0.5)` (config
  `appearance.cardColour`/`cardAlpha` — the black card scrim). Blur comes from Hyprland's GLOBAL
  blur setting — the window is translucent, so the compositor blurs behind
  it automatically. The Lua window_rule API has NO per-window blur/ignorealpha
  keys (layer rules only) — do not add a layerrule for notes; it's an XDG
  window, not a layer surface.
- Rounding: Hyprland `notes-float` rule `rounding = 14` rounds the window
  itself (the card fills the surface; no CSS radius). Matches the
  launcher/promptd card radius.
- Border: the `notes-float` rule sets `decorate = true` + `border_size = 1`
  to re-assert the active border — the smart-gaps workspace rules
  (`w[tv1]`/`f[1]`) strip `no_border`/`decorate` on immersive workspaces
  (single tiled or maximized window, where the note usually floats).
  `border_size` alone beats `w[tv1]` but NOT `f[1]`; `decorate = true`
  covers both. The border draws at the window's OUTER edge (outside the
  surface rect) — probing for it inside the window finds nothing.
- Context menu: the text view's right-click edit menu (GTK default —
  Cut/Copy/Paste/Delete/Select All + Input Methods/Insert Emoji) is themed
  in the dynamic CSS block (app.ts) to match the card: same config-driven
  card bg (the popover is a subsurface, so global blur frosts it), repo
  text colour, the shared `--tinshell-panel-radius`, rgba(0,0,0,0.15) hover, muted
  disabled items.
  Appearance-only — the default menu is kept, not replaced.

## Config

`config.defaults.json` + `config.schema.json` + thin `config.ts` over the
shared loader via `createAppStore` (launcher pattern). Keys: `appearance.*` (restart), `window.*`
(restart), `storage.dir`, `storage.maxFiles` (storage cap, oldest pruned),
`export.defaultDir`, `timing.saveDebounceMs`
(restart). The app's CSS is assembled at startup (static style.css + a
dynamic block interpolating config values) — appearance changes need a
restart.

## Files

- `app.ts` — entry (createApp; dynamic CSS); the `fileSink` is set up in
  `mount.ts`.
- `Note.tsx` — the note window factory (Ctrl+S save to the named file,
  Ctrl+Shift+S save-as, Ctrl+Shift+T reopen, Ctrl+Z/Ctrl+Y undo/redo over the
  loaded chain, auto-save, title). Its `teardown()` is the per-window release
  every close path calls BEFORE the window is destroyed: one flush, then a
  latch that makes every later write (`flush`, the autosave throttle, focus-out,
  history persist, undo/redo, save-as) a no-op.
- `notes.ts` — open-note registry + quit-on-last-window wiring (records the
  closed-note history with the close geometry, injects the reopen action, and
  holds the note-opening actions: `openFreshNote` = fresh empty note (Mod+N),
  `reopenOrBlankNote` = reopen-or-blank (Mod+SHIFT+N), `openNewNote` = the
  deferred cold-start default window). Its `closeWindow` is the ONE close path
  (teardown → registry drop → destroy), and `unmountNotes` runs it for every
  open note and then resets module state (registry, cold-start timer/flag,
  session maps) so no handle outlives a lazy unload.
- `commands.ts` — request handlers (ping/fresh/new/open/close/list/session/config).
- `store.ts` — file storage (serialized async chain + sync flush, list/read).
- `session.ts` — session persistence + restore (state file, clients poll,
  geometry re-apply via Lua dispatchers) + the persisted closed-note history
  (the Ctrl+Shift+T / Mod+SHIFT+N stack, with each note's close geometry) and the
  per-note Ctrl+S save target (`named`).
- `history.ts` — the edit-history model behind Ctrl+Z / Ctrl+Y: the splice
  log, undo/redo replay, coalescing, folding at the caps, the re-anchor rule
  and the file format. Pure (no gi, no IO).
- `history-store.ts` — the file side: the state-dir path per note, load with
  reconciliation, save, the owner guard and the retention prune.
- `history.probe.mjs` — the model probe (plain Node): fuzz replay identity,
  the self-recording guard, folding, coalescing, re-anchoring, malformed files,
  the owner guard, write cost.
- `history-store.probe.ts` — the file-side probe (gjs via `ags bundle`; run it
  with `XDG_STATE_HOME` pointed at a scratch dir).
- `config.ts` + `config.defaults.json` + `config.schema.json`.
- `style.css` — static theme (transparent surfaces).
- `run.sh` — 1-line shim to the shared bundler.
- `ensure-new.sh` — the SUPER+N / SUPER+SHIFT+N launcher (thin router wrapper,
  first argument = the notes action — see §Launch path).
- `ensure-open.sh` — the `xdg-open` side: routes `notes open <path>` to the live
  instance, and is the `Exec` of `tinshell-notes.desktop`. That entry claims
  `text/markdown` ONLY. It deliberately does not claim `text/plain`: the system
  sniffs file content, so `.go`, `.sql`, `.yaml`, `.toml`, `.lua`, `.ini` and
  `.txt` all report `text/plain`, and claiming it would open source files in a
  notes app. Plain text belongs to the editor.
- `tinshell-notes.desktop` — the handler entry above (launcher name TINSHELL Notes).

## GOTCHAS

1. **`notes` is NOT a layer-shell app.** No `Astal.Window`, no `<window>`
   JSX intrinsic, no layerrule in hyprland.lua. Plain `Gtk.Window` (gnim
   class-component JSX handles it). The blur layerrules in hyprland.lua are
   for dock/launcher/promptd surfaces only.
2. **No systemd unit.** Do not add `tinshell-notes.service` to setup.sh's unit
   loop — the app quits with its last window by design. `setup.sh` only
   needs the two scripts in its chmod list and the workspace registration.
3. **The window rule matches `class = "^(io\\.Astal\\.notes)$"`** — the
   GTK4 app_id (from `applicationId`). A bare `notes` class matches nothing.
4. **No in-window drag grip.** A capture-phase `GestureDrag` →
   `Gdk.Toplevel.begin_move` is not used; moving notes uses the generic
   Hyprland move (SUPER+LMB). See §Padding.
5. **`run.sh` FORWARDS extra argv**: `notes/run.sh open foo` → shared
   run.sh → `exec "$OUTFILE" "${@:2}"` → gjs programArgs → app.ts
   `main(...argv)` — the cold `!n` path opens the requested note directly
   (no default extra note).
6. **Kill stray notes gjs by exact PID** (same as every app here). The gjs
   child outlives the run.sh wrapper on exit by ~2s while releasing the bus —
   a `notes …` request landing in that tail misses the exiting instance.
   Never `pkill` a pattern that could hit another app's gjs.
7. **Manual restart races the bus release.** Killing the app and relaunching
   within ~2s can hit the register-race death (the services solve this with
   tinshell-bus-wait.sh in ExecStartPre; notes has no unit, so wait for
   `io.Astal.notes` to release — `dbus-send ... NameHasOwner` — before a
   manual relaunch). The router path is immune (it cold-starts only when
   NOTHING live serves the `notes` namespace, and the cold start is
   `flock`-serialized on the instance it starts).
8. **Diagnostics live in /tmp/tinshell-notes-debug.log** (the shared fileSink).
9. **The text view collapses to ~0 size unless hexpand/vexpand is set on
   EVERY layout level** (pad box, scrolled window, text view). Collapsed =
   typed text invisible while the buffer/autosave still work (looks like
   "typing does nothing" + empty cards). Same for keyboard focus:
   `grab_focus` must run on the window's `map` signal, not at creation.
10. **`GLib.dir_open` is not a function in gjs** (C macro) — note listing
   uses Gio.File.enumerate_children; a dir_open call throws and, if
   swallowed, makes `list` return an empty list.
11. **Shared logger fileSink traps:** `write_async` needs
   GLib.PRIORITY_DEFAULT (not null — gjs rejects) and a GLib.Bytes-wrapped
   buffer (a raw Uint8Array writes pool garbage) — otherwise every fileSink
   log on dock AND notes is lost.
12. **Gjs binding gaps that bite:** `get_last_event()` returns null at
   drag-begin; a GestureClick on the same widget rejects sibling drag
   gestures. The maintained list lives in the root `AGENTS.md` → "gjs
   binding gaps".
13. **No backticks inside the `dynamicCss()` template literal (mount.ts).**
    The dynamic CSS block is a JS template string — a backtick in a CSS
    comment terminates it and breaks the bundle SILENTLY at cold start
    (SUPER+N does nothing; only `ags bundle` shows the error). Use plain
    text in CSS comments inside that template.
14. **Session restore title matching:** restored windows are
    title-matched; see §Session restore. Two more traps:
    (a) **the poll must NOT sample a note's geometry before its saved entry
    has been applied** — sampling a just-restored window records Hyprland's
    default placement and clobbers the saved entry before the apply step runs
    (restore landed at the default spot). Sampling gate: sample only when the
    entry is absent (brand-new baseline) or already applied.
    (b) **the `destroy` signal is NOT a reliable cleanup hook in the merged
    shell** — gjs's JS reference to the window (in the `open` array) keeps the
    GObject alive through `gtk_window_destroy()`, so dispose/destroy may
    never run; the default close only HIDES the window. Every close path
    therefore runs its own teardown SYNCHRONOUSLY and BEFORE the destroy:
    `notes.ts` `closeWindow(note, "user" | "unmount")` = `note.teardown()`
    (flush + latch) → registry drop → `win.destroy()`, called from the
    close-request handler, the `close` request and the shell unmount; the
    `destroy` handler is only an idempotent backstop. Without this, closed
    notes resurrected on every restart. **With a handle left behind in `open`,
    the window becomes a ZOMBIE**: the next `present()` re-shows a window whose
    `gtk_window_destroy()` already ran (GTK logs "shown after destroyed"), it
    writes its stale buffer to the `.md` on the next close, and neither the
    app's close nor SUPER+Q can remove it — only a shell restart clears the
    surface. That is why `unmountNotes` also empties `open` and re-arms the
    cold-start state, and why every `open`/`close` lookup skips a torn note
    (`isTorn()`).
15. **Title matching fallback:** restored windows are
    matched to their Hyprland clients by title (the map-time title — see 16 —
    i.e. the basename until the first edit). Notes sharing a title fall back
    to order-based assignment — geometry may swap between identical-titled
    notes if they map in a different order than they were saved. Harmless for
    content (files are per-path); only affects which window lands at which
    saved spot.
16. **Map-time restore rules match the BASENAME, not the first line:**
    a note window's title at map is ALWAYS the basename
    (without .md) — the initial `buffer.text = contents` assignment happens
    BEFORE the "changed" handler is connected, so the content-derived title
    only appears after the first user edit. The restore rules (see
    §Session restore) must therefore derive their title match from the
    basename; matching the first line silently misses every note with content
    (those notes restore at the default spot instead).
17. **The storage cap's mtime MUST come from a REQUESTED `time::modified`.**
    `Gio.FileInfo` carries only the attributes the `enumerate_children` query
    asked for, and `standard::time-modified` is not an attribute at all —
    reading it returns 0 for EVERY file, so the "oldest by mtime" sort in
    `pruneStorageDir` would be a no-op and the cap would delete arbitrary
    notes. The prune now
    queries `standard::name,standard::type,time::modified`, reads
    `get_attribute_uint64("time::modified")`, treats an unreadable (0) mtime
    as "never a prune victim", and names the victims in its log line so an
    arbitrary deletion can never go unnoticed. Any other
    `get_attribute_*` on an enumerate_children FileInfo needs the same check
    — request it, or it reads 0.

## Keymap summary

- `SUPER+N` = a guaranteed fresh EMPTY note, never the closed-note history
  (via ensure-new.sh fresh → `notes fresh` — see §Launch path).
- `SUPER+SHIFT+N` = reopen the most recently closed note, or a new blank note
  when the closed-note history holds nothing restorable (via ensure-new.sh new
  → `notes new` — see §Launch path / §Reopen a closed note).
- `SUPER+TAB` = notifications toggle.
- `SUPER+LMB` / `SUPER+RMB` = move / resize; `SUPER+CTRL+arrows` = 60px
  resize steps (generic Hyprland binds — see §Window).
- Auto-save dir `~/.local/share/notes/` (storage.dir); Ctrl+S = save to the
  file named by Ctrl+Shift+S (inert until one is named), Ctrl+Shift+S = save
  as via promptd (§Save and save as file), Ctrl+Shift+T = reopen the most recently closed note
  at its recorded position + size (§Reopen a closed note); Ctrl+Z = undo and
  Ctrl+Y = redo that note's edit history, including the edits made before it
  was closed (§Edit history); `SUPER+SHIFT+N` pops the
  same stack; `!n <name-or-path>` in the launcher opens/creates.
