# AGENTS.md — notifications

The notifications surface: daemon ownership + popups + control centre.
A REAL standalone app (bus `io.Astal.notifications`); this
directory IS the app.

**READ the repository root `AGENTS.md` FIRST** (multi-app rules: bus
naming, router, launch path, shell aggregation, common modules, onboarding).

## Identity

| | |
| --- | --- |
| Instance / bus | in shell: inside `shell` (`io.Astal.shell`); dev island: `notifications` (`io.Astal.notifications`) |
| Unit | none (dev island; production = `tinshell-shell.service`) |
| ONE-OWNER | `org.freedesktop.Notifications` (AstalNotifd daemon) — never run shell AND this island at once |
| Window namespaces | `notifications-popup` (full-screen overlay, input region = card rects), `notifications-centre` (500×600, top-centre) — owned by `identity.ts` |
| Compositor rule | blur `notifications-.*` (ignore_alpha 0.2); DATA in `hypr-rules.ts`, rendered into `~/.config/hypr/rules/030-notifications.lua` by `npm run gen:hypr-rules` |
| Router | `route-map.conf`: `notifications=shell,notifications` |
| Keybind | mod+TAB → `tinshell-route notifications toggle-centre` |

## Sources (what lives here)

- `Notifd.ts` — daemon wiring + reactive state:
  - **LAZY daemon** (`getNotifd()` — `AstalNotifd.Notifd.get_default()` on
    first use): importing the module never claims the name (the dock island
    imports `notifyWithAction` for the screengrab menu). `initNotifd()`
    claims it eagerly at mount.
  - `ignore_timeout = true`: WE drive expiry from config
    `popup.timeout/timeoutLow/timeoutCritical` (urgency-tiered; critical 0 =
    sticky) — the urgency tier decides the clock, not the clients' timeouts.
  - owns DND end to end: the reactive mirror, the daemon's shared
    `dont-disturb` value, and the durable copy in the app's state store
    (`~/.local/state/tinshell/apps/notifications/state.json`). DND is the
    running mode of the popup gate, not configuration.
  - reactive state consumed by Popups/Centre: notifications (unresolved,
    newest first), popup ids, inhibitors, centre visibility.
  - per-notification expiry timers ONLY while a popup is shown (a DND'd or
    inhibited notification stays in the centre).
  - TWO reactive lists, and the difference is the whole surface contract:
    `notifications` (unresolved, newest first — what the popups render) and
    `history` (`HistoryEntry[]` = every notification seen this session, each
    flagged `live` while the daemon still holds it — what the centre lists).
    Resolution marks an entry `live: false`; it never removes it.
  - the two kinds of removal: `dismiss(id)` takes a notification off the screen
    and leaves its history entry standing, `forget(id)` dismisses it AND drops
    the entry, `closeAll()` (Clear All / Shift+C) dismisses every live one and
    wipes the history.
  - the inhibitor set: `addInhibitor` / `removeInhibitor` / `clearInhibitors`
    hold app ids that suppress popups while listed. Two surfaces reach it — the
    request API (`notifications inhibitor add/remove/clear/get`) and the
    centre's inhibitor widget, which lists the set and clears it.
  - in-process action handlers (`registerActionHandler`) intercept
    `invokeAction` — AstalNotifd gir 0.1 has NO `notify()` on the daemon and
    `n.invoke()` round-trips to the dead sender for in-process notifications.
    `notifyWithAction` registers one handler per action of the list it is given
    (`NotificationAction`), so a single notification can carry several buttons;
    the card renders one button per action, in the order declared.
- `Popups.tsx` — the floating surface: ONE full-screen overlay, cards stacked
  top-centre newest-first, each card in a `Gtk.Revealer` slot, input region =
  the card column's rect.
