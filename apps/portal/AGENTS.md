# AGENTS.md — `portal`: TINSHELL xdg-desktop-portal FileChooser backend

An on-demand TINSHELL app that implements the xdg-desktop-portal **FileChooser
backend**. Every portal-aware app (Firefox, Chromium, VSCode/Electron,
GTK/Qt apps going through `GtkFileChooserNative`/`QFileDialog` → portal)
gets its Open/Save dialogs from an TINSHELL-styled GTK4 window instead of
`xdg-desktop-portal-gtk`/`-kde`.

**A REAL standalone app** (own dir, own bus `io.Astal.portal`, own D-Bus
activation) hosted in the shell preset; also runnable as the dev island
`portal`, per the root AGENTS.md multi-app rules.

## Identity & buses

| Thing            | Value                                                                                    |
|------------------|------------------------------------------------------------------------------------------|
| Directory        | `portal/`                                                                                |
| Astal instance   | in shell: inside the shell instance (`io.Astal.shell`); dev island: `portal` → bus `io.Astal.portal` (`ags -i portal request\|quit`)                          |
| Portal backend id| `tinshell-portal` (`.portal` filename in `~/.local/share/xdg-desktop-portal/portals/`)         |
| D-Bus impl name  | `org.freedesktop.impl.portal.desktop.tinshell-portal` (session bus, owned by `dbus.ts`)        |
| Interface        | `org.freedesktop.impl.portal.FileChooser` at `/org/freedesktop/portal/desktop`            |
| Request object   | `org.freedesktop.impl.portal.Request` exported at the exact `handle` object path (per call)|
| Chooser UI       | custom `Gtk.Window` (window.tsx) built on the shared card substrate: card header (back/forward/up + the shared path bar) · body (a places rail beside an ordinary card LISTING the preview pane displaces) · status bar · actionbar (file-type dropdown · save name entry · preview toggle · Cancel/Accept). NOT `Gtk.FileChooserWidget`: that widget's 609px minimum width left no room for the pane (see the pane section) |

The two buses are deliberately separate: `io.Astal.portal` is the TINSHELL
control surface (request/quit), `org.freedesktop.impl.portal.desktop.tinshell-portal`
is the portal backend the frontend (xdg-desktop-portal) talks to.

## Lifecycle — RESIDENT, not on-demand

