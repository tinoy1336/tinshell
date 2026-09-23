# AGENTS.md — TINSHELL media app

Part of the TINSHELL multi-app home. **READ the repository root `AGENTS.md` FIRST** —
the multi-app rules (one app = one explicitly-named bus, launch path via
`tinshell-host.sh` (the universal bundle), `ags -i <app> request` addressing, onboarding, common
modules) apply to everything in this file. This file is the app-specific
spec; the root file is the cross-app contract.

## SPEC MAINTENANCE

This file is the spec for the media app. If you change media behaviour,
update this file in the SAME commit. If you change the request API, update
the Request API table in the same commit. Keep it honest — stale specs
corrode trust faster than missing ones.

## Identity

| | |
| --- | --- |
| dir | `apps/media/` (in this tree) |
| instance / bus | `media` / `io.Astal.media` |
| window class (GTK4 app_id) | `io.Astal.media` (set by the shared card frame; matched by the `media-float` window rule) |
| keybind | **NONE** — hyprland.lua binds no key to media. Every trigger goes through `apps/media/ensure-open.sh` + the shared router: the launcher `!p` bang, `tinshell-media.desktop` (xdg-open), and `tinshell-route.sh media …` |
| xdg-open / desktop entry | `tinshell-media.desktop` → `Exec=…/ensure-open.sh --new %f` — a file handed over by a file manager or another app opens a NEW window (`new`, never the retargeting `open`) |
| launcher bang | `!p <path-or-url>` — launcher-owned bang → `apps/media/ensure-open.sh` (`open <path-or-url>`, warm-vs-cold); launcher code in `launcher/sources/bangs.ts` |
| MPRIS bus name | `org.mpris.MediaPlayer2.player` — the media-player ROLE, deliberately not renamed: media keys, `playerctl` and the dock's media applet depend on it |
| systemd unit | **NONE** — on-demand floating desktop app, quits when the last window closes (notes/files exception) |
| log | fileSink → `/tmp/tinshell-media-debug.log` |

## Architecture (the non-obvious part)

