# AGENTS.md — TINSHELL files app

Part of the TINSHELL multi-app home. **READ the repository root `AGENTS.md` FIRST** —
the multi-app rules (one app = one explicitly-named bus, launch path via
`tinshell-host.sh` (the universal bundle), `ags -i <app> request` addressing, onboarding, common
modules) apply to everything in this file. This file is the app-specific
spec; the root file is the cross-app contract.

`files` is a floating, frosted, keyboard-driven file manager — the suite's
file browser. One plain `Gtk.Window` per open browser (a normal XDG toplevel,
NOT layer-shell), so Hyprland's window management (float rule, rounding,
move/resize) applies like any other window; `files new` opens additional,
fully independent windows. It is a **desktop app**: launched on demand, quits
when its LAST window closes. No systemd unit, no layerrule — the notes
pattern.

## SPEC MAINTENANCE

- **The spec in this file is the source of truth.** When code changes alter
  behaviour, visuals, or architecture, update this file as part of the change
  — autonomously, not as a follow-up. Give a summary of spec changes after
  each code edit that affects it. If spec and code disagree, the spec is
  wrong until updated.

## Identity

| | |
| --- | --- |
| Dir | `files/` |
| Instance / bus | in shell: inside the shell instance (`io.Astal.shell`); dev island: `files` (`io.Astal.files`) — addressed `ags -i files request "files …"` / `ags -i files quit` |
| Window class | `io.Astal.files` (GTK4 app_id; matched by the `files-float` window rule) |
| Window rule | `files-float` in hyprland.lua — float, rounding 14, `decorate = true`, `border_size = 1`, `size = { filesW, filesH }` read from config `window.width`/`window.height` (620×390) — the startup-race fix, mirroring notes-float |
| Keybind | **NONE** — the browser is opened through the desktop entry (`tinshell-files.desktop`, `Exec = files/ensure-open.sh %f`), so anything that calls `xdg-open` on a folder lands here |
| Layerrule | **NONE** — XDG window, not a layer surface. Frost = GLOBAL blur + translucent card, exactly like notes. |
| Unit | **NONE — by design.** Interactive desktop app; the ISLAND quits when its LAST window closes. In SHELL the app is LAZY: loaded on the first `files …` request, unloaded ~60s after the last browser window closes (`scheduleUnload("files")` in window.tsx, armed only when the window registry is empty; `destroyBrowser` as unmount closes every window). Do NOT add `tinshell-files.service` to setup.sh's unit loop (same exception as notes). |
| Log | fileSink → `/tmp/tinshell-files-debug.log` (launched from a desktop entry — stdout/stderr are lost) |

## Launch path & lifecycle

- **`xdg-open` on a folder** runs `files/ensure-open.sh` (the desktop entry's
  `Exec`), a thin wrapper over the shared router: the router probes the live
  instances, cold-starts the map's first instance when none serves the app (the
  spawn is `flock`-serialized on that instance, so two concurrent requests — for
  any app that maps to it — cannot race two spawns) and then delivers the request.
  The wrapper always asks for a NEW window — `files new [path]` — because an
  xdg-open request must never retarget the browser the user already has open.
  `open` stays the surfacing verb on the request surface (focus/navigate the
  window a request acts on). The cold path is the same shape: the router boots
  the instance (which mounts NO window) and then delivers `files new`.
- **Multi-window:** `files open` surfaces the window a request acts on (the
  compositor-activated one, else the newest) and creates a window only when
  none is open; `files new [path]`, the header's new-window button and
  `Ctrl+Shift+N` always add another independent window. Every window owns its
  own widgets, listing state, directory monitor, config subscriptions and
  teardown — there is no shared window handle, and a closing window drops its
  own handle BEFORE the destroy (GOTCHA 15), so the windows never interfere.
- **Cold-start argv forwarding** (notes GOTCHA 5): `run.sh` FORWARDS extra
  argv → shared run.sh → `exec "$OUTFILE" "${@:2}"` → app.ts
  `main(...argv)`. The DIRECT `run.sh open <path>` cold start therefore opens
  the requested directory itself and must NOT also issue a bus request (the
  directory would open twice). The router path never passes argv: it boots the
  instance and delivers the request afterwards, so an instance started that way
  mounts no window until the request arrives.
- **Quit-on-window-close:** `app.connect("window-removed")` → no windows
  left → `app.quit()` (immediate, no idle linger) — with several windows open,
  closing one therefore never quits. Explicit
  `ags -i files quit` works too.
- **No bare `ags run`** — never. `run.sh` is the 1-line shim to the shared
  bundler (per-app hashed outfile; bundle cache at
  `~/.cache/tinshell-bundle/files/`). Measured cold ~1-3s first build, ~0.6s warm
  (bundle-cache hit).
- **Manual restart race:** the router owns cold-starting (`ensure-open.sh` only
  forwards the request), so the register-race window never applies to normal
  use. For manual debugging, wait for `io.Astal.files` to
  release (`dbus-send … NameHasOwner`) before relaunching.

## Request API