- **RESIDENT** (boot-deadlock fix): in production the portal is an EAGER
  member of the SHELL instance, so the impl name is owned from session start —
  before xdg-desktop-portal probes the backend at ITS startup. The
  `tinshell-portal.service` unit template exists for dev islands and is deliberately
  NOT enabled by setup.sh. The
  frontend's `StartServiceByName` probe deadlocks in dbus-broker when it
  races the D-Bus activation of a stopped unit — the broker never replies
  even after the app owns the name (25s GDBus timeout, every gjs app's Gtk
  init blocks meanwhile; bus1/dbus-broker#258/#304/#314 bug class).
- There is deliberately NO session-bus activation file for the impl name.
  "The name is momentarily unowned" is exactly the state at login while the
  shell is still starting, so an activation file would let D-Bus spawn a
  SECOND claimant racing the shell. dbus-broker then abandons the frontend's
  `StartServiceByName` reply and the whole session stalls for the full 25s
  D-Bus timeout (every Gtk app's `org.freedesktop.portal.Settings` call queues
  behind it). With no activation file the name has exactly one possible owner,
  so the race cannot occur and a stopped host answers a fast `ServiceUnknown`
  instead of hanging.
- The app does NOT self-quit after the last dialog (`dbus.ts` has no
  `scheduleQuit`) — the impl name must stay owned for the whole session. It
  stays resident in the shell (~86MB RSS).
- The name is claimed BEFORE Gtk init (`dbus.ts` `ownName()` — called from
  `mount.ts` module top-level, pre-`createApp`), so Gtk init stays fast even
  when the frontend restarts mid-session.
- Systemd unit + `.portal` + dbus `.service` are installed by `setup.sh`
  (user-local install block, no root; the unit is installed for dev and left
  DISABLED).

## Protocol (do not "fix" these)

- `OpenFile`/`SaveFile`/`SaveFiles`: in `osssa{sv}` (handle o, app_id s,
  parent_window s, title s, options a{sv}), out `ua{sv}` (response u,
  results a{sv}). Introspect a running backend: `busctl --user introspect
  org.freedesktop.impl.portal.desktop.gtk /org/freedesktop/portal/desktop`.
- **The method reply carries the result INLINE** — no backend Response
  signal. The reply is DEFERRED until the user finishes the dialog and must
  be sent EXACTLY ONCE per request (leaked invocation or double reply hangs
  or crashes the calling app). `dbus.ts` holds the `Gio.DBusMethodInvocation`
  and replies in the chooser window's response callback (`onResponse`, exactly once).
- Request object: `org.freedesktop.impl.portal.Request`, single method
  `Close()` (no args, no return — see
  `/usr/share/dbus-1/interfaces/org.freedesktop.impl.portal.Request.xml`).
  `Close()` = the app aborted → close the chooser window (response path replies
  code 1) and unregister the object.
- Response codes: `0` success, `1` cancelled, `2` ended some other way.
- `results a{sv}`: `uris as` (file:// URIs) is the only strictly required
  key in v1; nested variants are explicit `GLib.Variant` objects.
- `parent_window` is `""` for Wayland-native apps → the dialog is a plain
  toplevel; `modal` is best-effort on Wayland.

## Request surface

| Command | Args | Reply |
|---------|------|-------|
| `portal ping` | — | `pong (impl name org.freedesktop.impl.portal.desktop.tinshell-portal)` |

The backend speaks D-Bus, so `ping` is the whole request tree: the router
(`tinshell-route.sh`) probes a live instance with the empty request + app-name grep,
and the `portal=shell,portal` route-map row needs a servable node to match.

## Modules

| File                  | Role                                                                  |
|-----------------------|-----------------------------------------------------------------------|
| `app.ts`              | `createApp` entry; owns `io.Astal.portal`; calls `ownName()` pre-Gtk (boot-deadlock fix) |
| `dbus.ts`             | claims the impl bus name BEFORE Gtk init (`ownName()` + main-context pump), registers FileChooser + per-request Request objects, deferred reply (no self-quit) |
| `window.tsx`          | the custom chooser window — built on the shared card frame (`common/card/frame`: toplevel, `io.Astal.portal` app id, 520x360 minimum, key backstop) with a card header (`common/card/header` + the shared `path bar` in its title slot), a body row of [places rail | `Gtk.Paned`(listing, preview pane)], the shared status bar and the actionbar (file-type `Gtk.DropDown` · save name entry · preview toggle · Cancel/Accept pill). The LISTING is the shared card listing (`common/card/dir-list` — the ColumnView, its name/size/modified columns and sorters, the status line, the hidden-files toggle, the navigation history) fed from the files browser's own backend (`@apps/files/fs`: `listDirAsync`/`monitorDir`/`compareEntries`/`glyphFor`/`formatBytes`/`formatDate`/`absolutePath`/`checkDir`/`freeSpace` + its `DirEntry`), so the window supplies only what is the chooser's own: the row class, the column text, the order policy (folders first), FILTER matching (glob + mime from the caller's `filters`/`current_filter`), the places rail, the save name entry, overwrite and save-many collision guards, multi-selection (through the listing's per-cell hooks) and directory selection, and the keyboard flow (Escape cancels, Enter accepts). Responds exactly once on every path, with a destroy-path backstop replying code 2 |
| `chooser.ts`          | maps options a{sv} → window options (`parseOptions`); builds the window  |
| `config.ts` + `.json`s| thin re-export over `createAppStore` (`common/config/app-store`; window.defaultWidth/defaultHeight, appearance.cardColour/cardAlpha/textColour/accentColour/selectionColour/hoverColour/fontSize) |
| `style.css`           | static chooser theme — the header/actionbar/listing structure (control density, the places rail's hairline, the listing's transparent surfaces, the pane's split hairline) at `window.portal` scope. Every colour comes from `common/css/card-chrome.ts` / `card-theme.ts` / `mount.ts`'s dynamic block, assembled by `cardAppCss` (`common/card/app-css`) |
| `run.sh`              | env exporter (Wayland session + GPU pins) + shared-bundler shim; the manual per-app entry — no session-bus activation file names this app |
| `tinshell-portal.portal`   | backend id `tinshell-portal` (`[portal] DBusName=... Interfaces=...`)       |
| `../systemd/tinshell-portal.service` | systemd user unit template (installed with `__HOME__` substituted) |

## Preview pane (per-window switch, shared width)

The chooser's body pairs an ordinary card LISTING with the shared media pane
(`createMediaPane` — `common/media/pane`): a still renders inline beside the
listing, everything the pane does not render draws a kind glyph plus an open
action. Each dialog owns its switch (`createPreviewSession` —
`common/media/preview`): the actionbar's eye / eye-off button flips THIS dialog,
and the stored value in that module's own state store
(`~/.local/state/tinshell/apps/media-preview/state.json`, never this app's config,
OFF when nothing is stored) is only the last applied setting a NEW dialog starts
from. In the shell the two hosts share one process and in dev the module's
`Gio.FileMonitor` carries the stored values between the resident portal unit and
the files island. There is no portal-side write path: the stored values are
written through the media app's request surface
(`media preview on|off|toggle|mode pane|full|width <px>|status`).

- **The pane DISPLACES the listing.** The listing is the paned's start child and
  the pane its end child, exactly as in the files browser, so switching the
  preview on narrows the listing in place (columns ellipsize) and nothing moves:
  the window keeps its size, the places rail and header stay put. Nothing here
  grows the window.
- **The pane always takes the SIDE slot**, whatever `mode` the preference holds:
  a `full` pane is the body in a browser, but a dialog whose listing is hidden
  cannot pick anything, so only the pane's width follows the shared preference.
  A `Gtk.Paned` divider beside the listing is the user's grab handle; dragging
  it persists the measured width into the shared preference, so the chooser and
  the files browser keep one width between them.
- **The pane keeps a minimum size or is closed.** The shared divider
  (`common/media/divider`) holds a drag at `PREVIEW_MIN_WIDTH` (200px): the
  position stops at the pane's own edge, so the pane keeps the floor's slot and
  no sliver is left on screen. Only a drag driven below `PREVIEW_SNAP_SHUT_WIDTH`
  (100px, half the floor) folds the pane shut — the divider moves to the far end,
  this window's switch turns OFF, and the actionbar glyph flips to eye-off. The stored width is
  written only from a pane that sits beside a visible listing — the chooser always
  shows the side slot — AND only when the window could host that width, so a fold
  forced by a small window neither overwrites the width the user chose nor becomes
  the setting the next dialog starts from, and a fold writes no width at all.
  Switching the preview back on re-seeds the pane at the stored width.
  The judgement rides on the paned's `notify::position` — a drag-driven width
  change — once the pane has been laid out: the seed's own position and the
  paned's clamp of it arrive before the pane has been allocated, and are not a
  drag past the floor. A RESIZE is judged by that same rule: a paned that clamps
  a position notifies the clamp, so a window narrowed below the divider is judged
  like a drag — the pane is left at its floor or closed, never narrower than its
  floor — while a resize that clamps no position changes none and is not judged
  at all (the pane takes the freed space and the stored width stands).
- **The listing keeps its minimum against the divider too.** The shared divider
  turns `shrink-start-child` off, so neither the seed nor a drag can push the
  divider into the listing's allocation (that squeeze is the left shift above).
- **The divider leaves the picker's scrollbar alone.** `GtkPaned` claims a
  press anywhere in its handle area — the separator rect grown by 6px on every
  side (gtkpaned.c `HANDLE_EXTRA_SIZE`, capture phase) — and the file list's
  overlay scrollbar sits exactly at that edge, so the claim would swallow the
  scrollbar's presses. The shared divider keeps that strip clear as a permanent
  margin on the picker, also while the preview is off.
- **The pane follows the listing's CURRENT selection.** The listing notifies
  every cursor move (`onSelectionChanged`, `common/card/dir-list`) and the pane
  re-follows there, carrying a `(path, size, mtime)` identity so an in-place
  overwrite re-decodes and an unchanged selection does not. For a SAVE request
  the current file is the one about to be overwritten — the overwrite preview.
- **The pane's open action ACCEPTS the item it holds** (the same item the
  chooser's selection names, re-read at click time so a moved selection cannot
  accept the wrong file): the action commits the dialog instead of opening a
  second viewer.
- **Preview state is surface-only and window-scoped:** no MPRIS claim, no
  playback, no pipeline for a still; every paintable goes through
  `NullIntrinsicPaintable`; the `respond()` path, the `destroy` backstop and the
  handle's `destroy()` all converge on one idempotent `cleanup()` that disposes
  this dialog's preview session and the pane (decoded
  still released) before the window goes.

## Notes / gotchas

- **Boot-deadlock**: the frontend's startup `StartServiceByName`
  probe deadlocks in dbus-broker when it races the D-Bus activation of a
  stopped unit — no reply for the full 25s GDBus timeout even though the
  app owns the name within ms (SystemdService AND Exec-only activation
  both hang; resident app → probe instant). Don't revert the
  residency/ownName design without re-testing a frontend restart.
- gjs has no Promise overloads for Gio async — callback-only. Not used here
  (dialog responses are GTK signals), but keep for future file ops.
- `GLib.timeout_add` / `idle_add` take (priority, interval, fn) in girs — use
  the 3-arg form.
- girs drops the varargs `Gtk.Dialog.add_buttons` binding — use `add_button`
  per button.
- `conn.register_object` takes 5 args (method closure + nullable property
  closures).
- Explicit nested `GLib.Variant`s for a{sv} values; inside a tuple, the
  a{sv} element is a plain JS object map (gjs converts).
- **Inbound options arrive variant-wrapped, and `deep_unpack()` does not
  unwrap them.** Unpacking the method's `(osssa{sv})` tuple yields the a{sv}
  as a JS object whose VALUES are still `GLib.Variant` — a `typeof` check
  against one is `"object"`, so every option silently reads as absent.
  `chooser.ts`'s `parseOptions` unwraps each value with `.deep_unpack()`
  (not `.unpack()`, which turns an `ay` into a keyed object instead of a
  `Uint8Array`) before reading it. Without that step the dialog loses the
  suggested filename, the starting folder, the active filter and the
  `directory`/`multiple`/`modal` flags — with no error anywhere. Verify a
  change here by calling the impl directly and checking that a SaveFile with
  `current_name` pre-fills the Name field, and that `directory=true` gives a
  folder picker rather than a file list.
- **The file-type selector needs its own skin, in two pieces.** It is a
  `GtkDropDown` whose toggle button keeps Adwaita's filled background (a bright
  pill against the card), and its popover is a separate surface that inherits
  nothing from the chooser — so both are styled explicitly in `mount.ts`'s
  `extra`: `dropdown > button` is flattened onto the house tokens, and
  `popover > contents` gets the card colour at FULL alpha. Translucent is wrong
  there: the popover opens over the actionbar and the buttons underneath show
  through the list.

