# AGENTS.md — TINSHELL annotate app

Part of the TINSHELL multi-app home. **READ the repository root `AGENTS.md` FIRST** —
the multi-app rules (one app = one explicitly-named bus, launch path via
`tinshell-host.sh` (the universal bundle), `ags -i <app> request` addressing, onboarding, common
modules) apply to everything in this file. This file is the app-specific
spec; the root file is the cross-app contract.

`annotate` is a floating screenshot-annotation editor — pen, highlighter,
arrow, rectangle, ellipse and text strokes on a captured image, undo/redo,
and save a new PNG. Each open is its own plain `Gtk.Window` (a normal XDG
toplevel, NOT layer-shell), so
Hyprland's window management (float rule, rounding, move/resize) applies
like any other window. It is a **desktop app**: launched on demand from the
dock ScreenGrab notification action, quits when the LAST window closes. No
systemd unit, no layerrule — the notes/files pattern.

## SPEC MAINTENANCE

- **The spec in this file is the source of truth.** When code changes alter
  behaviour, visuals, or architecture, update this file as part of the change
  — autonomously, not as a follow-up. If spec and code disagree, the spec is
  wrong until updated.

## Identity

|                |                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dir            | `annotate/`                                                                                                                                                             |
| Instance / bus | in shell: inside the shell instance (`io.Astal.shell`); dev island: `annotate` (`io.Astal.annotate`) — addressed `ags -i annotate request "annotate …"` / `ags -i annotate quit` |
| Window class   | `io.Astal.annotate` (GTK4 app_id from the `identity.ts` constant `ANNOTATE_APP_ID`; matched by the `annotate-float` window rule)                                                                                          |
| Window rule    | `annotate-float` in `hypr-rules.ts` → `~/.config/hypr/rules/120-annotate.lua` — float, rounding 14, `decorate = true`, `border_size = 1`, `size` read from config `window.defaultWidth/defaultHeight` (630×450, mirroring notes-float) — the startup-race fix that pins the map size (and the window really maps at it: the header row's minimum is 477px, §Layout); it pins NO position. Position is annotate's own CASCADE, applied by a per-open runtime rule registered from `window.tsx` (see §Behaviour → Window) |
| Keybind        | **NONE** — opened from the screenshot notification action (the dock's "Annotate" button) via `annotate/ensure-open.sh`, or from the launcher's `!a <path>` bang (same script)       |
| Layerrule      | **NONE** — XDG window, not a layer surface. Frost = GLOBAL blur + translucent card (files/notes pattern).                                                               |
| Unit           | **NONE — by design.** Interactive desktop app; the ISLAND quits when the LAST window closes (its `window-removed → app.quit()` is gated on `!isShell` — in the shell the editor must never kill the shared instance). In SHELL the app is LAZY: loaded on the first `annotate …` request, unloaded ~60s after the last editor window closes (`scheduleUnload("annotate")`; `unmountAnnotate` as unmount, which tears down every window). Do NOT add `tinshell-annotate.service` to setup.sh's unit loop (same exception as notes/files). |
| Log            | fileSink → `/tmp/tinshell-annotate-debug.log` (launched from a notification action — stdout/stderr are lost)                                                                 |

## Launch path & lifecycle

- **Dock ScreenGrab → notification action**: after a still capture, the dock
  shows an in-process notification with an "Annotate" action (see the shell
  Integration section). Pressing it runs `annotate/ensure-open.sh <file>`.
- **Launcher bang `!a <path|glob>`** (apps/launcher/sources/bangs.ts) spawns the
  SAME `ensure-open.sh <path>`, handing over a path the launcher already
  RESOLVED (tilde, relative and glob forms through the shared path helpers, and
  only files the shared still predicate accepts — after which the launcher
  refuses with a visible row instead of spawning), so a bad argument never
  reaches the router. Beyond that resolution the launcher needs no
  annotate-specific knowledge — the router serves the app from whichever
  instance hosts it (the shell in production). The bang declares no no-argument
  form: `open` requires a path (see the Request API), so with an empty argument
  the launcher offers no row instead of a row that would open nothing. (A bare
  `run.sh` start does open an empty editor — `app.ts`'s `openEditor(null)` — but
  that is the DEBUG entry, not a launch path: production launches go through the
  universal host, whose annotate `mount` builds no window at all.)
- **ensure-open.sh**: a thin wrapper over the shared router
  (`common/shell/tinshell-route.sh annotate open <path>`). The router owns
  warm-vs-cold: it forwards to whichever live instance serves the `annotate`
  namespace, and when none does it cold-starts the map's first instance under
  its own `flock`. There is no per-app lock file.
- **Cold-start argv forwarding** (notes GOTCHA 5): `run.sh` FORWARDS extra
  argv → shared run.sh → `exec "$OUTFILE" "${@:2}"` → app.ts
  `main(...argv)`. The cold path opens the requested image directly — the
  app must NOT also issue a bus request on cold start, or the image opens
  twice.
- **Quit-on-window-close:** `app.connect("window-removed")` → no windows
  left → `app.quit()` (immediate, no idle linger). Explicit
  `ags -i annotate quit` works too.
- **No bare `ags run`** — never. `run.sh` is the 1-line shim to the shared
  bundler (per-app hashed outfile; bundle cache at
  `~/.cache/tinshell-bundle/annotate/`).

## Request API

| Command                        | Args           | Returns                                                                                          |
| ------------------------------ | -------------- | ------------------------------------------------------------------------------------------------ |
| `ping`                         | —              | `pong`                                                                                           |
| `open`                         | `<image-path>` | `ok` — open a NEW editor window at the image (WARM path only; cold start goes through run.sh argv). Every call mounts its own window. A path that is not a decodable image FILE answers `error: no such file or directory: <abs>` / `error: is a directory: <abs>` / `error: not a regular file: <abs>` / `error: not a still image: <abs>` and mounts NOTHING (`resolveTarget` in window.tsx) |
| `save`                         | —              | `ok: <path>` / `error: <msg>` — save image+strokes of the MOST RECENTLY OPENED window to `<base>-annotated.png` + notify |
| `close`                        | —              | `ok` — close EVERY open editor window, each through its own teardown (the island quits when the last one is gone)               |
| `config get\|set\|reload\|all` | per convention | JSON value / `ok` / `reloaded`                                                                   |

Quit is the builtin `ags -i annotate quit` (island; shell: `ags -i shell quit`). Multi-word args join with spaces
(the notes `open` pattern — paths with spaces break the tokenizer, accepted
limitation). Config `set` coerces the CLI string to the existing field's type
(notes `coerceValue` pattern).

## Behaviour

### Window

- **MULTI-WINDOW: one `Gtk.Window` PER OPEN** — re-presenting a shared
  window would swap the image and the stroke stack out from under an
  annotation already in progress. Each window is built by
  `createCardFrame` (common/card/frame — transparent toplevel, no titlebar, CSS
  class `annotate`, app id `io.Astal.annotate`, 520×360 minimum); the frame
  also owns the vertical root, the header slot and the window-level key
  backstop. Each window holds its own image, stroke stack, redo stack, ink and
  popovers, and each closes/torn down independently (`teardown` drops only its
  own registry entry — see GOTCHA 3).
- `openEditor(path)` mounts a new window for a path that RESOLVES to a still
  image file (a named path that does not is refused, logged, and mounts
  nothing — `resolveTarget`); `getEditor()` answers the
  most recently opened one for the request surface (`save`), and
  `closeEditors()`/`unmountAnnotate()` walk the whole registry.
- Initial size from config `window.defaultWidth/defaultHeight` (630×450),
  min 520×360. Resizable via the generic Hyprland binds (SUPER+RMB drag,
  SUPER+CTRL+arrows — hyprland.lua, every window). The config is a **floored
  default**: a card window cannot map below its content's minimum, so
  `defaultWidth` only means anything above whatever the widest row needs. The
  header row's minimum stays below the configured width (the tool group
  scrolls, §Layout), so each window maps at its configured 630 and resizes
  above it.
- **The header row is the window's WIDTH constraint, and its cost is budgeted.**
  The row is `[tools scroller] copy save-as save`, built in `window.tsx`:
  - the LEFT group (6 tool buttons, colour well, stroke width, undo, redo,
    clear) lives in a `Gtk.ScrolledWindow` (`annotate-tools-scroll`, policy
    AUTO/NEVER, `hexpand`, `overlayScrolling` off so the house thin-pill
    scrollbar — `common/shell/theme.css`, both dimensions) STAYS visible while
    the row can scroll: the bar is the cue that controls continue off the edge;
  - the RIGHT three (copy, save-as, save) keep the shared 54px card control
    box — they are never slimmed;
  - the tool group uses annotate's own denser box
    (`window.annotate .annotate-tools .card-btn` — 32px = 20px floor + 2×6
    padding, ~2× the 14px glyph's ink, 32×28 hit area), and the header's own
    padding is trimmed to 6px per side. Both are scoped to `window.annotate`, so
    files, portal, media and notes keep the shared chrome — and both are emitted
    by mount.ts's own USER-priority provider, NOT by style.css, because in the
    shell an app-sheet rule loses to the shared chrome (GOTCHA 13).

  The arithmetic, since the row is a width budget and not a coincidence:
  **477px = 300** (`TOOLS_VIEWPORT_MIN`, the scroller's `set_size_request`)
  **+ 162** (the right three at the shared 54px box) **+ 3** (row gaps at
  `spacing: 1`) **+ 12** (header padding, 6 per side). The 11 tool controls
  need 362px (11×32 + 10 gaps), so at the configured 630 the viewport is
  453px: the whole row is visible, nothing clips, and only a window narrowed
  below the header minimum scrolls the row. Sizing the viewport is therefore
  the deliberate lever for the window's width — but it must stay under
  `defaultWidth`, or the scroller starts to drive the window's minimum again.
- **The tool row scrolls on wheel, trackpad and keyboard.** A wheel has no
  horizontal axis, so an `EventControllerScroll` (VERTICAL, consumed) maps its
  delta onto the row's horizontal adjustment (`WHEEL_PAN_PX` per notch — the
  launcher's wheel-pan pattern); a trackpad scrolls the row natively; the tool
  letters (P/H/A/R/E/T), Ctrl+Z/Ctrl+Shift+Z, Ctrl+S/Ctrl+Shift+S and Ctrl+C
  stay window-level bindings and are unaffected by focus inside the scroller.
- **CASCADE PLACEMENT — every newly opened editor.** Hyprland centres every
  float at the same spot and GTK4 exposes no position API for a plain XDG
  toplevel, so editors opened in a row would land exactly on top of each other.
  `openEditor` hands each NEW window the next cascade slot. The ORIGIN is the
  monitor's centre — where Hyprland puts a lone float, so the first editor sits
  where it always has — and each slot steps `CASCADE_STEP` (30px) down and right
  from it, so every open is offset from the one before it by exactly one step.
  The slot wraps modulo the number of steps that fit before the window would
  cross the monitor's far edge; both axes step together, so the tighter axis
  bounds the count (8 slots on this machine's 1440×900 logical output, where the
  editor maps at 804×450 — the toolbar makes it wider than the `window` config
  default; the origin is clamped into the monitor when the output is smaller
  than the window). A window can therefore never be pushed off the output. The
  newest window is still raised and focused.
- **The slot is applied by a MAP-TIME window rule, never a post-map move.**
  `placeAndPresent` (window.tsx) reads the focused monitor (`hyprctl -j
  monitors`: native resolution ÷ scale, transposed for a 90/270° transform),
  takes the size the window really maps at (`mappedSize` — the
  `get_preferred_size` minimum raised by the config default), computes the
  target and registers `hl.window_rule({ name =
  [[annotate-cascade-<slot>-<monotonic>]], match = { class =
  [[^(io\.Astal\.annotate)$]] }, float = true, size = { w, h }, move = { x, y }
  })` through `hyprctl eval`, AWAITED before `present()`. Static rule effects are
  evaluated once, when the window opens — so the first commit is already at its
  slot: no centre-then-jump flash, and no already-placed window disturbed.
  Placement can never lose an editor: an unreadable Hyprland, a rejected rule or
  a wedged hyprctl still presents the window at Hyprland's default spot.
  Registrations are serialized (one placement chain) because the effects are
  LAST-WINS — rule N must exist before window N maps.
- **The rule pins the window's size, and its NAME must be unique for the whole
  Hyprland session.** Both were established against a live compositor; each one,
  when wrong, degrades the cascade to plain centring with NO error anywhere:
  - a rule that moves a window the client then RESIZES is re-centred by
    Hyprland, so the move lands `(real − pinned) / 2` px away from where it
    asked — pinning the measured real size keeps the placement literal;
  - Hyprland SILENTLY IGNORES a `window_rule` whose name it has already
    registered in the session (a re-registered name produced no rule at all,
    while a fresh name applied immediately) — a per-process counter therefore
    breaks the cascade on the SECOND run of a session, after a shell restart or
    an app unload, because every rule it re-registers is a no-op; the name
    carries `GLib.get_monotonic_time()`, and `hyprctl eval` answering `ok` says
    nothing about whether the rule was registered.
- **The cascade is per OPEN and is the app's WHOLE placement story.** annotate
  persists no window geometry, so nothing is ever restored: a re-open is a NEW
  window and takes the next slot, exactly like the first one. The slot counter
  resets when the last editor closes (and on shell unmount), so a fresh run
  starts at the origin again; closing one of several windows never moves the
  others. Window position stays the user's to change — the generic Hyprland
  move binds (SUPER+RMB drag, SUPER+CTRL+arrows) work on an editor like on any
  other window.
- Title = the image basename.
- **Focus on `map`, not creation** (notes GOTCHA 9): the canvas grabs focus
  so the window-level key controllers (Ctrl+Z / Ctrl+S) work immediately.

### Layout

- **Header** (shared `card-header` chrome, composed by `createCardHeader`):
  tool buttons — pen (P) /
  highlighter (H) / arrow (A) / rectangle (R) / ellipse (E) / text (T), the
  active tool carrying the accent selection tint · colour well · stroke width
  · undo (Ctrl+Z) / redo (Ctrl+Shift+Z) / clear all · copy (Ctrl+C), save as
  (Ctrl+Shift+S) then save pinned right as `card-primary card-primary-icon`
  (Ctrl+S) — copy and save-as are plain glyphs, save keeps the card's ONE
  accent.
- **Icons are MDI Nerd Font glyphs, never emoji** — an emoji ships its own
  colour palette and ignores the card's ink colour, so it reads as foreign in
  a monochrome toolbar (`headerButton` also optically centres each glyph).
- **Colour selection is a well + popover, not a row of swatches:** the well
  shows the current ink; its popover carries ONE list — the colours last used
  as rounded chips, most recent first, up to six (state store, §Colour history
  — the top one is the ink a new window starts with and carries the selection
  ring when the popover opens) — plus a `Custom…` entry into
  `Gtk.ColorDialog` (wheel/editor, no alpha — strokes are `#rrggbb`). There is
  NO static palette row: `tools.colours` is the SEED for that list (an empty
  history answers the configured defaults), not a second surface. Both
  the well and the chips paint with **cairo** (`swatchArea`), not CSS: the
  shared button classes' `min-width: 0` / `padding` flatten a CSS-painted chip
  to zero width.
- **A button carrying a label owns its whole box** (the chrome's label-button
  rule, `labelButtonRowCss` in `common/css/card-chrome.ts`): the label is
  centred in the button and hover repaints that same box — never a box, border
  or highlight around the label alone. Annotate's one labelled button is the
  popover's `Custom…` (`card-btn` inside a plain Box), so no control here sits
  in a FlowBox/Grid wrapper; a row that did would carry `card-actions`, which
  flattens the wrapper's padding and its theme hover tint.
- **Stroke width lives in its own popover**: a 1–24 scale over `tools.lineWidth`,
  with the value BESIDE the slider in the family's muted status ink
  (`card-status`), not through GTK's own `drawValue`: that
  paints the number above the trough with the theme's tall scale metrics, which
  leaves the picker mostly empty space. The scale moves the value through the
  config's LIVE tree (`applyLive`, so a stroke drawn mid-drag uses the new
  width) and persists ONCE when the interaction settles — the popover's
  `closed` signal, or the window's teardown if the popover was still open:
  `value-changed` fires per integer step of a drag, and persisting in that
  handler rewrote the dotfiles-tracked config file on every frame.
- **The two pickers are ONE surface in two shapes** — `.annotate-popover` + one
  inner width (`POPOVER_WIDTH` 140 = exactly one row of six 20px chips, 4px
  gaps), so the colour picker and the width picker are the same size. The
  surface is built from the card family's tokens (mount.ts dynamic block): the
  popover NODE paints nothing (the theme's own background/padding made the
  pickers a large slab), `> contents` carries the card colour, the shared
  `--tinshell-hairline` edge, radius 10 and 6px padding, and `> arrow`
  takes the same card fill. The chips sit on a 4px grid at a 20px BOX with a
  16px cairo swatch inside it — the box is the hit area and the ring band (the
  selection/hover ring is a CSS inset box-shadow on the box, so a swatch that
  filled the box would paint over it). The chips row is a plain horizontal Box —
  one deterministic line at that width — since the six chips and their gaps are
  exactly `POPOVER_WIDTH`.
  The slider follows the suite's slider geometry
  (`apps/media/style.css` `.media-seek`: flat transparent scale, thin trough,
  10px round slider) in annotate's accent/ink. The text popover shares the same
  surface (its entry is the family's `card-path-entry`).
- **undo / redo go insensitive when their stack is empty** (`.card-btn:disabled`
  ink): both open dead, a drawn stroke lights undo, undo lights redo, a new
  stroke kills redo again — `updateUndoRedo()` is the single place that decides.
- **Body**: `Gtk.Overlay` — `Gtk.Picture` base (content-fit CONTAIN,
  renders the `Gdk.Texture`) + transparent `Gtk.DrawingArea` overlay
  (hexpand/vexpand; pointer events + stroke replay). Fit scale
  `s = min(w/imgW, h/imgH)` centred; the overlay draw func replays strokes
  under `translate(ox,oy) scale(s,s)` with a faint bounds outline.
- **Status strip** (one line): zoom % (fit scale) · image basename ·
  `unsaved` dot while strokes exist since the last save. Also the ERROR line
  — errors NEVER crash the app.

### Editing

- All stroke geometry is stored in **IMAGE space** (source-image pixels).
  Canvas and export apply the same transform composition (canvas: fit
  scale; export: scale 1 onto a pixel-sized surface) — that is the WYSIWYG
  guarantee. `renderStroke(cr, stroke, scale)` in tools.ts is the single
  render path.
- **pen / highlighter / arrow / rect / ellipse**: `Gtk.GestureDrag` —
  drag-begin pushes the stroke, drag-update mutates it (append point / move
  `to`), coordinates from `get_start_point` + `get_offset` (**never
  `get_last_event()`** — notes GOTCHA 12). A bare click in pen mode places a
  dot. Highlighter and ellipse are MODES over the same two stroke types, not
  new geometry: `freehand` + `highlighter: true` renders translucent at 3×
  width, `rect` + `ellipse: true` strokes the inscribed ellipse.
- **text**: `Gtk.GestureClick` (grouped with the drag via `click.group(drag)`
  — the same-widget click/drag conflict, notes GOTCHA 12) opens a
  `Gtk.Popover` with an entry anchored at the click; Return commits the
  text stroke (config `tools.fontSize`), Escape cancels. **Return rides the
  entry's own `::activate`** — a single-line `GtkEntry` consumes Enter itself and
  emits `::activate`, so a key controller attached to the entry NEVER sees the
  press (that is why the text tool inserted nothing at all until this was fixed);
  `commit` is single-shot so `::activate` and any other path cannot push twice.
  The popover is unparented on `closed` (an abandoned popover stays a child of
  the overlay and leaks the entry's text imcontext), and the DRAG handlers
  ignore text mode entirely, so a jittery press can neither swallow the
  placement click nor move the previous tool's stroke. While the entry is open,
  the plain-letter TOOL bindings report "not consumed" (`consumeToolKey` in the
  `keys` block): an annotation containing "pen", "rect" or "text" neither
  switches tools on its own letters nor loses them.
- **undo / redo** = the stroke stack (Ctrl+Z / Ctrl+Shift+Z, through the
  frame's window-level key backstop — `installCardKeys`, common/card/keys);
  undo pushes onto `redoStack`, any newly
  drawn stroke clears it, `clear` empties both. Loading another image runs
  `resetHistory()` — strokes AND redoStack — so a fresh image is never undoable
  into the previous one's strokes. The two header buttons follow `updateUndoRedo()`.
- Colours / line width / font size are read at use time (live tier).

### Copy (Ctrl+C / the `md-content_copy` glyph)

- Puts the annotated image on the clipboard as `image/png` and writes NO file — a
  copy is not a save, so the export path stays untouched until Save or Ctrl+S.
- Same composition as the export (`renderComposite()` — the ONE path shared with
  `save()`), rendered to a PNG because gjs cairo exposes no `writeToPNGStream`.
  The copy itself goes through `common/clipboard`'s `copyImageFile` (wl-copy —
  the GDK provider route leaves the clipboard with no selection owner here), and
  the scratch file at `<runtime dir>/annotate-copy.png` is FIXED and overwritten
  per copy, never unlinked: the detached wl-copy child reads it after the call
  returns.
- Feedback is a transient `copied` note in the status strip (self-clearing after
  1.5s) — a copy changes nothing else on screen.

### Save as (Ctrl+Shift+S / the `md-content_save_move` glyph)

- `Gtk.FileDialog` (GTK4's only chooser — there is no sync form, and a
  dismissal arrives as an error) picks a destination; the composite is written
  there verbatim and that path becomes the WORKING FILE: the title and the
  status strip follow it, and the next Save writes it instead of the derived
  `<base>-annotated.png`. Loading another image clears it.
- The write, the notification and the optional clipboard copy are the SAME code
  path as Save (`writeComposite()`), never a second implementation.
- Every modifier in the `keys` block is stated explicitly: the backstop's
  matcher treats an omitted modifier as a wildcard, so a bare `ctrl: true` on
  the plain Ctrl+S entry would otherwise swallow Ctrl+Shift+S too.

### Save (Ctrl+S / the `md-content_save` glyph / `request save`)

- Replays the image + strokes on a `Cairo.ImageSurface` at IMAGE pixel
  size → `dir/<base><suffix>.png` (default suffix `-annotated`; never
  clobbers the original). Output path is `same dir as the source`.
- After save: `notify-send` (the shell's daemon owns the bus — annotate
  itself never claims org.freedesktop.Notifications) with the path, and
  copies the path to the clipboard if `export.copyToClipboard` (default
  false).
- Load + export pipeline: `common/media/decode`'s `loadStill(path)` gives the
  `Gdk.Texture` the `Gtk.Picture` renders AND `still.surface()` — the
  `Cairo.ImageSurface` with the image's pixels, built once on first call. The
  export then replays at full size: `new Cairo.ImageSurface(ARGB32, w, h)` →
  `Context.setSourceSurface(still.surface(), 0, 0)` + `paint` → strokes →
  `surface.writeToPNG` (capital PNG — gjs binding).

## Colour history (state store)

- The colour picker remembers the ink the user actually used. The history lives
  in annotate's OWN state store (`common/state`, app `annotate`, key
  `colours`) — `~/.local/state/tinshell/apps/annotate/state.json`, NOT config and NOT
  a module variable, so it survives a window close, the shell's lazy unload
  grace (which resets module scope) and a restart.
- This history is the popover's ONLY list (`RECENT_COLOURS_MAX` 6): the last six
  used colours as one-click swatches, most recent first, **deduplicated** —
  re-using a colour moves it to the front instead of repeating.
- An EMPTY history is PRIMED with the configured defaults
  (`state.ts defaultColours()` → config `tools.colours`, deduplicated and
  capped): first run, or a cleared/removed state file, shows those six as the
  starting history rather than an empty picker. The seed is not written until
  something is used — the next `rememberColour` persists the seeded list plus
  the chosen colour, so from then on it is real history. `recentColours()`
  re-reads the file on every call (the store's mirror is per process), so
  clearing or replacing `state.json` under a running app shows the primed list
  on the next popover open — no restart needed. Deduplication spans
  both: a colour that was SEEDED and is then chosen moves to the front instead
  of appearing twice (`rememberColour` filters the whole list, seam or
  learned).
- The configured defaults are themselves deduplicated before they seed: a
  repeated colour in `tools.colours` collapses to one chip (case-insensitively,
  keeping its first spelling) instead of rendering twice — the list is both the
  picker's row and the file's content.
- The most recent colour is the PRESELECTED one: a new window opens with that
  ink (so consecutive annotations keep the same pen), and the picker rings the
  chip carrying it when it opens (`.annotate-swatch-selected`, which
  deliberately out-ranks the chip hover ring — the `.card-btn-active` lesson).
  With no history at all the ink falls back to `tools.colours[0]`, which the
  priming normally answers already.
- Every real colour change records the colour: a chip click, a `Custom…` pick,
  and the initial ink a window mounts with. Re-using the current ink is a no-op
  (no state write), so opening windows cannot churn the file.
- The palette itself stays config — `tools.colours` is the seed SOURCE and the
  fallback ink; only the list the picker shows is state.

## Config

`config.defaults.json` + `config.schema.json` + thin `config.ts` over the
shared loader via `createAppStore` (notes pattern). Keys: `appearance.*`/`window.*` **restart**
(the dynamic CSS block is assembled at startup — notes convention),
`tools.lineWidth`/`tools.fontSize`/`tools.colours`/`export.*` **live** (read
at use time). `tools.colours` is read as the picker list's SEED and as the ink
fallback (state.ts `defaultColours()`); `export.suffix` at save time.

## Files

- `app.ts` — entry (createApp; quit-on-window-removed lives in window.tsx);
  the `fileSink` is set up in `mount.ts`.
- `mount.ts` — the CSS assembly (`cardAppCss`: theme + static stylesheet +
  the shared card theme/chrome + annotate's own dynamic rules) + the log
  sink + the USER-priority provider that carries the chrome OVERRIDES (the
  header row's denser box and trimmed padding — GOTCHA 13).
- `window.tsx` — the editor window
  factory + the multi-window registry (openEditor/getEditor/closeEditors;
  save/load/close; gestures; the three popovers); loads and
  exports through `common/media/decode`; the cascade placement
  (`CASCADE_STEP`, `cascadeSlot`, `monitorBox`/`mappedSize`/`cascadeTarget`/`placeAndPresent`
  — the awaited map-time rule, named per registration).
- `tools.ts` — ToolMode/Stroke types, hexToRgb, renderStroke (the single
  canvas+export render path).
- `state.ts` — the persisted colour history behind the colour picker — the
  popover's only list — and its priming from the config defaults
  (`recentColours`/`defaultColours`/`rememberColour`, common/state app
  `annotate`).
- `commands.ts` — request handlers (ping/open/save/close/config).
- `config.ts` + `config.defaults.json` + `config.schema.json`.
- `style.css` — annotate's own pieces only (the cairo colour well/chips, the
  transparent canvas, the tool row's scroller surface and the LEFT group's
  denser control box); the header/status chrome and every colour come from
  the shared card scaffold (`common/card/*` + `common/css/card-chrome.ts` +
  `card-theme.ts`), emitted by `mount.ts`.
- `run.sh` — 1-line shim to the shared bundler (forwards argv).
- `tinshell-annotate.desktop` — a LAUNCHER entry, deliberately with no `MimeType`:
  annotating is an explicit action, so a double-clicked image belongs to the
  viewer and annotate is reached from the screenshot action or this entry.
- `ensure-open.sh` — the notification-action launcher (a thin wrapper over the
  shared router: `tinshell-route.sh annotate open <path>`; the router owns
  warm-vs-cold routing and any cold start).
- `AGENTS.md` — this spec.

## Integration (the dock hook)

The dock's ScreenGrab still path (common/applets/screengrab/menu.tsx
`runCapture`) sends the success notification as an **in-process**
notification through the shell's own notifd
(`apps/notifications/Notifd.ts`) with an `annotate` action; that action is
handled in-process by a registered action handler (`registerActionHandler`)
that `spawnDetached`s `ensure-open.sh <file>`. The row also carries a `preview`
action, which belongs to the media app (the capture shown in a media window)
and does not touch this one. Rationale: AstalNotifd gir
0.1 exposes **no** `notify()` on the daemon, and a shelled-out notification
dies with the sending process, so a notification action could never invoke.
Popup lifetime note: the popup auto-hides after `popup.timeout` (10s) while
the notification persists in the CENTER — a slow user finds "Annotate"
there. `config.screengrab.notify` still gates the notification.

## GOTCHAS

1. **`annotate` is NOT a layer-shell app.** No `Astal.Window`, no layer rule
   — plain `Gtk.Window` (the notes/files pattern).
2. **No systemd unit.** Do not add `tinshell-annotate.service` to setup.sh's
   unit loop — the app quits with its window by design. setup.sh only needs
   `run.sh` + `ensure-open.sh` in its chmod list + the `annotate-float`
   Hyprland verification grep.
3. **The window's `destroy` signal is NOT a cleanup hook — every close path
   clears the handle first.** In gjs the JS handle keeps the Gtk.Window alive
   through `gtk_window_destroy` (dispose never runs) and the signal was
   observed never to fire; a handle left behind points at a DESTROYED window,
   the next open calls `present()` on it and GTK re-shows it as a ZOMBIE no
   close can remove (files/AGENTS.md GOTCHA 15 carries the full failure shape).
   Contract: `win.connect("close-request", () => { teardown(); win.destroy();
   return true })`; `handle.close()`, `closeEditors()` (the `close` request) and
   the shell unmount (`unmountAnnotate`, which walks every open window) run
   `teardown()` BEFORE `destroy()`. `teardown()` is idempotent and — in the
   multi-window registry — removes ONLY ITS OWN handle from `editors`, arming
   `scheduleUnload` when that was the last one. Never defer to the default
   handler
   (`() => false` closes nothing this contract does not) and never rely on the
   `destroy` signal — it stays wired as a backstop only. Never `present()` a
   window you cannot prove is in `editors`.
4. **The window rule matches `class = "^(io\\.Astal\\.annotate)$"`** — the
   GTK4 app_id (from applicationId; the pattern is built from
   `ANNOTATE_APP_ID`). A bare `annotate` class matches
   nothing.
5. **gjs cairo bindings differ from the C API**:
   methods are camelCase (`moveTo`, `setSourceRGB`, `writeToPNG`), the
   Context is `new Cairo.Context(surface)`, `ImageSurface.createFromPNG`
   exists but `createForData`/`getData` do NOT, and `writeToPng`/`move_to`
   are not functions. `common/media/decode` turns a `Gdk.Texture` into a Cairo
   surface through
   `texture.save_to_png(tmp)` → `createFromPNG(tmp)` (the gjs bindings expose
   **no** `createForData`/`getData`), memoised on the still.
   **`Gdk.Texture.download(buf, stride)` returns without throwing and never
   fills the buffer.** The surface built from it is empty, so the export
   silently comes out with no image in it — transparent pixels that every
   viewer renders as white — while the on-screen `Gtk.Picture` still looks
   correct, because the picture binds the texture and not the surface. Never
   route texture pixels through `download()` — the temp-PNG round-trip in
   `common/media/decode` is the working path. Check an export
   by its file size: it should be within a few hundred bytes of the source
   screenshot, not a twentieth of it.
6. **AstalNotifd has no daemon `notify()`** (gir 0.1) — in-process
   notifications use `AstalNotifd.send_notification(n, cb)` + `n.add_action(
new AstalNotifd.Action({ id, label }))` — the constructor takes a properties
   object and positional args throw, aborting the notification; action presses
   are intercepted in
   `invokeAction` via `registerActionHandler` (n.invoke() only round-trips
   to the sender, which is dead for our own notifications).
7. **`get_last_event()` returns null at drag-begin** (notes GOTCHA 12) —
   GestureDrag coordinates come from `get_start_point` + `get_offset`;
   GestureClick + GestureDrag on the same widget are GROUPED
   (`click.group(drag)`). A gesture type the current tool does not use must be
   ignored EXPLICITLY: both drag handlers return early in text mode, without
   which a press with pointer jitter mutated the previous tool's stroke through
   `drag-update` (and its `draggedThisPress` flag swallowed the placement clip).
8. **No backticks inside the `cardAppCss` extra block** (mount.ts) —
   silent cold-start bundle break (notes GOTCHA 13).
9. **Never clobber the original screenshot** — output always carries the
   `-annotated` suffix in the source's directory.
10. **Test-window discipline (mandatory):** live and visual checks are made by
   hand, so a change ships static verification (tsc + a real bundle) plus the
   exact keystrokes needed to check it. Never open the annotate window to
   inspect your own work; when a window IS opened for a live check, never open
   it on
   the ACTIVE workspace. Pin probe windows to a spare workspace (`hyprctl
dispatch 'hl.dsp.focus({workspace = N})'`), restore workspace + keyboard
   focus immediately, kill every test process by exact PID before the turn
   ends. A notification-action-launched app's stderr is lost — run `run.sh`
   in the foreground (or capture to a file) to see errors.
11. **Window-rule mechanics the cascade depends on.** Static effects are
   evaluated ONCE, when the window opens — that is what makes the cascade work
   (register the rule, THEN `present()`) and what makes a late rule useless: a
   rule registered after a window mapped never applies to it. Those effects are
   LAST-WINS, so the newest `annotate-cascade-…` rule decides the slot of the
   next annotate window that opens — hence the serialized placement chain in
   window.tsx (two rapid opens with interleaved registrations would land on the
   same slot). A rule name may be used only ONCE per Hyprland session: a
   re-registered name registers NOTHING and `hyprctl eval` still answers `ok`,
   so the name carries a monotonic stamp (see §Behaviour → Window). A move whose
   window the client then resizes is re-centred by Hyprland, which is why the
   rule pins the measured size as well. The registration form is `hyprctl eval
   "hl.window_rule({...})"`: `hyprctl dispatch` rejects `window_rule` (config
   scope, not a dispatcher). Runtime rules live for the Hyprland session, one
   per open — they match only `io.Astal.annotate` windows, which only annotate
   opens.
12. **A card window cannot map below its content's minimum — the config size is
   a FLOORED default.** `window.defaultWidth`, the `annotate-float` rule's
   `size` and `createCardFrame`'s `set_size_request(520, 360)` are all
   *requests*: GTK maps a window at the largest of them and the widget tree's
   minimum requisition, and publishes that minimum as the toplevel's min size,
   so the compositor cannot shrink it below either. Any control added to that
   row adds to the minimum, which is why the tool
   group scrolls (`TOOLS_VIEWPORT_MIN`, §Layout) instead of widening the window,
   and why the scroller's viewport must stay under `defaultWidth`.
13. **An app-sheet rule cannot out-rank the shared card chrome in the SHELL.**
   The shell's boot sheet carries the card chrome (`portal` is an eager card
   app) and the TINSHELL shim adds it at `STYLE_PROVIDER_PRIORITY_USER`, while a LAZY
   app's own sheet goes in at `STYLE_PROVIDER_PRIORITY_APPLICATION`
   (common/app/lazy). GTK compares provider PRIORITY before specificity, so
   `window.annotate .annotate-tools .card-btn { … }` in `style.css` loses to the
   shared `.card-btn` however specific it is, while the app's own sheet IS the
   USER-priority one in an island — the same rule therefore behaves
   differently per host.
   Rules that must beat the shared chrome belong in mount.ts's own USER-priority
   provider (`CHROME_OVERRIDES`, the keyboard app's pattern) — applied once per
   process and never removed.

## Optional integrations (DEFERRED — do not implement in v1)

- Zoom/pan, crop, blur/mosaic tools, sticker insertion, layers.
- Export-to-clipboard-by-default (the toggle exists; flipping the default is
  a product decision).
- A dock applet step "Annotate" opening the LAST capture (notification
  action is the v1 hook).
- Notes Ctrl+S → files reveal style integration (after save → files reveal
  the output).