| Command | Args | Returns |
| --- | --- | --- |
| `ping` | — | `pong` |
| `open` | optional `<path>` | `ok` — surface the browser: focus the window a request acts on (compositor-activated else newest); with a path, navigate to it (`~` expands); without, the startup dir. Creates the window only when none is open — another window comes from `new`. This is the SURFACING verb: `xdg-open` uses `new` (see the launch path), and a cold-started instance receives this request after it boots |
| `new` | optional `<path>` | `ok` — always open ANOTHER independent window (multi-window, the `media new` shape); without a path it opens the startup dir. The header button and `Ctrl+Shift+N` open the ORIGINATING window's directory instead |
| `navigate` | `<path>` | `ok` — same as `open <path>` but errors if no window |
| `up` / `back` / `forward` / `reload` | — | `ok` |
| `close` | — | `ok` — close the window a request acts on (ACTIVE = compositor-activated else newest), the other windows stay open / `error: no window` when none is open. Internally `closeActiveBrowser()` → the frame's `close()`, which emits that window's `close-request`; never hyprctl window-close. The `close-request` handler runs `teardown()` — drops that window's handle + arms the lazy `scheduleUnload("files")` once it was the LAST one — and only then destroys the window, so the close always takes the same path the WM's own close takes. In a pure-lazy island the close of the last window also quits the app, which can cut the reply off. |
| `toggle-hidden` | — | `hidden: on\|off` — LIVE re-filter from the cached listing (no re-enumeration) |
| `mkdir` | `<name>` | `ok` / `error: <msg>` — creates in the CURRENT directory |
| `rename` | `<new-name>` | `ok` / `error: <msg>` — renames the SELECTED item |
| `trash` | — | `ok` — trashes the SELECTED item (async: confirm dialog may show; result lands in the status bar). Permanent delete if `trash.useTrash=false` |
| `reveal` | `<path>` | `ok` / `error: <msg>` — navigate to the parent dir and select the item (dock/launcher hooks). The SELECTION lands after the async enumeration — callers should not immediately follow with `rename`/`trash` |
| `config get\|set\|reload\|all` | per convention | JSON value / `ok` / `reloaded` |

Quit is the builtin `ags -i files quit` (island; shell: `ags -i shell quit`). Multi-word args join with spaces
(the notes `open` pattern — paths with spaces break the tokenizer, accepted
limitation). Every per-window command (`navigate`, `up`, `back`, `forward`,
`reload`, `toggle-hidden`, `mkdir`, `rename`, `trash`, `reveal`, `close`)
addresses the ACTIVE window. Config `set` coerces the CLI string to the existing field's type
(notes `coerceValue` pattern). `config set` on `view.*`/`trash.*` (live tier)
triggers an immediate re-render via the window's `refresh()`.

## Behaviour

### Window

- Multi-window: ONE `Gtk.Window` per open browser, each built by the shared
  card frame (`createCardFrame` — `common/card/frame.ts`), which owns the css
  class, the app id, the minimum size and the key backstop. `window.tsx` keeps
  the registry (`browsers`, oldest first, plus the active-window pointer) and
  every window owns its own widgets, state and teardown — there is no shared
  window handle anywhere.
- `open` surfaces the window a request acts on and navigates it; `new` (the
  request, the header button or `Ctrl+Shift+N`) always adds a window; cold
  start creates the first one at the requested path.
- The ACTIVE window — what every per-window command acts on — is the
  compositor-activated one (`notify::is-active`, wired per window), else the
  newest. So `files close` and `files navigate …` follow the window the user
  last clicked, not merely the last one created.
- Frameless (`set_titlebar(null)`), class `io.Astal.files`, CSS class
  `files`. Initial size from config `window.width/height` (default 620×390),
  min 520×360 (`set_size_request`). Resizable via the generic Hyprland binds
  (SUPER+RMB drag, SUPER+CTRL+arrows — hyprland.lua, every window).
- Title = the current path (Hyprland window matching/overview).
- **Focus on `map`, not creation** (notes GOTCHA 9): `win.connect("map", () =>
  view.grab_focus())` — without it keyboard input goes nowhere.
- **hexpand/vexpand on EVERY layout level** (notes GOTCHA 9): header box,
  path bar, scrolled window, column view, status bar — or the content
  collapses to ~0.

### Layout

- **Header** (one row): back / forward / up buttons (MDI glyphs) · custom
  **path bar** (Gtk.PathBar does not exist in GTK4 — a horizontally-scrolling
  `Gtk.Box` of segment buttons, each navigating to its prefix; root is a
  home glyph; chevron separators; scrolls to the end after rebuild — plus the
  editable mode below) · new-folder button (folder with a plus) · new-window
  button (two stacked windows with a plus — `Ctrl+Shift+N`) ·
  hidden-toggle button (folder-hidden / folder-eye) ·
  preview-toggle button (eye / eye-off, the shared preview switch) · reload. The
  row, its buttons and the path bar are the shared card pieces
  (`createCardHeader` / `headerButton` in `common/card/header.ts`,
  `createCardPathBar` in `common/card/path-bar.tsx`).