- `Centre.tsx` — the control centre: 500×600
  layer surface, layer TOP, anchored top-centre, keymode EXCLUSIVE while open.
  Its list IS the history: a resolved entry keeps full contrast and loses only
  its sender actions, and only `forget` (the card's ✕, Delete) or Clear All
  removes it — no rule dims a listed entry. Its controls are the project's own
  glyphs (`hoverGlyph`, common/glyph/hover-glyph — muted ink at rest, ink under
  an accent halo on hover): the DND bell toggle, the clear-inhibitors and
  clear-all glyphs, and the per-group clear, with the words in their tooltips,
  not on the surface. The DND glyph carries its state — the plain bell in muted
  ink while off, the slashed bell in the accent while on — and repaints from a
  `createEffect` on the state. A group of ONE entry renders its card directly:
  the header stands for several entries, and a collapsed header with its card
  inside the revealer lists nothing. A multi-entry group's header is ONE row (a
  `Gtk.Box`, not a `Gtk.Button`: a Button claims every press inside its box, so
  the trailing clear glyph would never see its own click) carrying the app icon,
  the name, the count, the chevron and the group's clear glyph; the row's own
  `Gtk.GestureClick` toggles the group and bails over the glyph's box. The
  list is a plain `Gtk.ScrolledWindow` — GTK's own scroll path, no app-side
  controller and no app-side momentum — whose scroller is capped by
  `applyViewport()` (see Gotchas). Its HEIGHT follows the content between
  `centre.minHeight` and `centre.maxHeight`: `applySize()` reads the root box's
  own natural height (the scroller propagates the list's natural height, so this
  is the chrome plus the content) and holds it in that range — a two-entry list
  makes a short panel, a long history sits at the maximum and scrolls. Width
  stays fixed at `centre.width`. Keyboard navigation steps the entries the list
  RENDERS (`visibleEntries()`: a single-entry group's card, or a multi-entry
  group's entries while that group is the expanded one), never `history()` — Tab
  and the arrows must not land on a row inside a collapsed group. The surface has
  exactly TWO ways off
  the screen — the key backstop (Escape / Caps_Lock) and the toggle the keybind
  and the request surface drive — and both log their reason
  (`centre shown (…)` / `centre hidden (…)`); no click, dismissal or history
  change moves this window.
- `NotificationCard.tsx` — imperative card factory (no gnim state inside;
  Popups manages children). Its ✕ reads by VARIANT: a popup's dismisses, a
  centre card's removes its history entry. A LEFT/RIGHT SWIPE on the card body
  dismisses (the drag fades the card; a release past a third of its width is
  the swipe), and a card built with `live: false` renders no sender actions.
  The centre variant's 48px square slot renders SENDER ARTWORK ONLY
  (`noti.image` — the file the daemon cached from the sender's own image): a
  notification with no sender image gets NO slot, because a slot resolved from
  `app_icon`, `desktop_entry` or the icon-theme fallback drew the app icon a
  second time on top of the 18px header indicator that already carries it. NO
  PIECE OF ARTWORK IS PAINTED TWICE ON ONE CARD. `noti.image` has exactly ONE
  surface per variant: the centre's 48px slot (`senderImagePicture`) or the
  popup's body-row thumbnail (`bodyImagePicture`, popup cards only — they have no
  slot, and the centre card must not draw the same file beside its text as well).
  The header indicator is the app identity's own surface (`app_icon` →
  `desktop_entry` → theme fallback, never `noti.image`), and it SKIPS the file
  the artwork slot paints — which is what `notify-send -i <file>` needs, since
  libnotify sends that file as `app_icon`. The
  card hugs its content height — nothing inside it expands (`textBox` carries no
  `vexpand`), because an expanding child turns slack handed down by a holder
  into a void under the text with the action row pushed to the far bottom.
- `commands.ts` — request handlers (prefixed `["notifications", …]`).
- `config.ts` — owns the app's config store + facade (`createConfigStore`
  via `common/config/facade.ts`; no shared surface registry).
- `style.ts` — dynamic CSS builder; `log.ts` — the `[notifications]`-tagged
  logger (`log` + the deliberate-ignore channel).

