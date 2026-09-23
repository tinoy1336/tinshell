# AGENTS.md — notifications

The notifications surface: daemon ownership + popups + control centre
(replaces swaync). A REAL standalone app (bus `io.Astal.notifications`); this
directory IS the app.

**READ the repository root `AGENTS.md` FIRST** (multi-app rules: bus
naming, router, launch path, shell aggregation, common modules, onboarding).

## Identity

| | |
| --- | --- |
| Instance / bus | in shell: inside `shell` (`io.Astal.shell`); dev island: `notifications` (`io.Astal.notifications`) |
| Unit | none (dev island; production = `tinshell-shell.service`) |
| ONE-OWNER | `org.freedesktop.Notifications` (AstalNotifd daemon) — never run shell AND this island at once |
| Window namespaces | `notifications-popup` (full-screen overlay, input region = card rects), `notifications-centre` (500×600, top-centre) |
| Hyprland rule | blur `notifications-.*` (`hl.layer_rule`, ignore_alpha 0.2) |
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
    sticky) — swaync's model, not the clients' timeouts.
  - mirrors `dont-disturb` from config `dnd.enabled` (AstalNotifd's shared
    daemon DND value).
  - reactive state consumed by Popups/Centre: notifications (unresolved,
    newest first), popup ids, inhibitors, centre visibility.
  - per-notification expiry timers ONLY while a popup is shown (swaync
    semantics: DND'd/inhibited notifications stay in the centre).
  - swaync-compat inhibitors DBus interface
    (`org.erikreider.swaync.cc` at `/org/erikreider/swaync/cc` —
    AddInhibitor/RemoveInhibitor/ClearInhibitors/NumberOfInhibitors/
    IsInhibited) so `swaync-client --inhibitor-add/remove` keeps working
    (screen-sharing still inhibits notifications).
  - in-process action handlers (`registerActionHandler`) intercept
    `invokeAction` — AstalNotifd gir 0.1 has NO `notify()` on the daemon and
    `n.invoke()` round-trips to the dead sender for in-process notifications.
- `Popups.tsx` — the floating surface: ONE full-screen overlay, cards stacked
  top-centre newest-first, each card in a `Gtk.Revealer` slot, input region =
  the card column's rect.
- `Centre.tsx` — the control centre (swaync's control-centre window): 500×600
  layer surface, layer TOP, anchored top-centre, keymode EXCLUSIVE while open.
- `NotificationCard.tsx` — imperative card factory (no gnim state inside;
  Popups manages children).
- `commands.ts` — request handlers (prefixed `["notifications", …]`).
- `config.ts` — owns the app's config store + facade (`createConfigStore`
  via `common/config/facade.ts`; no shared surface registry).
- `style.ts` — dynamic CSS builder; `log.ts` — the `[notifications]`-tagged
  logger (`log` + the deliberate-ignore channel).

## Config

The notifications app's OWN config (apps/notifications/config.{defaults,schema,json}) via its facade:

| Section | Purpose |
| --- | --- |
| `dnd` | enabled (↔ daemon `dont-disturb`) |
| `popup` | timeout/timeoutLow/timeoutCritical (urgency-tiered), positioning |
| `centre` | geometry, grouping |
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
| `notifications dnd get/set` | read/write DND (persisted) |
| `notifications toggle-centre/show-centre/hide-centre` | control centre |
| `notifications close-all` | clear the stack |
| `notifications dismiss` | dismiss one notification |
| `notifications invoke` | invoke an action |
| `notifications history` | notification history |
| `notifications debug dump` | state introspection |
| `notifications inhibitor add/remove/clear/get` | swaync-compat inhibitors |
| `notifications config get/set/reload` | live config via facade |

## Lifecycle

`notificationsMount()` (the shell's universal entry or island `app.ts`):

1. `initNotifd()` — claim the daemon (one-owner), set ignore_timeout, mirror
   DND, wire notified/resolved signals, export the inhibitors interface.
2. `Popups()` — build the overlay.
3. `Centre()` + `setControl()` — build the centre, expose its control
   surface to the dispatcher.

No quit hook (the daemon dies with the process; state is config-persisted).

## Gotchas

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
  12) holds the optional thumbnail and a vertical `card-content` box carrying the
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
  (swaync's sanitizer, `sanitizeMarkup`). The escape is
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
- **DND bypass**: `critical` urgency and the `swaync:bypass-dnd` hint bypass
  DND (swaync semantics).
- **`notify-send --action` IMPLIES `--wait`** — it blocks until the action is
  clicked (not a hang).
- **In-process actions** (notifyWithAction) are intercepted in `invokeAction`
  via `registerActionHandler` — the gir `n.invoke()` would round-trip to the
  dead sender for notifications created in-process.
- The daemon PERSISTS unresolved notifications in gsettings
  (`io.astal.notifd`) — do not fight it; expiry is popup-side by design.

## Packaging facts

- **Daemon package:** AstalNotifd ships from `libastal-notifd-git` (AUR),
  built with `-Dcli=false`; rebuild it BY HAND after astal updates.