- **The header runs DENSER than the shared card chrome**: the eight glyph
  buttons at the shared 54px box (34px floor + 2x10 padding) are ~430px of the
  620px window, which leaves the path bar a sliver of its own row. The dense
  rules therefore cannot live in this app's own sheet — in a resident instance
  the boot sheet carries an eager card app's chrome at
  `STYLE_PROVIDER_PRIORITY_USER` while a LAZY app's sheet arrives at
  `STYLE_PROVIDER_PRIORITY_APPLICATION` (`common/app/lazy`), and GTK compares
  provider PRIORITY before specificity — so `mount.ts` hands them to
  `applyChromeOverride` (`common/card/chrome-override`), which owns the USER
  priority and the once-per-app, never-removed provider rule.
- **Body**: the shared card listing (`createCardDirList` —
  `common/card/dir-list`): a `Gtk.ColumnView` over a `Gio.ListStore` of files'
  own row objects behind a `Gtk.SingleSelection` (autoselect=false; selection is
  managed by the window — restored by path after reloads, `pendingReveal` wins,
  else first row). The factory owns the scroller and the empty-state label in a
  **list area**, the column set and its cell factories, the sorters and the
  header's sort read-back, the status/error line, the hidden-entries toggle's
  glyphs and the navigation history; the window supplies its row class, the
  columns' text and glyphs (`glyphFor`, `formatBytes`, `formatDate`), the order
  policy and what activating a row does.
  Columns: **icon+name** (expand, ellipsized), **size** (right-aligned),
  **modified** — size/modified columns appear/disappear per the LIVE
  `view.showSize`/`view.showModified` config (the window's `visibleColumns`).
  Cells are built by `Gtk.SignalListItemFactory` (setup → build widgets; bind →
  set from the row's `entry` field; the DirEntry rides on a plain JS field of
  the row GObject — no ParamSpecs). **Sorting is header-driven and happens at
  RENDER** through fs.ts `compareEntries` (the window's `compare` policy: dirs
  first + the chosen key, ties broken by
  `Intl.Collator("en", {sensitivity:"base"})` name-ASCENDING in both directions
  — the direction applies to the sorted column, not to the tie-break) — the
  store stays the source of truth. Every column carries a `Gtk.CustomSorter`
  built from that same comparison, which is what makes its header a sort
  control: GTK gives the header button and the indicator arrow only to a column
  that has a sorter, and the click lands in the view's own
  `GtkColumnViewSorter` (that column ascending, a second click inverting it).
  The listing reads that choice back (primary sort column + order) and calls
  `onOrderChanged` → render, so the store keeps the order the window computed
  and the view's sorter is never attached to a sort model. The listing opens
  name-ascending, which is the sort the arrow names.
  A sort whose column the live config hides (`view.showSize`/`view.showModified`
  false) falls back to the name column, keeping the direction, so the arrow
  always names the order the listing is in.
  The list area sits in a horizontal body row beside the optional preview pane
  (see below); with the pane off the body row holds the list area alone and
  changes nothing about how the scroller and the empty label share the window.
- **Status bar** (one line, `common/card/status-bar.tsx`, created and painted by
  the shared listing): selected item / item
  count / free space
  (`filesystem::free,size` queried per navigate; network mounts → null,
  wrapped in try/catch). Also the ERROR line — errors NEVER crash the app.

### Path bar (editable)

The bar is breadcrumbs by default — every segment navigates to its own prefix —
and an EDIT MODE swaps that same row for a `Gtk.Entry`. The mode is the shared
bar's own API (`common/card/path-bar`: `beginEdit` / `endEdit` / `setPath` over
a two-child `Gtk.Stack`), so the breadcrumb row and the entry share the
header's one title slot; the entry keeps the segment buttons' metrics (CSS
`card-path-entry`), so the header row does not change height. Edit mode
pre-fills the entry with the current directory, text selected, cursor at the
end, focus on the entry.