**One window = one media surface, with two modes chosen by the file's kind**
(`common/media/classify`'s `isStillImage`):

- **viewer** — a still rendered inline: `common/media/decode`'s
  `loadStill(path)` decodes the file straight into a `Gdk.Texture` the
  `Gtk.Picture` binds. No GStreamer pipeline, no MPRIS, no transport. Animated
  GIF/WebP show their first frame.
- **transport** — audio/video played by this window's own GStreamer
  `playbin3` pipeline: `createMediaPipeline()` in `common/media/pipeline.ts`
  (the shared media layer) returns a self-contained instance (pipeline +
  playlist + event subscribers) built with this app's `timing.pollIntervalMs`.
  Video renders inside the window's `Gtk.Picture` via the video sink set to
  `gtk4paintablesink` (gst-plugin-gtk4, extra repo) — the sink exposes a
  `Gdk.Paintable` that the picture binds. Audio works without that plugin
  (default auto sink); video shows a placeholder until it is installed.

`window.tsx` keeps the surface registry: `media open` focuses the
most-recent window else creates one; `media new` always creates another
(**multi-instance**, the notes pattern) and is what the desktop entry asks
for. Opening a different kind of file in a window switches its mode in place
(`Gtk.Stack` pages).

### Window shape (no chrome)

**No header and no toolbar.** The window is the media: the frame
(`common/card/frame`) is built WITHOUT its header slot, and the whole card
belongs to the picture/stack. The only chrome is:

- the VIEWER's overlay footer — the still's filename at the bottom LEFT and
the zoom readout + the media's pixel size at the bottom RIGHT, both over the
picture (`.media-footer`):
  - the filename is a BUTTON: it glows white under the pointer and a click
    swaps it for a `Gtk.Entry` in the same slot carrying the full path. The
    entry runs the SHARED path type-ahead (`createPathAutofill` over
    `isPathShaped`, `common/path/autofill`) — Tab fills the next completion
    into a selected ghost half, Shift+Tab cycles back, Right Arrow locks it
    in — and Return commits (loading the typed file in this window), Escape
    leaves the edit. A path that does not exist is logged and ignored.
  - the zoom readout is a BUTTON too: a numeric zoom prints its own
    percentage (`123%`), the fit state prints the percentage it COMPUTED
    (`fit 21%`), so one number never carries two meanings. A click toggles
    fit <-> 100%, and it carries the same white hover glow so the affordance
    is visible. The transport's scrubber row carries the same readout button
    at its right end.
- the TRANSPORT's auto-hiding seek scrubber row (unchanged).

### Empty state (opened with no file)

A window created without a file paints NO media: no placeholder, no scrubber,
no footer — and it immediately asks the **portal** for a file
(`./picker.ts`: `org.freedesktop.portal.FileChooser.OpenFile` on the session
bus, which the session maps to the house portal app, `tinshell-portal`). The
prompt's `Response` is correlated by the request path derived from our own
`handle_token` + unique bus name, so the subscription is armed before the call
(no race); response 0 loads `results.uris[0]` into the window, 1 (cancel) and
errors leave it empty. The window is **see-through, not black**: it keeps the
shared card theme's translucent fill, which is also why no rule sets its
background to zero alpha (`style.css` — a GTK window whose whole frame is
fully transparent never commits a buffer, so the compositor is handed no
surface to map and NOTHING of the window appears; verified).

The empty state belongs to a request that named NO file. A request that NAMES
one is resolved first (`window.tsx` `resolveTarget`): a local path is expanded
through the shared `expandPath`, so `~` and a relative path reach the pipeline
absolute instead of as literal text, and a path that is not a regular file
there (nothing at it, a directory — `media ring <dir>` is the folder load — a
special file) is REFUSED: no window is built, the reason is logged, and the
request answers `error: <reason>` (`open`/`new` in `commands.ts`; the
cold-start argv path in `app.ts` logs it the same way). A URL the pipeline
plays (its `toUri` schemes) passes through untouched.

`append` is the same rule on the QUEUE path: the target is resolved before it
is queued, so an entry the pipeline could never load is refused with the reason
(`error: <reason>`, logged as `media: append refused — <reason>`) instead of
sitting in the playlist as a dead row. The resolution runs before the branch on
whether a transport window exists, so the refusal does not depend on what is
open. One request still names one file: `append` adds exactly what it was given.

### One requested file = one file

`load(path)` shows exactly the file it was given and builds NO sibling list.
The viewer's next/prev ring is an EXPLICIT action: `media ring <path|dir>`
(`ringFor()` in window.tsx — the folder's `isStillImage` siblings, name-sorted;
a directory names its own stills) loads the ring and the entry the path names.
`next`/`prev` step a ring that exists and answer the transport queue otherwise,
so a viewer opened with `open <one file>` is not a gallery.

### Never stretch media

No path may distort an aspect ratio:

- the viewer's picture binds the decoded still's own `Gdk.Texture` and
`Gtk.ContentFit.CONTAIN` honours its intrinsic ratio;
- the transport's picture binds a `NullIntrinsicPaintable` (no intrinsic size —
the toplevel must not resize itself after map) and `Gtk.Picture` scales a
RATIO-LESS paintable straight onto its allocation, so the ALLOCATION has to
carry the ratio: a `Gtk.AspectFrame` takes it from the source paintable's real
intrinsic size (its `source`), which is why a 4:3 video is pillarboxed inside a
670×380 window instead of being pulled to fill it;
- a numeric zoom pins the picture to an exactly-sized, CENTRED box of image
px × zoom in SCREEN px (÷ the surface's scale, because a size request is in
GTK's logical px) WITHOUT the expand flags, so the scrolled window draws the
image's own shape rather than stretching it onto the viewport's.
Leftover space stays empty and shows the usual frosted card surface.

A sink paintable EXISTS before it carries a frame, reporting 0×0: binding one
paints the whole picture BLACK, which is what a window with no decodable file
shows. `trackSource()` therefore accepts a paintable only when its source
reports a real size, on the initial read and on every later event alike.

### Zoom (pixel-true)

`zoom` is one value per window applied to whichever page is showing: `"fit"`,
or a scale factor in SCREEN px per IMAGE px where **`100%` is one image pixel
per one screen pixel and nothing else**. `./zoom` is the arithmetic (pure, no
GTK), `./picture-zoom` is the widget side, and `./zoom.probe` drives both over
a case matrix headlessly.

- The fit state is NOT a number: it prints the percentage it computed — a
  full-screen 2880×1800 screenshot in the default 670×380 window reads
  `fit 21%`, and that 21% is the true scale. The fit readout is recomputed
  whenever the viewport changes (`window.tsx` hooks the containing widget's
  `notify::width` / `notify::height`, plus the window's `notify::scale-factor`
  for a move to another output or a fractional-scale update). A numeric zoom is
  a fixed screen-px scale, so its number cannot go stale.
- `"fit"` lets the picture CONTAIN the viewport: expand on, no size request,
  CONTAIN against the picture's OWN texture — its intrinsic ratio is what
  letterboxes. Fitting an image smaller than the window magnifies it, so fit can
  read above 100% (`fit 300%` for a 400×300 photo full-screen) and below it.
- A numeric zoom pins the picture to `image px × zoom ÷ surface scale` in the
  widget's logical px and CENTRES it, with the paintable bound through
  `NullIntrinsicPaintable` (`common/media/paintable`). Both halves matter:
  `GtkScrolledWindow` hands its child the whole VIEWPORT box
  (`gtk_scrolled_window_allocate_child`), so a request smaller than the viewport
  is padded up to it and `FILL` would stretch the picture onto the viewport's
  shape — the non-FILL alignment clamps the allocation to the widget's own
  measured size, and the wrapper is what makes that size the request instead of
  the texture's own pixels. The transport's ratio frame gets the same exact box
  and the same centred alignment (`applyFrameZoom`).
- Steps (`+` / `-`, the wheel, the touchpad) continue from the scale ON SCREEN,
  so an "out" step always shrinks and an "in" step always grows: stepping out of
  fit starts from the scale fit computed, never from a fixed 100%. `ZOOM_MIN`
  (0.1) and `ZOOM_MAX` (8) bound the numeric scale; a step the range cannot
  honour — the fit scale itself already past the limit — leaves the fit state
  alone, because there is nowhere in that direction to go.

Inputs: the footer/scrubber readout button (fit <-> 100%), `+`/`-`/`0`/`1`
(window keys), the scroll wheel AND touchpad (`Gtk.EventControllerScroll`,
VERTICAL): deltas accumulate and advance the same step the keys use — a wheel
notch arrives as 1, a touchpad's smooth scrolling as small fractions, told
apart by `GtkEventControllerScroll.get_unit()`. GDK's positive delta is SOUTH,
so the notch away from the user zooms IN.

### Scrubbing (vertical rate ramp)

The scrubber row is the transport's seek control. Its horizontal position seeks
the stream; its VERTICAL position sets the PLAYBACK RATE: at the scrubber the
rate the window is playing at, steadily slower as the pointer rises to the top
of the window, with a hard floor of `SCRUB_MIN_RATE` (0.25); a pointer at or
BELOW the scrubber changes nothing (`scrubRateFor`). Rate changes are throttled
to real differences (`SCRUB_RATE_EPSILON`) because each one is a GStreamer
rate-seek, and the pre-scrub rate is restored on release. The scrub never
touches the play state: a paused scrub positions the playhead, and the ramp
applies to whatever play state follows.

The `Gtk.Scale` is a READ-OUT, not the input surface: `GtkRange` installs its
own CAPTURE-phase drag gesture, and a gesture added to the scale wins the press
only to be cancelled by the range's (drag-begin followed by an
immediate drag-end, no drag-update ever delivered). `can_target = false` takes
the range out of pointer picking and a transparent catcher over it owns the
sequence — which also gives the scrubber a 16px-tall grab target
(`.media-seek`) while the trough and slider keep their own thin metrics.