- **`Gtk.MultiSelection` does not select on a click in this GTK** (a
  `SingleSelection` notifies on a row click; `can_unselect` changes nothing),
  so the chooser keeps a
  `Gtk.SingleSelection` for the CURSOR and owns the multi-selection itself: a set
  of picked paths, Ctrl/Shift + click handled by a CAPTURE-phase
  `Gtk.GestureClick` on each cell (the modifier state comes from
  `Gdk.Keyboard.get_modifier_state()` — a gesture's current-event accessor is not
  bound), and a `chooser-picked` class for the visuals because `row:selected` is
  painted from the model, which only ever holds the cursor. All three ride the
  shared listing's per-cell hooks (`common/card/dir-list`'s `cells.setup` /
  `cells.bind` / `cells.unbind`), so the pick machinery stays this app's while
  the cell structure stays shared.
- **Ctrl+A rides a capture-phase key controller on the listing.** GTK's list view
  claims the chord at its own node, so the window key table never sees it; the
  same reason the path bar's entry handles Return at the capture phase.
- **A widget has exactly ONE parent — the preview toggle lives in the actionbar.**
  Putting the same toggle in the header's trailing slot as well makes the second
  `append` fail with `gtk_box_append: assertion 'gtk_widget_get_parent (child) ==
  NULL' failed`; the widget stays where it was first added and the button silently
  never appears in the second slot.