- **Two ways in:** `Ctrl+L` (the window's own key table) and a click on the
  bar's empty tail right of the last segment. A click on a SEGMENT stays a
  navigation: the segment buttons claim their presses, and the tail gesture
  only fires right of the last segment's right edge.
- **Enter** hands the typed text to `commitTypedPath`, which resolves it
  through `absolutePath` (`~`, `file://` and relative paths included — never
  ad-hoc string handling; tilde expansion is the shared `expandTilde` of
  `common/path/complete`, the ONE implementation every tilde expansion in the
  repo goes through, and `absolutePath` keeps only the `file://` handling and
  the absolute-form fallback) and navigates only into an existing directory.
  `checkDir` opens the directory the way the listing does and closes it again,
  so a path that is gone or cannot be read answers the LISTING's own error
  text: it lands on the status bar exactly like a failed navigation, does not
  navigate, and leaves the entry (and its text) open for correction. A typed
  file is refused the same way.
- **Type-ahead** (`createPathAutofill`, the shared cycle every path entry in
  the home uses — `common/path/autofill` over `common/path/complete`): `Tab`
  completes the typed path to the next match under its parent, `Shift+Tab`
  cycles back, and the non-committed ghost is shown as a selection (so what
  Enter would commit is visually distinct). The cycle is gated on
  `isPathShaped`, so `Tab` in an entry holding an ordinary word stays GTK's
  focus move. A `*`/`?` pattern in the LAST segment previews that directory's
  matches, newest first — the chosen one REPLACES the pattern with a concrete
  path, and Enter then commits it through `commitTypedPath` as usual (a dir
  navigates; a matched file is refused with the listing's own error, the
  entry staying open). The cycle is reset on every `beginEdit` and
  `endEdit`, so no edit session inherits the previous one's candidates.
- **Escape** leaves edit mode without navigating. The breadcrumbs that return
  always describe the CURRENT directory: the bar defers the segment rebuild
  while the entry is on screen, so a failed attempt or a directory change made
  from elsewhere (a `files navigate` request, the directory monitor) lands in
  the restored breadcrumbs.

### Preview pane (`common/media/preview`, OFF by default)

An optional preview slot beside the listing that FOLLOWS the ColumnView
selection. The widget itself is the shared media surface
(`createMediaPane` — `common/media/pane`); files owns only the policy: whether
it is on screen, the slot shape and where the pane's open action lands
(`preview.tsx`). The feature ships OFF — an opt-in feature must not silently
change the browser's layout.

The portal chooser mounts the same pane and the same shape (a places rail
beside a card listing the pane displaces), so the two hosts behave alike: the
listing narrows in place and nothing in the window moves.

**The SWITCH is per window; the width and mode are shared.** `common/media/preview`
still owns the one preference — its own state store
(`~/.local/state/tinshell/apps/media-preview/state.json`, NOT this app's config or
state file) — but the stored `enabled` value is the LAST APPLIED setting, not a
live broadcast: each window creates a `PreviewSession` (`createPreviewSession`)
that starts from it, and a flip in one window never moves another window's pane.
Two open browsers (or a browser and an open dialog) therefore keep their own
switches, and a NEW window — in either host, in any process — is the only thing
the store decides. The portal chooser mounts the same pane and reads the same
preference, so the width is one number for both hosts (in the shell through the
in-process subscription, in dev through the module's `Gio.FileMonitor` on that
file). The write path for the stored values is the media app's request surface
(`media preview on|off|toggle|mode pane|full|width <px>|status`), so files'
`preview.*` config keys are gone — one preference, one owner, one writer.

| Setting | Meaning | Scope |
| --- | --- | --- |
| `enabled` | the feature switch (nothing stored = `false`) | the last applied setting: a new window starts here, an open window keeps its own |
| `mode` | `pane` (a side slot) \| `full` (the pane IS the body) | shared |
| `width` | side-slot width in px (default 260, floor `PREVIEW_MIN_WIDTH`) | shared — the divider's drag writes it |

The header's preview button (eye / eye-off) mirrors and flips THIS window's
session. The hidden-entries toggle carries its own glyph pair (md-folder_hidden /
md-folder_eye) — the preview toggle owns eye / eye-off, and two identical eyes
in one header name nothing.

The pane is on screen while this window's switch is on.
`pane` puts the pane in a `Gtk.Paned` beside the list area, seeding its divider
from `width` and re-persisting whatever the user drags it to; `full` gives the
pane the whole body and hides the listing (`Up`/`Down` then drive the
selection through the window's key table, since the hidden view's keynav is
unreachable).
- **The pane keeps a minimum size or is closed.** `PREVIEW_MIN_WIDTH` (200px —
the pane's own detail grid measures ~150px at the shipped body font, so a
narrower slot clips the values it exists to show) is the pane's own size
request, owned by `common/media/pane`, and it is the width the shared divider
(`common/media/divider`) HOLDS a drag to: the position stops at the pane's own
edge, so the pane keeps the floor's slot and no sliver is left on screen whatever
the pointer does past it. Only a drag driven below `PREVIEW_SNAP_SHUT_WIDTH`
(100px, half the floor — a deliberate overshoot, not a nudge past it) folds the
pane shut — the divider moves to the
far end, the window's switch turns OFF, and the toggle glyph flips to eye-off.
The stored width is written only from a pane that
sits beside a visible list (in `full` mode the pane IS the body, and the body's
width must not come back as a side-slot width) AND only when the window could
host the stored width — a fold a window too small forced is not the user's
choice, so it neither overwrites the width the user chose nor becomes the
setting the next window starts from. A fold writes no width at all, and the snap
band is drag-time only: a STORED width below the floor is still rejected
(`isWidth`). Switching the preview back on re-seeds the
pane at the stored width, and a drag that ends at or above the floor stores the
measured width.
  The judgement rides on the paned's `notify::position` — a drag-driven width
  change — once the pane has been laid out: the seed's own position and the
  paned's clamp of it both arrive before the pane has ever been allocated, and
  are not a drag past the floor (a window too narrow for the pane closes it when
  the user drags, not on the way in), and it is the same rule a RESIZE meets: a
  paned that clamps a position notifies the clamp, so a window narrowed below the
  divider is judged like a drag — the pane is left at its floor or closed, never
  narrower than its floor — while a resize that clamps no position changes none
  and is not judged at all (the pane takes the freed space and the stored width
  stands).
- **The listing is never squeezed below its own minimum.** `GtkPaned` hands a
  start child it cannot fit below the divider position its MINIMUM size,
  anchored at the divider — the child's content then slides out of the left edge
  instead of narrowing. The shared divider sets `shrink-start-child` FALSE for
  that reason, so neither the seed nor a drag can push the divider into the
  listing: the pane takes the width that is actually free. With the default
  620x390 pin the listing's minimum is small enough that the pane always fits;
  `window.width` is what decides how much the listing keeps.
- **The divider leaves the scrollbar alone.** `GtkPaned` claims a press
  anywhere in its handle area — the separator rect grown by 6px on every side
  (gtkpaned.c `HANDLE_EXTRA_SIZE`, capture phase) — and the listing's overlay
  scrollbar sits exactly at that edge, so the claim would swallow the
  scrollbar's presses. The shared divider therefore keeps that strip clear as a
  permanent margin on the list area, which is also there while the preview is
  off (a standing ~8px gutter at the listing's right edge).

- **What it renders.** A still image from the shared media-kind predicate
  (animated images included — their first frame) inline, with a `W × H` detail
  line. Video, audio, folders and anything undecodable draw their kind glyph
  plus an explicit **open** action instead: a browser pane never autoplays —
  no MPRIS claim, no audio device, no pipeline — so a video the user arrows
  past cannot take the transport or the speakers.
- **Open action.** The pane's button runs the same row open the list does (a
  still → the viewer through `tinshell-route`, a folder → navigate, anything else →
  the xdg-mime default), and it drops the click if the selection moved off the
  item the pane is holding.
- **Pinned size is the whole discipline.** The `files-float` rule pins the
  toplevel to `window.width`x`window.height` (default 620x390) at map, so the
  pane's width is a MINIMUM inside that slot and every paintable it binds is
  wrapped in `NullIntrinsicPaintable` (a paintable reporting its own intrinsic
  size makes `Gtk.Picture` drive the toplevel's natural size after map and
  fight that pin — see GOTCHA 17). At 620 wide a side pane leaves the listing
  narrow; pair it with a larger `window.width`.
- **Lifetime.** `preview.follow(entry)` releases the previous item before the
  next one loads, and the window's `teardown()` calls `preview.dispose()` —
  the same path the lazy unload runs — so no decoded image outlives the window.
  A selection-preserving re-render (every reload rebuilds the row models) is
  suppressed by a `(path, size, mtime)` identity: a file overwritten in place
  re-decodes, an unchanged one does not.
- **The preference subscription follows the window.** `teardown()` drops the
  window's `PreviewSession` subscription (and disposes the session) beside the
  config-store one; a switch flip in this window, a fold the divider made, or a
  shared width/mode change re-renders the listing (pane layout + toggle glyph)
  and re-follows the selection in the same turn.

### Keyboard (window-level `Gtk.EventControllerKey` backstop)

The bindings are DECLARED to the frame (`common/card/keys.ts`: `installCardKeys`,
installed once by `createCardFrame`), so the window has one controller and one
key table instead of a per-window controller with an if-chain. Modifier flags
are tri-state per binding (`true` = required, `false` = must be clear, omitted
= not tested), which is what lets `Ctrl+H` bind without Shift, `Delete`
require a bare press, and `Ctrl+N` / `Ctrl+Shift+N` stay two separate
bindings — the new-folder binding declares `shift: false` because a
first-match-wins table with an untested modifier would swallow the chord.
The chord binds BOTH keyval spellings (`Gdk.KEY_n` and `Gdk.KEY_N`): a
shifted press arrives as the SHIFTED keyval (Ctrl+Shift+N = `KEY_N`), while
CapsLock delivers `KEY_n` with Shift still held — annotate's
Ctrl+Shift+S/Z rule. A single-spelling binding is silently dead.

- Enter / double-click: open (dir → navigate; a file the shared media-kind
  predicate accepts — `isStillImage`, `common/media/classify` — →
  `tinshell-route media open <path>`, everything else → the xdg-mime default app).
  Return is
  consumed by the ColumnView's activate-item action on activatable rows; the
  window controller is the fallback (never double-fires). The router fallback
  is a PROCESS check, not a reply check: `tinshell-route.sh` exits 0 even for an
  `error:` reply, so an extension the viewer rejects opens nothing at all.
  `common/media/classify`'s image set is the verified-decodable one, which is
  what keeps the routing and the viewer agreeing.
- Backspace / `Alt+Up`: parent dir · `Alt+Left`/`Alt+Right`: back/forward
  history · `Ctrl+H`: toggle hidden (live) · `Ctrl+R`: reload · `Ctrl+N`:
  new folder (promptd input) · `Ctrl+Shift+N`: new window on this window's
  directory · `Ctrl+L`: type a path (the path bar's edit
  mode) · `Delete`: trash selected (confirm per config).
- While the path bar's entry is on screen it takes Return and Escape before
  anything else (the bar's own controller, at the CAPTURE phase, so GtkEntry's
  own activate cannot swallow the commit): Return resolves the typed path,
  Escape leaves edit mode.
- Home / End / PageUp / PageDown / arrows: native ColumnView keynav. `Up`/
  `Down` stay the ColumnView's own keys — the window controller consumes them
  only for the preview pane's `full` mode (`stepSelection` returns false
  WITHOUT touching the selection whenever the list is on screen), because that
  mode hides the list and the view's keynav is unreachable there.