### Space

Space toggles play/pause in transport mode (window key backstop,
`common/card/keys`); it is not consumed while the viewer is showing.

### Flipping stills

Decoding dominates: `Gdk.Texture.new_from_filename` measures 55-160 ms for a
2880×1800 PNG on this machine, and a scaled decode
(`GdkPixbuf.new_from_file_at_scale`) is no faster — the PNG inflate is the
cost, not the scaling. The viewer therefore decodes each still ONCE: an LRU
cache (`STILL_CACHE_PX` / `STILL_CACHE_MAX`, dropped by `clearStillCache()` on
unload/quit) plus an idle PRELOAD of the next ring entry
(`PRELOAD_DELAY_MS` after a still is shown). A flip at the cadence a person
actually flips at (a second or so per image) hits the preload; a first view of
a still still pays the decode.

Why playbin3 and NOT GstPlay.Play: `GstPlay.Play` exposes its video sink
only through the `GstPlay.PlayVideoRenderer` interface, and GJS cannot
IMPLEMENT GObject interfaces (vfunc lookup fails), so a custom renderer is
impossible from GJS. playbin3 has a plain settable `video-sink` property
instead — fully usable from GJS. The playlist/queue is managed per-instance
in `common/media/pipeline.ts` (playbin3 plays one URI at a time; EOS
auto-advances the queue or stops at the end). The pipeline dies with its
window.