## Integration (owned by setup.sh / root files — do not edit here)

- Root `package.json` workspaces includes `portal`.
- `setup.sh`: chmods `portal/run.sh`, installs the `.portal` file
  - systemd unit (user-local, no root), merges
  `org.freedesktop.impl.portal.FileChooser=tinshell-portal` into
  `~/.config/xdg-desktop-portal/portals.conf`, verifies the `portal-float`
  window rule in hyprland.lua OR in the generated `~/.config/hypr/rules/`, and
  installs the dev unit (left DISABLED).
- `apps/portal/hypr-rules.ts` → `~/.config/hypr/rules/110-portal.lua`: `portal-float`
  window rule (class `io.Astal.portal`, float, rounding 14) — regular window,
  NO layer rule, NO keybind; the class comes from `PORTAL_APP_ID`
  (`apps/portal/identity.ts`).

## Testing

- Restart the frontend once after install: `systemctl --user restart xdg-desktop-portal`.
- Trigger: `zenity --file-selection --title="portal test"` (zenity →
  GtkFileChooserNative → portal); save mode: `zenity --file-selection --save`.
  With the preview on, the selected file's still renders beside the listing and
  the LISTING narrows in place (the pane displaces it; nothing moves, nothing
  grows). `media preview on` stores the last-applied switch — it decides what
  the NEXT dialog opens with; an open dialog's own actionbar glyph is its switch.
- Mode coverage worth re-running after any chooser change, each through the
  frontend (a real caller): open with a filter
  (`--file-filter='PNG images | *.png'` — only matching files plus folders list,
  and the dropdown shows the filter), save (`--save --filename=<path>` — the name
  is pre-filled; accepting an existing file asks before replacing), select-folder
  (`--directory` — folders only, and the CURRENT folder is the answer), multiple
  (`--multiple` — Ctrl+A or Ctrl/Shift+click, several URIs returned), Escape
  cancels without an answer. `SaveFiles` (browsers) answers the `files aay` names
  from the request: each is joined to the folder the dialog shows and every
  existing one is checked before the reply. That path is verified to the backend
  boundary (the reply carries the URIs); the caller-side `Response` signal is
  UNICAST, so dbus-monitor cannot watch it — assert it with a subscribing client
  (or a browser) instead.
- Confirm our backend handled it: `journalctl --user -u tinshell-portal -f` shows
  the start + reply; the dialog window class is `io.Astal.portal`
  (`hyprctl clients`).
- Debug log: `/tmp/tinshell-portal-debug.log`.