- F2 rename / Ctrl+T tabs: **v2 — not in v1**.
- Close: the existing generic SUPER+Q (hyprland.lua), not an in-window bind.

### Icons

- **v1 default: Nerd Font glyphs by type** (MDI set — pick/verify with the pi
  `nf` tool: `nf search <name>`, `nf audit apps/files`). `glyphFor(entry)` maps
  extension → codepoint (folder/text/image/audio/video/archive/pdf/code/
  executable/symlink/database + common formats: jpg, png, gif, zip,
  html/css/js/py/c/cpp/go, doc/xls/ppt…); each constant in `fs.ts` carries its
  cheatsheet name as a comment. Every MDI codepoint sits above the BMP, so the
  escape MUST use the brace form — `"\u{f024b}"` is the folder, while the same
  digits written unbraced parse as U+F024 followed by a literal `b` (one wrong
  icon plus one stray character per row). The shared header glyphs come from
  `common/card/header.ts` (`GLYPH`), same rule. Unmapped extensions → generic file
  glyph (the long tail is accepted). Classification by `standard::type` +
  extension (NOT `standard::content-type` — extra queries per row are slow on
  big dirs; content-type is a v2 refinement).
  Executable bit from `unix::mode` (one batch query, not per-file).
- `view.iconStyle: "theme"` (Gtk.Image with real icons) exists as a config
  flag but is NOT tuned — glyphs win by default (icon-theme rabbit hole
  deliberately avoided in v1).