## Config

The notifications app's OWN config (apps/notifications/config.{defaults,schema,json}) via its facade:

| Section | Purpose |
| --- | --- |
| `popup` | timeout/timeoutLow/timeoutCritical (urgency-tiered), positioning |
| `centre` | geometry: `width` (fixed), `minHeight` / `maxHeight` (the panel's height follows its content between the two; the maximum is also the scroller's cap), grouping |
| `grouping` | collapse/grouping rules |
| `code` | COPY-button gate: `apps` (browser/mail allowlist) + `keywords.{strong,weak,context}` (auth-code keyword signal) — see Gotchas. Set as JSON arrays (`notifications config set code.apps '["firefox"]'`) or by editing `config.json` + `config reload` |
| `appearance` | colours, card theming |
| `behaviour` | auto-dismiss, hover behaviour |
| `timing` | animation timings |

## Command surface

All registered PREFIXED (`["notifications", …]`):

| Path | Purpose |
| --- | --- |
| `notifications ping` | alive check (pong) |
| `notifications dnd get/set` | read/write DND through its ONE owner in `Notifd` (`setDndEnabled`: the reactive state + the daemon's `dont_disturb` + the durable value in the app's state store). `get` answers the owner's live state, not a file. DND has no config key |
| `notifications toggle-centre/show-centre/hide-centre` | control centre |
| `notifications close-all` | dismiss every live notification AND wipe the history (the one path that empties the centre's list) |
| `notifications dismiss` | dismiss one notification — it leaves the screen, its history entry stays |
| `notifications forget` | dismiss one notification and drop its history entry |
| `notifications invoke` | invoke an action |
| `notifications history` | notification history — one line per entry, `live`/`gone` prefixed |
| `notifications debug dump` | state introspection |
| `notifications debug centre` | centre geometry + list state (surface size, panel min/max/applied height, scroller adjustment and its cap, list allocation against its own natural height plus the first rows' heights, the SELECTED entry id, the visible entry ids, entry/live/VISIBLE/group counts) |
| `notifications inhibitor add/remove/clear/get` | hold or drop app ids that suppress popups |
| `notifications config get/set/reload` | live config via facade |

## Lifecycle

`notificationsMount()` (the shell's universal entry or island `app.ts`):

1. `initNotifd()` — claim the daemon (one-owner), set ignore_timeout, mirror
   DND, wire the notified/resolved signals.
2. `Popups()` — build the overlay.
3. `Centre()` + `setControl()` — build the centre, expose its control
   surface to the dispatcher.

No quit hook (the daemon dies with the process; the session's history is not
persisted — DND is the one durable mode, and it lives in the app's state store).

## Gotchas

- **The list's scroller must be capped or it grows the layer surface.** A
  `Gtk.ScrolledWindow` with a vertical policy of `AUTOMATIC` reports its child's
  full natural height until `max-content-height` bounds it, and a layer surface
  is sized from its widget — a long history stretched the centre past the screen
  and CLIPPED the list instead of scrolling it. `applyViewport()` (Centre.tsx)
  caps it at the CONFIGURED `centre.maxHeight` minus the list's bottom padding and
  re-runs on `map`, on show and after every history change. Do not compute the
  cap from a measured height: the scroller reports 0 until it has been laid out,
  and every pass that could react to that (map, show, history change) runs
  before the first frame — `get_height`, `get_allocation`, `compute_bounds` and
  `translate_coordinates` all answered 0 there, and `notify::allocation` did not
  fire again. Never bound it by the surface's live height either: that height is
  the growth the cap exists to stop.
- **The list's scroll is GTK's own path, and this app installs no controller.**
  A `Gtk.ScrolledWindow` scrolls itself: it runs its own scroll controllers, so
  the wheel, a trackpad's delta (scaled by its own surface factor) and the
  momentum after a flick (`GtkKineticScrolling`, with an overshoot spring at the
  ends) are all the widget's. An app-side `Gtk.EventControllerScroll` is a
  NON-GESTURE controller, `gtk_widget_add_controller` PREPENDS it, and
  `gtk_widget_run_controllers` stops the dispatch at the first non-gesture
  controller that returns TRUE — so a controller that consumed the continuous
  delta would latch that kinetic path off for the whole gesture and leave the app
  to imitate it. This surface therefore carries no controller, no tail, no eased
  step and no position accumulator; the keyboard's selection reveal
  (`revealChild`) writes the adjustment directly.
- **The swipe gesture is grouped with the card's click, and the click acts on
  `released`.** Two sibling gestures on one widget are mutually exclusive, so
  the `Gtk.GestureDrag` never starts unless `click.group(swipe)` groups them —
  and grouping does NOT stop `GestureClick::released` from firing when the drag
  wins, so a swipe would also run the card's default action at the release
  point. The click sets the flag on `pressed` (which fires before the drag
  threshold) and the drag claims it from `drag-begin`. **Grouping runs AFTER
  both controllers are attached**: GTK refuses to group a controller that has no
  widget yet (`gtk_gesture_group: assertion … failed`, one Gtk-CRITICAL per card
  created), and the ungrouped pair leaves the swipe dead.
- **A removal REFLOWS, it does not remap.** Each popup card sits in a
  `Gtk.Revealer` slot that collapses over `timing.transitionMs`; the column
  re-lays out every frame, so the cards below slide up into the vacated height.
  The slot's transition type must be a SLIDE_* one — `GtkRevealer` scales the
  child's measured size by the transition position only for the slide (and
  swing/fade-slide) types, so a CROSSFADE slot hides its card but keeps the
  vacated height and the stack SNAPS when the spent slot is dropped. The stack
  spacing is the card's own bottom margin, i.e. INSIDE the revealer, so a
  collapse takes the gap with it and dropping the slot afterwards moves
  nothing. Never force a repaint by hiding and re-showing the popup window:
  unmapping re-realizes the surviving cards, and `NotificationCard`'s appear
  fade is bound to their `realize` signal, so every survivor would replay the
  entry animation.
- **The sticky (critical) tier is the base card colour scaled by 0.7** —
  `appearance.cardRgb` darkened for `CRITICAL_DARKEN` in `style.ts`, with
  `appearance.cardAlphaCritical` untouched (a lowered alpha would make the
  never-expiring card the MORE transparent tier and invert the weight) — plus a
  blurred `box-shadow`: black elevation and a low-alpha spread of the
  `appearance.accent` role on the outer edge. Normal and low cards carry no
  shadow, so the tiers stay distinguishable at a glance.

- **A button carrying a label owns its whole box.** The action row is a
  `Gtk.FlowBox` (up to 7 actions on a line), and a FlowBox wraps every child in
  a `flowboxchild` that libadwaita pads 3px and tints on hover
  (`flowbox > flowboxchild:hover`) — a second, dimmer, larger box that spawned
  behind the button on hover, off-centre by the button's own margin. The row
  carries `card-actions` and the sheet includes
  `labelButtonRowCss` (common/css/card-chrome.ts), which flattens the wrapper:
  the button's own box is then the only box the pointer hits and the only box
  that repaints (`.action` carries no margin — the row's own
  `column_spacing` / `row_spacing` / padding own the spacing). Do not add a
  wrapper background or a button margin to this row.
- **`COPY "<code>"` is gated by config `code` — TWO ways in:** PATH 1 the
  sender matches `code.apps`; PATH 2 the notification's own TEXT carries an
  auth-code keyword signal (`code.keywords`). The keyword signal: a STRONG
  phrase ("otp", "2fa", "verification code", "one-time", "passcode", …)
  opens the gate alone; a WEAK term ("verification", "pin", "login", …) is
  auth-plausible but common, so it opens the gate only together with a CONTEXT
  phrase ("do not share", "expires in", "if you didn't request this", …).
  Matching is case-insensitive and whole-word (so `pin` never fires on
  "shipping") across title AND body, joined with a newline so no phrase can
  straddle the summary/body boundary.
- **A bare "code" is deliberately NOT a keyword** — "error code", "discount
  code", "promo code" are the false positives that started this; the multiword
  `<auth> code` forms ("verification code", "security code", "login code", …)
  carry the context instead. Add it to `code.keywords.weak` to accept the
  discount/promo tradeoff.
- **App identity for PATH 1** is `app_name` OR `desktop_entry`, normalized
  (lowercase, `.desktop` suffix stripped, non-alphanumerics → `-`), matched
  exactly or as an `entry-` variant ("chromium-browser",
  "firefox-developer-edition"). Either field can be empty, and a browser's
  webmail notification may carry the SITE's own name in `app_name` while
  `desktop_entry` still names the browser. A sender matching neither field
  (unknown app, missing identity) has only PATH 2 — the default is
  not-to-show. An empty `code.apps` disables PATH 1, an empty keyword list its
  half.
- **Either path still needs a code-shaped token:** a keyword match opens the
  gate (`copyCodeAllowed`), it does not create a code — `detect2fa` finds what
  the button copies. That detection is intentionally loose and unchanged: its
  `\d{4,8}` branch matches any 4–8 digit number (order ids, counters) and its
  `[A-Za-z0-9]{5}` branch matches letter+digit tokens (promo codes like
  SAVE20), so the GATE — not the regex — is what keeps the button rare.
- **Notification images decode through `common/media/decode`.** `noti.image` is
  the file the daemon cached the image to (the `image-path` hint covers both
  path and raw-image notifications), and the card loads it with `loadStill` —
  `Gdk.Texture.new_from_filename`, synchronous, throwing on a file it cannot
  decode, so a failed load leaves the card without the 200×100 slot instead of
  reserving an empty one. The async pixbuf entry point
  (`GdkPixbuf.Pixbuf.new_from_file_async`) has no gjs binding in this build
  (`undefined`), so calling it fails every image; the card's icon row resolves a
  path-shaped `app_icon` through the Gtk icon theme first, which loads files
  itself, and only falls back to the same `loadStill` call.
- **Every paintable the card binds is wrapped in `NullIntrinsicPaintable`**
  (`bound()` in `NotificationCard.tsx`, owner `common/media/paintable`).
  `Gtk.Picture` takes its NATURAL size from the paintable's intrinsic size —
  `set_size_request` is a MINIMUM, it cannot cap one — so a raw sender texture
  grows the picture to the file's own pixel size and the card (and the popup)
  with it. The wrapper reports no intrinsic size, which leaves each picture at
  the size the card asks for, with `content_fit: CONTAIN` filling it. The wrapper
  is for a paintable whose intrinsic size comes from a FILE or stream — a decoded
  texture — so the icon file fallback needs it too. A THEME LOOKUP needs none:
  the centre's `groupIcon` binds an `IconPaintable` straight onto its 28px
  picture, and an icon paintable's intrinsic size IS the size it was looked up
  with (`lookup_icon(name, …, N, …)` reports N for raster icons and for
  symbolic fallbacks alike), so that picture keeps its request.
- **The card is one row: the image is a column on the LEFT, the content column
  (header line, text, actions) sits beside it.** `bodyRow` (horizontal, spacing
  12) holds the optional thumbnail — a POPUP-only element: the centre card paints
  the sender's image in its large slot instead, since one card never shows one
  piece of artwork twice — and a vertical `card-content` box carrying the
  head, the main area and the action row — the click gesture still owns `main`,
  and the close button still lives in the head. The popup's own `popup.width`
  request stays the card's minimum, and the thumbnail's box is capped, so an image
  can add at most that cap to the card's natural width.
- **The thumbnail's box is the image's own shape, capped at
  `appearance.thumbnailSize`** (`thumbnailBox` in `NotificationCard.tsx`): the
  longest edge is the cap, the other follows the decoded pixel aspect, never
  upscaled — a 64×40 image stays 64×40 instead of being inflated into a fixed
  slot. Nothing is cropped, and since the bound paintable reports no intrinsic
  size the BOX ratio is the ratio the picture draws with, so the box has to keep
  the image's ratio. **`Gtk.Picture` floors its own height (~16px for a
  zero-intrinsic paintable): a very wide image takes that height and its width is
  re-derived from the ratio** (1200×200 measures 96×16, not a squeezed 80×16).
  `appearance.bodyImageWidth`/`bodyImageHeight` are gone — a fixed box is what
  cropped a square or portrait source into a wide strip; `bodyImageRadius` still
  rounds the thumbnail, and no CSS rule may size `.body-image` (a min-width or
  min-height there would force every image back into one fixed box).
- **Body text is escaped once, then only `<b>`/`<u>`/`<i>` are re-enabled**
  (the `sanitizeMarkup` rule). The escape is
  `GLib.markup_escape_text(text, -1)` — **`GLib.Markup` does not exist in gjs**
  (undefined), so a call on it throws and `setBody`'s fallback renders the body as
  plain text with its tags shown literally. The re-enable regexp matches the
  entity shape that escape produces (`&lt;b&gt;`), so any other tag a sender
  writes stays escaped and visible.
- **The centre reveals the selected card by moving the vertical adjustment**
  (`revealChild` in `Centre.tsx`): a GTK4 `ScrolledWindow` has no scroll-to-child
  method, so the card's bound is read in the scroller's coordinate space
  (`Gtk.Widget.compute_bounds` — gjs returns the `(ok, rect)` pair as an array,
  and the rect exposes `get_y`/`get_height`, not `x`/`y` fields) and the
  adjustment moved by the difference. **Astal's `WindowAnchor` has no
  `HORIZONTAL` member** (NONE / TOP / RIGHT / LEFT / BOTTOM): layer-shell centres
  a surface on an axis it holds no anchor bit for, so `TOP` alone gives the
  centre's top-centre placement.
- **ONE-OWNER RULE**: two processes instantiating the daemon race the
  `org.freedesktop.Notifications` name — shell or the island, never both.
- **DND has ONE owner: `Notifd.setDndEnabled`** — it sets the reactive state, the
  daemon's `dont_disturb` and the durable value in the app's state store
  (`~/.local/state/tinshell/apps/notifications/state.json`) in one call, and both
  the `notifications dnd set` handler and the centre's bell glyph call it.
  Nothing else owns the daemon's state, so prefer `notifications dnd set`. DND
  is a runtime mode rather than configuration, so it has NO config key:
  `notifications config set dnd.enabled …` answers "unknown config path", and
  `notifications dnd set` / `notifications dnd get` is the surface. A build that
  predates the state store persisted the mode in the config file, and the first
  mount carries that value across before pruning the key — required, not
  cosmetic, because the root schema is closed and a leftover `dnd` group would
  make `notifications config reload` refuse the file.
- **DND bypass**: `critical` urgency is the ONE class that reaches the screen
  through DND or an inhibitor; every other urgency waits in the centre until it
  is dismissed, and an open centre suppresses every popup.
- **`notify-send --action` IMPLIES `--wait`** — it blocks until the action is
  clicked (not a hang).
- **In-process actions** (notifyWithAction) are intercepted in `invokeAction`
  via `registerActionHandler` — the gir `n.invoke()` would round-trip to the
  dead sender for notifications created in-process. Each action of the list the
  sender declares gets its own handler, so several buttons on one notification
  are several entries, not several notifications.
- The daemon PERSISTS unresolved notifications in gsettings
  (`io.astal.notifd`) — do not fight it; expiry is popup-side by design.

## Packaging facts

- **Daemon package:** AstalNotifd ships from `libastal-notifd-git` (AUR),
  built with `-Dcli=false`; rebuild it BY HAND after astal updates.