**MPRIS** (`mpris.ts`) registers `org.mpris.MediaPlayer2.player` on the
session bus (raw Gio.DBus — GJS has no MPRIS server wrapper) so media keys /
playerctl drive the app. MPRIS reflects the ACTIVE TRANSPORT instance
(most-recently-playing else last-focused transport window — window.tsx
selects it via `media.setActiveInstance`), and the bus name is owned ONLY
while at least one TRANSPORT surface is open (`mount.ts` wires
`startMpris`/`stopMpris` to the surface registry's playable-surface
transitions). A **still-only window must not claim MPRIS**: otherwise the
dock's media applet appears because a jpeg was selected. A transport window
with no media loaded yet (the bare control surface) DOES count as playable —
media keys work before any file is opened.

## Launch path & lifecycle

- **Every trigger routes `media …`** through `common/shell/tinshell-route.sh`
  (shell first, dev island second, cold start when neither is live):
  `apps/media/ensure-open.sh` is the entry — `open [path]` by default, and
  `--new [path]` for the desktop entry, so an xdg-open file never retargets a
  running window (the `new` shape; the same convention files/notes use).
  There is NO Hyprland keybind.
- **Cold-start argv forwarding** (notes GOTCHA 5): `run.sh` FORWARDS extra
  argv → shared run.sh → app.ts `main(...argv)` — `open <path>` focuses/loads,
  `new <path>` always creates. The cold path loads the requested media
  directly — the app must NOT also issue a bus request on cold start, or the
  media opens twice.
- **Quit-on-window-close (ISLAND only):** `app.connect("window-removed")` →
  no windows left → `app.quit()`. In SHELL the app is LAZY:
  not loaded until the first `media …` request; unloads after
  the 60s idle grace once the last window closes (root AGENTS.md documents
  the two invariants that keep this path safe — the uint32 graceMs clamp and
  the unloadPromises map; `media debug-unload` forces an unload cycle on
  demand). Each window's close handler shuts down ITS pipeline
  (`pipeline.shutdown()` on its `common/media/pipeline.ts` instance);
  `unmountMedia` = stopMpris + destroy all surfaces + drop the decoded-still
  cache (the lazy-unload AND instance-quit teardown); `mediaShutdown` is the
  same function, passed to `createApp` as the island's `onQuit` (the
  `<instance> quit` request path).
- **No bare `ags run`** — never. `run.sh` is the 1-line shim to the shared
  bundler (per-app hashed outfile; bundle cache at
  `~/.cache/tinshell-bundle/media/`).

## Request API

`ags -i shell request "media <cmd> [args]"` (island: `ags -i media request
"media …"`) — multi-word args join with spaces; `error: <msg>` never
crashes; `request ""` lists commands; `quit` is builtin. Transport commands
pass through to the active transport surface's pipeline
(`common/media/pipeline.ts`); the viewer commands act on the active surface
while it is in viewer mode.