### Aesthetics (mirror notes exactly)

- Frost: `window.files` background `rgba(10,12,17,0.5)` from config
  `appearance.cardColour/cardAlpha` (the black card scrim); GLOBAL Hyprland blur frosts the
  translucent surface. Rounding 14 via the `files-float` window rule (the
  window fills the surface — no CSS radius). `decorate = true` +
  `border_size = 1` re-asserts the active border against the smart-gaps
  workspace rules (the notes-float rationale).
- Ink `#e6e6e6`, accent `#8ab5f7`, blue-tinted selection
  `rgba(138,181,247,0.35)`, hover `rgba(255,255,255,0.08)` — config-driven
  `appearance.*` (restart tier).
- **Row visuals:**
  rows are transparent by default, hover = `appearance.hoverColour` tint,
  selected = `appearance.selectionColour` tint + an accent left edge
  (`box-shadow: inset 3px 0 0 accent` — non-layout-shifting; the focus rule
  clears only the GTK outline, never this box-shadow). All token-driven — no
  hardcoded colours in the row rules.
- **Chrome is shared, not per-app:** the header bar (padding + the shared
  `--tinshell-hairline` bottom edge), its glyph buttons, the path
  breadcrumb + separator, the status line and the accent action all come from
  `common/css/card-chrome.ts` (`cardChromeCss`) under the shared `card-*`
  class names — files, portal and annotate emit the same block, so the
  family's toolbar language cannot drift. `mount.ts` assembles the whole
  stylesheet through `cardAppCss` (`common/card/app-css.ts`):
  `theme + style.css + cardThemeCss + cardChromeCss + files' own rules`, with
  the ink tokens (`ink` / `text` / `icon` / `muted` / `dim`) derived once by
  `cardPalette`.
- Dynamic CSS is a JS template literal in `mount.ts` (via `cardAppCss`'s
  `extra`): **NO BACKTICKS inside it**
  (notes GOTCHA 13 — a backtick in a CSS comment breaks the bundle SILENTLY
  at cold start).

## Config

`config.defaults.json` + `config.schema.json` + thin `config.ts` over the
shared loader via `createAppStore` (launcher pattern). Tiers: `appearance.*`/`window.*`/
`timing.*` restart, `startup.dir` baked, `view.*`/`trash.*` **live** (see the
live keys: `view.showHidden`, `sortDirsFirst`, `showSize`,
`showModified`, `trash.useTrash`, `trash.confirm` all take effect without a
restart — hidden filtering happens at render from the cached listing,
columns sync at render, trash behaviour is read at action time). The preview
pane is NOT configured here: its switch and geometry live in the shared
`common/media/preview` state store (see the pane section).

## Files

- `app.ts` — entry (createApp; quit-on-window-removed); the `fileSink` is set
  up in `mount.ts`.
- `window.tsx` — the browser window factory (card frame + header + path bar
  from `common/card/`, the shared listing `common/card/dir-list` with its status
  bar, the body row that pairs the listing's list area with the preview pane) +
  the window REGISTRY: `openPath` (surface/create),
  `newBrowserWindow` (always another), `closeActiveBrowser`, `getBrowser`
  (the active window), `destroyBrowser` (every window — the unmount/onQuit
  path), `refreshBrowsers`, all exported.
- `preview.tsx` — the preview controller: reads the shared preview preference
  (`common/media/preview`), owns the pane slot and its mode/width/visibility,
  the `(path, size, mtime)` item identity, and the open action routed back into
  the browser's row open.
- `fs.ts` — Gio backend (async listing with generation-counter discipline,
  GFileMonitor watching, mkdir/rename/trash/delete, open-with-default,
  free space, path resolution (tilde via the shared `common/path/complete`
  `expandTilde`) + the navigable-directory gate, glyph map, sort,
  format helpers, friendly errors).
- `navigate-path.probe.ts` — runnable probe for the path resolution the REQUEST
  route performs: the window handle's `navigate` resolves the request's raw
  tokens through `fs.absolutePath` before the listing titles, monitors, probes
  and enumerates, so the probe drives that resolver over the token shapes a
  request can carry and pins the directory gate and the same-path comparison.
  Headless (no window, no instance). Run:
  `ags bundle --gtk 4 apps/files/navigate-path.probe.ts /tmp/navigate-path-probe.sh`
  then `bash /tmp/navigate-path-probe.sh` (exit 1 on any violated invariant).
- `commands.ts` — request handlers (ping/open/navigate/up/back/forward/
  reload/toggle-hidden/mkdir/rename/trash/reveal/config).
- `config.ts` + `config.defaults.json` + `config.schema.json`.
- `style.css` — static theme (transparent surfaces).
- `run.sh` — 1-line shim to the shared bundler (forwards argv).
- `ensure-open.sh` — the app's `xdg-open` entry (the `Exec` of
  `tinshell-files.desktop`, `%f`), which is what makes `inode/directory` resolve here
  when anything calls `xdg-open` on a folder. It routes `files new [path]`
  through the shared router.
- `AGENTS.md` — this spec.

## GOTCHAS

1. **`files` is NOT a layer-shell app.** No `Astal.Window`, no layerrule in
   hyprland.lua — plain `Gtk.Window` (the notes pattern). The blur layerrules
   are for dock/launcher/promptd/notifications surfaces only.
2. **No systemd unit.** Do not add `tinshell-files.service` to setup.sh's unit
   loop — the app quits with its window by design. setup.sh needs `run.sh` +
   `ensure-open.sh` in its chmod list, the `files-float` Hyprland verification
   grep, the `inode/directory` → `tinshell-files.desktop` association check (the
   folder route: desktop entry → `ensure-open.sh` → the shared router), and
   the smoke-test echo line (a missing setup.sh entry silently breaks
   fresh-machine bootstraps).
3. **The window rule matches `class = "^(io\\.Astal\\.files)$"`** — the GTK4
   app_id (from applicationId). A bare `files` class matches nothing.
4. **The Gio async methods are CALLBACK-ONLY in this gjs** (1.88.1 — the
   @girs Promise overloads are lies):
   `enumerate_children_async` needs 5 args, `next_files_async` 4,
   `launch_default_for_uri_async` 4 (finish = `Gio.AppInfo.
   launch_default_for_uri_finish`, NOT `..._async_finish`). fs.ts
   promisifies all three. A 4-arg enumerate call throws "At least 5
   arguments required" at runtime.
5. **`GLib.dir_open` is not a function in gjs** (C macro) — Gio enumeration
   only (notes GOTCHA 10).
6. **`Gtk.Widget.toggle_css_class` does NOT exist** (GTK4 has add/remove/
   has only) — a bind-time crash on every row.
7. **gvfs is NOT installed, yet `Gio.File.trash` works** — GLib's built-in
   local trash handles it on real filesystems (ext4 →
   `~/.local/share/Trash/files/` + `.trashinfo`). It FAILS with "Trashing on
   system internal mounts is not supported" on tmpfs (/tmp) — that error
   surfaces in the status bar, never a crash. No freedesktop-spec fallback
   was needed.
8. **Stale-enumeration discipline:** a per-window generation counter +
   `Gio.Cancellable` — a stale `listDirAsync` result must never clobber a
   newer directory view. Monitors are re-created on navigate and cancelled
   on destroy.
9. **`reveal`'s selection lands AFTER the async enumeration** — a
   `reveal`-then-`rename` sequence in a script needs a settle delay
   (~0.5s), or rename sees "nothing selected".
10. **`GFileMonitor` is unreliable on some filesystems** (FUSE/network
    mounts) — documented; `reload`/`Ctrl+R` is the manual fallback. A
    periodic re-stat poll is NOT in v1.
11. **Kill stray gjs by exact PID; never `pkill` a pattern** that could hit
    another app's gjs (notes GOTCHA 6).