| Command | Args | Reply |
| --- | --- | --- |
| `ping` | — | `pong` |
| `debug-unload` | — | `ok: unloaded` — forces a lazy unloadNow cycle on demand (testing the unload/reload path without waiting on the grace timer) |
| `config` | `get <dotted.path>` / `set <dotted.path> <value>` / `reload` / `all` | value / `ok` / `reloaded` / full object |
| `open` | `[path-or-url]` | `ok` — focus the most-recent window else create one; a path loads into it, switching mode by the file's kind, and it is the ONLY file loaded (no sibling ring). No path → focus only (never clobbers the current media) |
| `new` | `[path-or-url]` | `ok` — always create another window (optionally loading the path); the xdg-open shape |
| `open` / `new` / `append` refusal | any `[path-or-url]` | `error: no such file or directory: <path>` / `error: is a directory: <path> (…)` / `error: not a regular file: <path>` / `error: cannot read <path>: <msg>` — the argument is resolved (`~` expanded, made absolute) and only a REGULAR FILE is accepted, so a window is never built to show nothing and no queue entry the pipeline can never load is stored; nothing is created/queued and the reason is logged too |
| `ring` | `<path-or-dir>` | `ok` / `error: no still images at <arg>` — the EXPLICIT multi-file load: the folder ring (`isStillImage` siblings, name-sorted; a directory names its own stills) starting at the entry the path names |
| `close` | — | `ok` — close the active window / `error: no window` |
| `append` | `<path-or-url>` | `ok` / `error: <reason>` — queue + play (the target is resolved through the same helper as `open`/`new` — see the refusal row); with no transport window up it opens the first one instead |
| `toggle` / `play` / `pause` | — | `ok` — play/pause cycle / resume / pause |
| `seek` | `<+ | -sec \| sec \| pct%>` | `ok` — relative / absolute / absolute-percent |
| `volume` | `<0-100 \| +N \| -N>` | `ok` — absolute or relative (clamped 0-100) |
| `mute` | — | `ok` — toggle mute |
| `next` / `prev` | — | `ok` — the active VIEWER's next/previous RING still while that viewer holds a ring, else the transport queue |
| `zoom` | `fit \| in \| out \| 100` | `ok` — the ACTIVE surface's zoom, in either mode / `error: no media window` / `error: usage: zoom fit\|in\|out\|100` |
| `playlist` | — | JSON array of entries `{filename,title,current,playing}` |
| `play` | `<idx>` | `ok` — playlist jump (flat API: `play` with no arg = resume, with an index = jump — the registry walk can't have both, so the handler branches on its first token) |
| `remove` | `<idx>` | `ok` — remove from queue |
| `clear` | — | `ok` — clear queue + stop |
| `shuffle` | — | `ok` — shuffle queue |
| `speed` | `<x>` | `ok` — playback rate via rate-seek (e.g. 1.5) |
| `status` | — | JSON `{timePos,duration,title,pause,volume,mute,speed,playlist}` of the active transport instance / `error: no media window open (…)` |
| `preview` | `on` \| `off` \| `toggle` \| `mode pane\|full` \| `width <px>` \| `status` | JSON effective settings `{enabled,mode,width}` — the SHARED preview preference every host that mounts the media pane reads (files' browser, the portal chooser). Lives in its own state store (`common/media/preview` → `~/.local/state/tinshell/apps/media-preview/state.json`), OFF when nothing is stored; this handler is the only write path. `status` is side-effect free |

## Behaviour

### Window

One plain `Gtk.Window` per surface, built by
`createCardFrame({ app: "media", appId: "io.Astal.media", … })` (the shared
card frame — header slot + window key backstop), NOT layer-shell. Hyprland's
`media-float` rule floats + rounds it and PINS its map size from the app
config (`window.width/height`, defaults 670×380) — the floating-XDG
startup-race fix, the same shape as files-float/notes-float. The window is
resizable — user drag-resize works.

The natural-size hazard is handled at the content: Gtk.Picture measures its
NATURAL size from the paintable's intrinsic size even with can-shrink=true
(can-shrink only zeroes the minimum), so a bound video/album-art paintable
would resize the toplevel after map (670×380 → the art's own size).
window.tsx wraps every transport paintable in `NullIntrinsicPaintable`
(`common/media/paintable.ts` — a Gdk.Paintable impl: snapshot + invalidations
forwarded, intrinsic size reported as 0), so the picture never drives the
window's natural size and it stays at the config default until the user
resizes it. The viewer's picture is pinned by its own zoom size request inside
the scrolled window ("Zoom (pixel-true)" — the request alone is not enough:
the box also has to be clamped and centred against the viewport's own box).

**Multi-instance cascade:** Hyprland overrides app sizes
for floats (GTK windows map ~720x900 regardless of config) and centres them,
so consecutive media windows would stack invisibly. GTK4 has no position API,
so the nth window gets title `media-N` (window.tsx) and hyprland.lua offsets
instances 2-6 via title-matched `move` rules (40px down-right each,
`media-2` … `media-6`). The title is invisible (no titlebar) and NEVER
carries the filename — a viewer window must keep matching its cascade rule.

### Viewer mode

Body: a `Gtk.Picture` inside a `Gtk.ScrolledWindow` over the window's own card
background, with the overlay footer of the window shape above. The viewer
paints no backdrop of its own, and nothing marks transparent pixels: they show
the card surface, so a transparent PNG has no transparency indicator.
Keys: Left/Right step the RING, `+`/`-` zoom, `0` fit, `1` actual size
(installed by the frame; the zoom keys work in either mode, the step keys only
while the viewer is showing).

Zoom model (the contract is "Zoom (pixel-true)" above): `"fit"` lets the
picture CONTAIN; a numeric zoom pins the picture to an exactly-sized, centred
box of image px × zoom in screen px, with `FILL` (not CONTAIN) INSIDE that box,
otherwise the picture would scale back down inside its own allocation. The box
keeps the image's ratio, so a zoomed picture is never stretched and never
smaller or larger than the box the readout claims.

**Next/prev ring**: EXPLICIT — `media ring <path|dir>` lists the folder's
siblings the shared predicate accepts (`isStillImage`,
`common/media/classify` — name-sorted), remembers the index, and
`next`/`prev` wrap around it. Opening a single file builds no ring. Files are
decoded on demand and each decode is kept (see "Flipping stills") — no
thumbnails.

Why a decoded texture, not `Gtk.MediaFile`: `Gtk.MediaFile` is the modern
GTK image path and would animate GIF/WebP, but in gjs the `Gtk.MediaStream`
interface methods do not merge onto the instance (`get_paintable` is
undefined there) and `playing` never becomes true, so it yields a
permanently null paintable. Animated
GIF/WebP therefore show their first frame only.

### Transport mode

Video fills the aspect frame (`Gtk.AspectFrame` inside a `Gtk.ScrolledWindow`,
both in the overlay's main child slot) with a SINGLE auto-hiding seek scrubber
overlay at the bottom, faded in on pointer motion and out after
`timing.autoHideMs`. Album art fills the frame for audio-only media; a `▶`
placeholder covers the no-video case (audio, or the sink plugin missing). No
titlebar, no transport/volume/playlist buttons — playback is driven via CLI,
MPRIS (media keys), the space key and the launcher.

The picture is never hidden — only its bound paintable and the placeholder's
visibility change (`applyPicture`) — and the sink's paintable is bound only
when its source reports a non-zero intrinsic size, on the initial read
(`trackSource`) and through `emitSinkPaintable` (`w <= 0 || h <= 0` dropped)
alike.

State flow (single source of truth = the pipeline): widget state is updated
ONLY from the pipeline's events (`common/media/pipeline.ts`): `state`
(pipeline STATE_CHANGED), `position` (polled by the backend — playbin3 has
no position-updated signal — at `timing.pollIntervalMs`), `title`, `volume`,
`playlist`, `ended`, `paintable` (a post-preroll READ of the sink's
`paintable` property — `emitSinkPaintable`, driven by the bus's `ASYNC_DONE`
and `STATE_CHANGED`→PLAYING, because the sink's `notify::paintable` does not
fire in practice; a load that tears the old pipeline down emits a null one so
the previous file's frame cannot linger). Never set
widget state from an action you just sent — wait for the event round-trip.
No window-side poll timer.

GTK4 `Gtk.Scale.set_value()` does NOT emit `value-changed` (fires only on
user input) — a `syncing` flag around programmatic sets distinguishes user
seeks from event syncs, and a live scrub suppresses the poll's own slider
writes (`scrubbing`) so the drag owns the slider. A seek call resolves the
scale's percentage against the duration; `speed` is a rate-seek at the
current position (the scrub ramp's actuator).

## Opening a still from elsewhere

`files` routes activation of an image extension to `tinshell-route media open <path>`
(falling back to `xdg-open` when the router fails). Both sides gate on the SAME
predicate: `common/media/classify`'s `isStillImage` decides files' activation
and the media window's viewer mode, so an extension that routes here is one
the viewer accepts. The image set in `classify.ts` is the verified-decodable
one — every format it lists was decoded through `Gdk.Texture.new_from_filename`
on this machine — because the router exits 0 even for an `error:` reply
(`common/shell/tinshell-route.sh`), so a format the viewer rejects would open
nothing at all rather than fall back. The launcher's `!p` bang and the
`tinshell-media.desktop` entry (`ensure-open.sh --new %f`) reach the same app for
any media kind — the desktop entry always in a window of its own.

## Close contract

Every window closes through its `close-request` handler: unsubscribe the
pipeline events, `pipeline.shutdown()`, `removeSurface()` (which re-derives
the active transport surface + the MPRIS gate and arms the idle unload when
the last window goes). The registry array is therefore the single live-window
list — a closed window is never presented again (the zombie shape in
`files/AGENTS.md` GOTCHA 15). `media close` and the shell `unmount` both go
through the same path (`win.close()`), never a bare `destroy()`.

## Config

Three files in `apps/media/` (defaults + schema + live),
loaded by the shared schema-driven loader. Schema uses draft-07 + custom
`x-tier` (live | baked | restart) per namespace:

- `appearance.*` (restart) — cardColour, cardAlpha, rounding (Hyprland-owned:
  the `media-float` window rule hardcodes rounding=14 and CSS emits no
  radius, so the key is cosmetic for now), selectionColour (the shared card
  chrome's pressed/selection tint), textColour, accentColour, hoverColour,
  fontSize, iconSize.
- `window.*` (restart) — width, height (min 400×240; defaults 670×380) — the
  one window size BOTH modes use; hyprland.lua's `configWindowSize("media",
  …)` reads it for the `media-float` map size.
- `timing.*` (restart) — autoHideMs (0 = off; the transport scrubber's fade
  timeout), pollIntervalMs (>= 250; the position poll period).
- `startup.*` (baked) — dir (reserved; bare `open` focuses instead of
  loading a startup path).
- `view.*` (live) — showPlaylist / showThumbnail / showTimestamps are
  reserved keys with no rendering path in v1 (the transport window is the
  picture + scrubber). No viewer-backdrop key: the viewer has no backdrop of
  its own and the window's card surface shows through instead.

## Files

- `app.ts` — entry: `createApp`, quit-on-close, `mediaShutdown()` on `onQuit`.
- `run.sh` — the 1-line shim to `common/shell/run.sh media`.
- `ensure-open.sh` — the router wrapper every trigger goes through: `open
  [path]` by default (the launcher `!p` bang), `--new [path]` for the
  `tinshell-media.desktop` `Exec` (`--new %f`), so an xdg-open request opens a NEW
  window instead of retargeting the running one. That entry is the suite's
  media handler: it claims the still types `common/media/classify` accepts
  plus the audio and video set, so `xdg-open` lands here rather than in a
  browser or a separate player.
- `picker.ts` — the PORTAL file prompt (`org.freedesktop.portal.FileChooser
  .OpenFile`): the empty window's "open a file" request, answered by the
  `Response` on the request path derived from our `handle_token` (armed
  before the call, so no race). No GTK dialog of our own.
- `config.ts` / `config.defaults.json` / `config.schema.json` — config trio.
- `commands.ts` — request handlers (thin pass-throughs to the active surface;
  `open`/`new` answer the resolved-path refusal of `window.tsx`'s
  `resolveTarget`).
- `active.ts` — the active-instance registry (`setActiveInstance` /
  `getActiveInstance` / `onActiveChange`) MPRIS + the transport commands route
  through, selected by `window.tsx`. The playback itself lives in the shared
  media layer (`common/media/pipeline.ts` — playbin3 + gtk4paintablesink,
  event bridge, queue management).
- `window.tsx` — the surface registry and the one window type: mode stack
  (viewer / transport pages), the viewer's footer (filename edit + zoom
  readout), the transport's scrubber and its vertical rate ramp, the still
  decode cache + preload, `resolveTarget` (the request's path-or-URL
  resolution + refusal), the empty state + portal prompt, the title cascade,
  the MPRIS gate.
- `zoom.ts` — the zoom arithmetic: the scale a fit computed, the readout text,
  the step, and the image-px → screen-px conversion (`100%` = one image pixel
  per screen pixel). Pure, no GTK.
- `picture-zoom.ts` — the widget half of the same model: `deviceScale` (screen
  px per logical px), the box a numeric zoom pins, and the exact-box + centred
  application to the viewer's picture and the transport's ratio frame.
- `zoom.probe.ts` — the case matrix (fit / 100% / after a resize / steps, over a
  large and a small image in a small and a full-screen viewport) run headlessly
  against those two modules and real GTK widgets; exits non-zero on any readout
  that disagrees with the box that is drawn.
- `mpris.ts` — the MPRIS D-Bus server (`org.mpris.MediaPlayer2.player`).
- `style.css` — static structure; the shared card blocks + colours are
  emitted by `mount.ts` (`common/card/app-css`).

## GOTCHAS

1. **`media` is NOT a layer-shell app.** No `Astal.Window`, no layerrule in
   hyprland.lua — plain `Gtk.Window` (the notes pattern). The blur layerrules
   are for dock/launcher/promptd/notifications surfaces only.
2. **No systemd unit.** Do not add `tinshell-media.service` to setup.sh's unit
   loop — the app quits with its window by design. setup.sh only needs
   `run.sh` + `ensure-open.sh` in its chmod list and the smoke-test echo line.
3. **The window rule matches `class = "^(io\\.Astal\\.media)$"`** — the
   GTK4 app_id set by the shared card frame. A bare `media` class matches
   nothing.
4. **GstPlay.Play is unusable from GJS for in-window video.** Its video
   sink is only settable through the `PlayVideoRenderer` interface, which
   GJS cannot implement (vfunc lookup fails). Use playbin3 + its plain
   `video-sink` property.
5. **`gtk4paintablesink` is a runtime dependency for VIDEO only** (gst-
   plugin-gtk4, extra repo — `pacman -S gst-plugin-gtk4`). Until installed
   `Gst.ElementFactory.make("gtk4paintablesink")` returns null (guarded in
   `common/media/pipeline.ts`, logged once) and the output area shows the
   placeholder; audio plays fine via the default sink.
6. **playbin3 has no position-updated signal** — the backend polls position
   at `timing.pollIntervalMs` (default 1000ms). The seek bar updates ~1/s;
   drags still seek immediately on user input.
7. **`time-pos`/`duration` are null before any media loads** — every
   consumer (fmt, refreshSeek, seek percent/relative handlers) guards for
   null; never feed null into arithmetic.
8. **gjs 1.88 callback-only async** (files GOTCHA 4): use the CALLBACK form
   of `read_line_async` / `connect_async` + `*_finish` — the @girs Promise
   overloads are lies for some methods.
9. **A keybind-launched app's stderr is lost** — run `run.sh` in the
   foreground when debugging; the fileSink catches everything else.
10. **`Gtk.Window` has no `is_destroyed()` in GTK4** (GTK3-ism) — guard
    `destroyWindow` with try/catch around `close()`, not a destroyed check.
11. **Test-window discipline:** never leave ags test windows on the active
    workspace; verify-and-kill by exact PID; restore the workspace.
12. **gtk4paintablesink BREAKS under the GTK Vulkan renderer after a window
    close:** the sink's paintable comes up 0x0 on the
    first open after a media window close+reopen, `emitSinkPaintable`
    rejects it (w<=0), video never binds, and decoded frames pile up
    without bound. Root cause = the Vulkan renderer (GTK 4.16+ default,
    pinned by `VK_ICD_FILENAMES=radeon_icd.json` in the session env) vs the
    sink's GdkGLContext interplay. FIX: the session env sets
    `GSK_RENDERER=gl` (common/shell/tinshell-host.sh) — under GL the sink binds
    and stays healthy across window cycles (reopen binds + flat RSS). Do
    NOT remove that env line; if the media app ever gets its own unit, it
    needs GSK_RENDERER=gl too. Audio is unaffected (default sink).
13. **A new surface's initial load is gated on the window's `map`, and that
    handler must be connected BEFORE `present()`:** a toplevel is realized and
    mapped by the show `present()` performs (`GtkWidget::show` — a shown
    toplevel is "immediately realized and mapped"), so `::map` is emitted
    before `present()` returns and a handler connected after it is never
    called. A connect placed after `present()` therefore leaves the surface
    built without its media: the cold path (`media open <path>` with no window
    open yet — the lazy load in the shell, the routed `open` in an island)
    plays nothing, while a path handed to an ALREADY open window goes through
    `load()` directly and plays. The gate defers the load to the window's map
    leg, so the pipeline's preroll starts only against a window that has been
    realized and mapped; it is a load-ONCE gate (`initialLoaded` — the initial
    request loads on the first map and never again, and it is also where the
    file-less window raises its portal prompt), and it covers stills and
    transport alike: `load()` picks the mode from the file's kind.
14. **A fully transparent GTK window is never mapped by the compositor.**
    With a zero-alpha background nothing is drawn, so no buffer is committed
    and `hyprctl clients` never lists the window — it is absent from the
    screen while GTK reports `mapped=true` and every widget has a real
    allocation. The empty window therefore keeps the card theme's translucent
    fill (`style.css` says so at the rule that is deliberately NOT there).
15. **A `GtkRange` owns its presses in the CAPTURE phase** — a gesture added
    to a `Gtk.Scale` sees `drag-begin` and is then cancelled by the range's own
    drag gesture (`drag-end` immediately, no `drag-update` ever). Put the input
    gesture on a transparent catcher over a `can_target = false` scale (the
    scrubber row does).
16. **A zero-sized sink paintable paints BLACK.** `gtk4paintablesink`'s
    paintable exists before its first frame and reports 0×0; Gtk.Picture
    scales a ratio-less paintable onto its whole allocation, so binding one
    fills the picture with black — the empty window's old look. Both bind
    paths gate on the source's real intrinsic size (`trackSource`).
17. **Portal prompts are async and correlated by path.** The
    `org.freedesktop.portal.Request` handle is derived from the caller's
    unique bus name and the `handle_token`, i.e. knowable BEFORE the call —
    subscribe to `Response` first, then call `OpenFile`, or a fast answer is
    lost. The prompt needs no parent window (an empty `parent_window` string
    is the spec's own value), which is what makes it usable from a GTK4 app
    (the xdg-foreign export handle is not exposed).

## Deferred (do not implement in v1)

- `view.showThumbnail` / `view.showPlaylist` / `view.showTimestamps`
  rendering (reserved keys; no rendering path).
- Animated GIF/WebP playback (first frame only via the texture decoder).