12. **No backticks inside the `mount.ts` CSS template literal** (the `extra`
    block `cardAppCss` appends) — silent cold-start bundle break
    (notes GOTCHA 13).
13. **GPU wake:** cold starts are fast ONLY because the session-wide
    `hl.env` pins (`VK_ICD_FILENAMES` etc.) keep the dGPU suspended — do NOT
    add env overrides to files' launch path; the session pins cover it.
14. **Test-window discipline (mandatory):** never open the files
    window on the user's ACTIVE workspace. Pin probes to a spare workspace
    (works: `hyprctl dispatch 'hl.dsp.focus({workspace = N})'` and
    `hyprctl dispatch 'hl.dsp.window.move({workspace = N})'` — hyprctl
    dispatch on 0.56 evaluates Lua; bare `hyprctl dispatch workspace 9` and
    `hyprctl focuswindow address:…` do not work), restore workspace + keyboard
    focus immediately, kill every test process by exact PID before the turn
    ends.
15. **The window's `destroy` signal is NOT a cleanup hook — every close path
    clears the handle first.** In gjs the JS handle keeps the Gtk.Window alive
    through `gtk_window_destroy` (dispose never runs) and the signal is not
    reliable. A handle left behind then points at a DESTROYED window: the next
    `open` calls `present()` on it and GTK re-shows it as a ZOMBIE — it keeps
    mapping, `win.destroy()` returns with it still mapped, and the next open
    mounts a SECOND window beside it. Only a shell restart clears one.
    Contract: `win.connect("close-request", () => { teardown(); win.destroy();
    return true })`; the frame's `close()` (what `closeActiveBrowser()` and
    `destroyBrowser()` call) is
    just that path — it never destroys the window behind the handler's back;
    `teardown()` is idempotent and removes THIS window from `browsers` +
    `scheduleUnload` once it was the last one + cancels
    the window's monitor and config subscription. Never defer to the default
    handler (`() => false` closes nothing this contract does not) and never
    rely on the `destroy` signal — it stays wired as a backstop only.
    A launched-on-demand app's stderr is lost — run `run.sh` in the
    foreground (or capture to a file) to see errors.
16. **The app quits when its LAST window closes** — after `ags -i files quit`,
    the bus name lingers ~1-2s (gjs teardown); a relaunch inside that
    window can race the name release. ensure-open.sh is immune (it only
    cold-starts when the bus is free).

17. **The preview pane must never report an intrinsic size.** The
    `files-float` rule pins the window at map, and `Gtk.Picture` measures its
    NATURAL size from the bound paintable's intrinsic size even with
    `can-shrink=true` (can-shrink clears only the minimum), so a raw texture
    bound onto the picture would resize the toplevel after map. Every
    paintable the pane binds goes through `NullIntrinsicPaintable`
    (`common/media/paintable`), the pane's minimum is `PREVIEW_MIN_WIDTH` —
    a drag is held at that floor, and only a drag below `PREVIEW_SNAP_SHUT_WIDTH`
    makes the shared divider fold the pane shut and turn the
    preview off (see the pane section) — and the pane's labels are capped
    (`max_width_chars` + `ellipsize`) so no long file name widens the slot.
    Verify after any pane change: the window must still measure exactly the
    `config.json` `window.width`x`window.height` the rule reads.

18. **Multi-window: one window per `files new`, and they OVERLAP.** Hyprland
    centres every float, i.e. the second (and every later) browser window maps
    at the same spot as the first — GTK4 has no position API, and files'
    window TITLE is the current path (the overview/matching contract above),
    so the media-style title-matched cascade (`media-2` … `media-6` `move`
    rules in hyprland.lua) cannot be reused here: it would need the title to
    change, which is a separate decision. Users move the extra windows
    themselves. Each window is otherwise independent (its own listing, monitor,
    selection, preview pane, closed through its own teardown).

19. **promptd (and media) are reached through the ROUTER, never `ags -i
    promptd`.** In production promptd is a LAZY member of the SHELL instance
    and no `promptd` bus name exists, so a direct instance call answers
    `instance "promptd" is not runnning` — Ctrl+N and the trash confirmation
    then silently no-op (the failed call leaves stdout empty, which the
    handler reads as a cancel). `window.tsx`'s `ROUTER` constant
    (`~/.local/bin/tinshell-route`, absolute — a non-interactive process has no
    `~/.local/bin` on PATH) probes the live instances shell-first and forwards
    the reply on stdout, in the shell and in dev islands alike. The same rule
    covers the image open in `openRow`.

## Optional integrations (DEFERRED — do not implement in v1)

- **Dock "Files" action** (dock/AGENTS.md — currently `xdg-open` of a
  storage dir): could become `ags -i files request open <dir>`. dock-owned
  change — coordinate with the dock session.
- **Launcher bang** (`!e <query>` → `ensure-open.sh <path>`): launcher-owned
  (`launcher/sources/bangs.ts`).
- **Notes Ctrl+S → files reveal**: nice-to-have (export → `request reveal`).
