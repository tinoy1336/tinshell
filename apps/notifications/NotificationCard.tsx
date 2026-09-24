/**
 * NotificationCard — the frosted card, shared by popups and the centre.
 *
 * IMPERATIVE factory (no gnim state inside): cards are created per
 * notification outside the reactive render tree (Popups manages its children
 * by hand; Centre rebuilds on state change), so per-card behaviour uses
 * explicit GTK wiring — signals, direct property sets, onClockTick for
 * timestamps — never createState. A replaced notification gets a FRESH card
 * (rebuilt on replace), so nothing here needs to react to field changes.
 *
 * Material (config appearance.* via the dynamic CSS block): frosted
 * rgba(10,12,17,0.5) card (0.62 critical), radius 18, JetBrainsMono Nerd
 * Font (suite default), 200×100 body image radius 12, action buttons radius 12,
 * circular 22px close button. The 48px square slot exists ONLY in the centre
 * variant AND only for SENDER ARTWORK (`noti.image`): popup cards have no slot,
 * and a notification whose sender supplied no image gets none either, because
 * the app icon already rides in the 18px header indicator beside the app-name
 * label. ONE PIECE OF ARTWORK PER CARD. `noti.image` has exactly one surface
 * per variant: the centre's 48px slot (`senderImagePicture`) or, in a popup —
 * which has no slot — the body-row thumbnail (`bodyImagePicture`), never both.
 * The header indicator resolves the app identity (`app_icon` / `desktop_entry` /
 * the theme fallback) and SKIPS the file the artwork slot paints, so
 * `notify-send -i <file>` — whose `app_icon` argument is that same file — cannot
 * draw the picture twice either.
 *
 * Behaviour parity (swaync):
 *   - primary click on the card body → "default" action if present, else dismiss;
 *     middle/right click → dismiss; a LEFT or RIGHT SWIPE on the body dismisses
 *     as well;
 *   - actions: one button per (id,label); a 2FA code detected in the summary
 *     or body (regex (?<= |^)(\d{3}(-| )\d{3}|\d{4,8}|[A-Za-z0-9]{5} mixed
 *     letter+digit)(?= |$|\.|,), first match, filtered to alphanumerics)
 *     renders a leading `COPY "<code>"` button that copies the code to the
 *     clipboard and dismisses — but ONLY when the sender or the notification
 *     text passes the `code` config gate (browsers/mail allowlist OR an
 *     auth-code keyword signal; see `copyCodeAllowed`);
 *   - invoking an action fires ActionInvoked via the daemon, closes the popup
 *     (behaviour.hideOnAction) and dismisses the notification unless resident;
 *   - body markup: escaped, then only <b>/<u>/<i> re-enabled (swaync's
 *     sanitizer) — set via Pango markup with a plain-text fallback;
 *   - progress bar when the "value" hint (0–100) is present;
 *   - relative timestamps ("Now" / "N min(s) ago" / ...), refreshed by the 60s
 *     clock;
 *   - the swipe's own rules: the pointer's travel fades the card and a release
 *     past a third of its width (never less than `SWIPE_MIN_PX`) is the swipe;
 *   - the card's ✕ reads by VARIANT: a popup's dismisses (the notification
 *     leaves the screen and its history entry stands), a centre card's removes
 *     that entry from the list (`forget`);
 *   - a card built for an entry the daemon already resolved (`live: false`)
 *     renders no sender actions — nothing is left to answer them;
 *   - a card for a resolved entry still dismisses nothing on a swipe: the drag
 *     is claimed (so it stays a drag, not a click) and moves nothing.
 */

import GLib from "gi://GLib"
import { copy } from "@common/clipboard"
import { loadStill } from "@common/media/decode"
import { NullIntrinsicPaintable } from "@common/media/paintable"
import { Gdk, Gtk } from "ags/gtk4"
import { get } from "./config"
import { ignore, log } from "./log"
import { dismiss, forget, invokeAction, invokeDefault, onClockTick } from "./Notifd"

interface NotificationCardProps {
  noti: any // AstalNotifd.Notification
  variant: "popup" | "centre"
  /** False for a history entry the daemon has already resolved: the sender's
   *  actions are dead, so the card renders only the local copy action and no
   *  action row. Defaults to live. */
  live?: boolean
  /** Centre-only: click body = invoke default (like swaync); selection is keyboard. */
  onActivate?: (n: any) => void
}

/** Floor for the swipe threshold, which is otherwise a third of the card's own
 *  width (`swipeThreshold`). */
const SWIPE_MIN_PX = 80

// 2FA code detector: swaync's original (src/notification/notification.vala)
// matched digit codes; extended with a 5-char alphanumeric branch (Steam
// guard codes like ABC12) that requires at least one letter AND one digit so
// plain words and pure numbers stay unmatched.
const CODE_RE =
  /(?<= |^)(\d{3}(-| )\d{3}|\d{4,8}|(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5})(?= |$|\.|,)/gm

function relativeTime(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec
  const mins = diff / 60
  const hours = mins / 60
  const days = hours / 24
  if (mins < 1) return "Now"
  if (hours < 1) return `${Math.floor(mins)} min${Math.floor(mins) > 1 ? "s" : ""} ago`
  if (days < 1) return `${Math.floor(hours)} hour${Math.floor(hours) > 1 ? "s" : ""} ago`
  return `${Math.floor(days)} day${Math.floor(days) > 1 ? "s" : ""} ago`
}

/** Escape, then re-enable only <b>/<u>/<i> (swaync's markup sanitizer).
 *  `GLib.markup_escape_text` is the C function @girs declares — `GLib.Markup`
 *  does not exist in gjs (the object is undefined, so a call on it throws and
 *  the body falls back to plain text, rendering the tags literally). */
function sanitizeMarkup(text: string): string {
  const escaped = GLib.markup_escape_text(text, -1)
  return escaped.replace(/&lt;(\/?(?:b|u|i))&gt;/g, "<$1>")
}

function setBody(label: Gtk.Label, body: string): void {
  const text = (body || "").trim()
  if (!text) {
    label.visible = false
    return
  }
  label.visible = true
  try {
    label.set_markup(sanitizeMarkup(text))
  } catch (e) {
    label.set_text(text)
    void e
  }
}

function detect2fa(text: string): string | null {
  const m = (text || "").match(CODE_RE)
  if (!m) return null
  // Keep alphanumerics only: '123-456' -> '123456' (grouped digit codes),
  // 'ABC12' stays 'ABC12' (Steam alphanumeric codes).
  return m[0].replace(/[^A-Za-z0-9]/g, "").trim() || null
}

/**
 * The COPY-button gate — two independent ways in (config `code`):
 *
 *   PATH 1 `code.apps`: the sender is one of the allowlisted app identities.
 *   PATH 2 `code.keywords`: the notification's own text carries an auth-code
 *          keyword signal (title and body are both scanned).
 *
 * Neither path replaces the code scan: a gate match still needs a detected
 * code-shaped token before a button can render (the button copies that token).
 *
 * PATH 1 — app identity. A notification identifies its sender in two
 * independent ways: `app_name` is the Notify app_name argument (libnotify's
 * set_app_name — a browser sends "Firefox"), `desktop_entry` is the
 * `desktop-entry` hint (a desktop-file id — "firefox", sometimes
 * "firefox.desktop"). Either can be empty, and a webmail notification
 * delivered through a browser can carry the SITE's own name in `app_name`
 * while `desktop_entry` still names the browser, so both fields are matched.
 *
 * PATH 2 — keyword signal. A STRONG phrase ("otp", "2fa", "verification
 * code", "one-time", "passcode", …) opens the gate on its own. A WEAK term
 * ("verification", "pin", "login", …) is auth-plausible but too common to
 * trust alone, so it opens the gate only alongside a CONTEXT phrase ("do not
 * share", "expires in", "if you didn't request this", …). A bare "code" is in
 * no list: it is exactly the word error/discount/promo/coupon codes use.
 * Matching is case-insensitive and whole-word, so "pin" never fires on
 * "shipping".
 */
function normalizeAppId(value: unknown): string {
  if (typeof value !== "string") return ""
  return value
    .trim()
    .toLowerCase()
    .replace(/\.desktop$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function appAllowed(noti: any): boolean {
  const allow = get<string[]>("code.apps", [])
  if (!Array.isArray(allow) || allow.length === 0) return false
  const ids = [normalizeAppId(noti?.app_name), normalizeAppId(noti?.desktop_entry)]
  return ids.some(
    (id) =>
      id !== "" &&
      allow.some((entry) => {
        const e = normalizeAppId(entry)
        // Exact desktop id, or one of its variants ("chromium-browser",
        // "firefox-developer-edition").
        return e !== "" && (id === e || id.startsWith(`${e}-`))
      }),
  )
}

/** Whole-word (phrase-boundary) test of one configured keyword list. */
function phraseMatch(haystack: string, phrases: unknown): boolean {
  if (!Array.isArray(phrases)) return false
  return phrases.some((phrase) => {
    if (typeof phrase !== "string") return false
    const p = phrase.trim().toLowerCase()
    if (!p) return false
    return new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(haystack)
  })
}

function keywordSignal(noti: any): boolean {
  // One haystack for both fields, joined by a newline so a phrase can never
  // straddle the summary/body boundary.
  const text = `${noti?.summary ?? ""}\n${noti?.body ?? ""}`.toLowerCase()
  if (phraseMatch(text, get<string[]>("code.keywords.strong", []))) return true
  return (
    phraseMatch(text, get<string[]>("code.keywords.weak", [])) &&
    phraseMatch(text, get<string[]>("code.keywords.context", []))
  )
}

function copyCodeAllowed(noti: any): boolean {
  return appAllowed(noti) || keywordSignal(noti)
}

/** Every paintable this card binds goes through the wrapper. Gtk.Picture takes
 *  its NATURAL size from the paintable's intrinsic size (can-shrink only clears
 *  the minimum), so the sender's own image — any pixel size — would otherwise
 *  grow the card and with it the popup. `NullIntrinsicPaintable`
 *  (common/media/paintable) reports no intrinsic size, leaving the picture's own
 *  size request as the size it keeps. */
function bound(paintable: Gdk.Paintable): Gdk.Paintable {
  return new NullIntrinsicPaintable(paintable) as unknown as Gdk.Paintable
}

/** The card's SMALL identity indicator (an 18px slot in the head row) — the app
 *  icon and nothing else: `app_icon` and `desktop_entry` as icon names, a
 *  path-shaped name as the file it names, then the icon theme's generic
 *  fallback. `noti.image` is deliberately NOT a candidate: that file belongs to
 *  the card's large artwork slot, and a card paints one piece of artwork ONCE.
 *  `skipPath` is the file the large slot already paints — a candidate naming it
 *  is dropped here (this is the `notify-send -i <file>` case, where the sender's
 *  `app_icon` argument IS the image), so the same picture never appears twice on
 *  one card. */
function appIconPicture(
  noti: any,
  sizeOverride?: number,
  cssClass = "app-icon",
  skipPath?: string,
): Gtk.Picture {
  const size = sizeOverride ?? get<number>("appearance.iconSize", 48)
  const picture = new Gtk.Picture()
  picture.add_css_class(cssClass)
  // The request is the picture's MINIMUM: `set_size_request` cannot cap a
  // natural size, so the paintable bound below is the only thing that keeps the
  // card from growing to the icon file's own pixel size.
  picture.set_size_request(size, size)
  picture.content_fit = Gtk.ContentFit.COVER
  // Never stretch with the row: keep it a fixed 48×48 square (a FILL valign in
  // a tall row stretches it into an oval).
  picture.set_valign(Gtk.Align.START)
  picture.set_halign(Gtk.Align.START)
  // @ts-expect-error runtime accepts this argument shape (type-only gap, msg: Argument of type 'Display | null' is not)
  const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
  // App-identity candidates, in order: app_icon (name or path), desktop_entry
  // (name). A candidate that names the large slot's own artwork is dropped —
  // that is the same picture, and the card paints it once.
  const candidates = [noti?.app_icon, noti?.desktop_entry].filter(
    (v): v is string => typeof v === "string" && v.length > 0 && v !== skipPath,
  )
  // 1) Theme-name lookups.
  for (const name of candidates) {
    try {
      const p = theme.lookup_icon(
        name,
        null,
        size,
        1,
        Gtk.TextDirection.NONE,
        // USE_BUILTIN was dropped from GTK4's flag set (NONE / FORCE_REGULAR /
        // FORCE_SYMBOLIC / PRELOAD) — the constant this read resolves to
        // undefined and reached the call as 0.
        Gtk.IconLookupFlags.NONE,
      )
      if (p) {
        picture.paintable = bound(p)
        return picture
      }
    } catch (e) {
      log(`icon lookup failed for '${name}': ${e}`)
    }
  }
  // 2) File paths (notify-send -i /path/to/img). The icon theme resolves a
  // path-shaped name itself, so this is the fallback for a name it could not
  // resolve; the load goes through the shared still decoder (`loadStill`:
  // Gdk.Texture.new_from_filename, synchronous, throws on an undecodable file).
  // An async pixbuf load has no gjs binding in this build
  // (GdkPixbuf.Pixbuf.new_from_file_async is undefined), so that route can
  // never load a file.
  for (const path of candidates) {
    if (path === skipPath) continue
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) continue
    try {
      picture.paintable = bound(loadStill(path).texture)
      return picture
    } catch (e) {
      log(`icon file decode failed for ${path}: ${e}`)
    }
  }
  // 3) Generic fallback.
  try {
    const p = theme.lookup_icon(
      "application-x-executable-symbolic",
      null,
      size,
      1,
      Gtk.TextDirection.NONE,
      Gtk.IconLookupFlags.NONE,
    )
    if (p) picture.paintable = bound(p)
    else log("icon fallback lookup returned null (application-x-executable-symbolic)")
  } catch (e) {
    log(`icon fallback lookup failed: ${e}`)
  }
  return picture
}

/** GTK floors a `Gtk.Picture`'s height (measured: a box asking for 13px is
 *  allocated 16px when the paintable reports no intrinsic size), so a very wide
 *  image cannot be shown in a box as thin as its ratio asks for. The box takes
 *  that height and the WIDTH follows the ratio — a stretched thumbnail is the
 *  failure this box exists to prevent, so the ratio wins over the width cap. */
const THUMB_MIN_HEIGHT = 16

/** The body image's box: its longest edge is `appearance.thumbnailSize` and the
 *  other follows the decoded image's own pixel aspect, never upscaled. So nothing
 *  is cropped, a small image keeps its own size, and the box ratio equals the
 *  image ratio. */
function thumbnailBox(width: number, height: number): { width: number; height: number } {
  const cap = get<number>("appearance.thumbnailSize", 80)
  const scale = Math.min(cap / width, cap / height, 1)
  const boxH = Math.max(THUMB_MIN_HEIGHT, Math.round(height * scale))
  return {
    // Re-derived from the floored height, so raising it never squeezes the image.
    width: Math.max(Math.round(width * scale), Math.round(boxH * (width / height)), 1),
    height: boxH,
  }
}

/** Notification image → the card's left thumbnail, POPUP cards only (the centre
 *  card shows the sender's image in its large slot instead, and one card never
 *  paints one piece of artwork twice). The daemon caches
 *  image-data/icon-data to a file itself (daemon.vala: cache_image) and exposes
 *  it via the image-path hint — so `noti.image` covers BOTH path and raw-image
 *  notifications; no manual image_data decode is needed here.
 *
 *  The decode goes through the shared still loader (`loadStill`: the Gdk texture
 *  the picture binds, plus the decoded size) — synchronous, and it throws on a
 *  file it cannot decode, so the failure is caught and logged here. Returns null
 *  when there is no image or it does not decode, so the card carries no empty
 *  column.
 *
 *  The texture goes through `bound`, so the sender's pixel size never reaches the
 *  card's layout; the box comes from the decoded size, so the thumbnail keeps the
 *  image's shape and `CONTAIN` fills it without cropping (a zero-intrinsic
 *  paintable has no ratio of its own, so the box ratio IS the ratio the picture
 *  draws with). */
function bodyImagePicture(noti: any): Gtk.Picture | null {
  if (!noti?.image) return null
  const path = noti.image
  if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null

  try {
    const still = loadStill(path)
    const box = thumbnailBox(still.width, still.height)
    const picture = new Gtk.Picture()
    picture.add_css_class("body-image")
    picture.set_size_request(box.width, box.height)
    picture.content_fit = Gtk.ContentFit.CONTAIN
    // Top-aligned beside the text: a tall thumbnail must not push the header down.
    picture.set_valign(Gtk.Align.START)
    picture.set_halign(Gtk.Align.START)
    picture.paintable = bound(still.texture)
    return picture
  } catch (e) {
    log(`image decode failed for ${path}: ${e}`)
    return null
  }
}

/** The centre card's large square slot — SENDER ARTWORK ONLY: the file the
 *  daemon cached out of the notification's own image (the `image-path` hint,
 *  which covers raw image-data and icon-data alike) and exposed as `noti.image`.
 *  The app icon is deliberately NOT a candidate here: the header row already
 *  renders it, so a slot resolved from `app_icon`, `desktop_entry` or the icon
 *  theme's generic fallback drew the same artwork a second time, at 48px. A
 *  notification whose sender supplied no image therefore renders NO slot at all
 *  rather than a placeholder.
 *
 *  Decoded and wrapped exactly like the other bound pictures: `loadStill` is
 *  synchronous and throws on a file it cannot decode, and `bound` reports no
 *  intrinsic size so the sender's pixel dimensions never reach the card's
 *  layout. */
function senderImagePicture(noti: any): Gtk.Picture | null {
  const path = noti?.image
  if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return null
  const size = get<number>("appearance.iconSize", 48)
  try {
    const picture = new Gtk.Picture()
    picture.add_css_class("app-icon")
    picture.set_size_request(size, size)
    picture.content_fit = Gtk.ContentFit.COVER
    picture.set_valign(Gtk.Align.START)
    picture.set_halign(Gtk.Align.START)
    picture.paintable = bound(loadStill(path).texture)
    return picture
  } catch (e) {
    log(`sender image decode failed for ${path}: ${e}`)
    return null
  }
}

export default function NotificationCard(props: NotificationCardProps): Gtk.Box {
  const { noti, variant } = props
  const live = props.live !== false
  const iconSize = get<number>("appearance.iconSize", 48)

  // ONE PIECE OF ARTWORK PER CARD. `noti.image` gets exactly one surface on
  // this card — the centre's large slot or the popup's body-row thumbnail — and
  // no other surface may paint that same file, so the head row's identity
  // indicator is told to skip it. This is the file both of those surfaces
  // resolve, and both bail on a path that is not on disk, so the predicate
  // matches what actually renders.
  const artworkPath =
    typeof noti?.image === "string" &&
    noti.image.length > 0 &&
    GLib.file_test(noti.image, GLib.FileTest.EXISTS)
      ? noti.image
      : undefined
  // That file's one surface: the centre's 48px slot. A popup has no slot and
  // paints it as the body-row thumbnail instead (see bodyRow below).
  const artwork = variant === "centre" ? senderImagePicture(noti) : null

  // Root card box: head row + clickable main + actions — the close button
  // lives in the HEAD, a SIBLING of the clickable main (swaync's structure:
  // close_button is an overlay sibling of default_action). A close button
  // INSIDE the gesture area never emits "clicked" (the exclusive press
  // sequence is claimed by the parent gesture).
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
  card.add_css_class("card")
  if (noti?.urgency === 2) card.add_css_class("critical") // AstalNotifd.Urgency.CRITICAL
  if (variant === "popup") {
    // Hard cap the popup card width ON THE CARD: in a full-screen window the
    // column's size_request is only a MINIMUM — an unconstrained summary
    // label's natural width grows the card past popup.width (it reached the
    // dock at top-right). The card's own request caps its allocation, and the
    // labels ellipsize/wrap inside it (the launcher card's proven pattern).
    card.set_size_request(get<number>("popup.width", 360), -1)
  }

  // ── Head row: app identity + summary + relative time + close (NOT clickable) ──
  const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 })
  head.add_css_class("head")

  // Small originating-app icon + app name at the TOP LEFT of the header
  // (macOS-banner arrangement). The header icon is its own css class — the
  // dynamic block pins .app-icon to the 48px main-row size, so reusing it
  // here would force the small Picture to 48px min.
  const HEADER_ICON_SIZE = 18
  const headerIcon = appIconPicture(noti, HEADER_ICON_SIZE, "header-app-icon", artworkPath)
  headerIcon.set_valign(Gtk.Align.CENTER)
  head.append(headerIcon)

  const appName = (noti?.app_name || noti?.desktop_entry || "").trim()
  if (appName) {
    const appLabel = new Gtk.Label({ label: appName, xalign: 0, ellipsize: 3 })
    appLabel.add_css_class("app-name")
    head.append(appLabel)
  }

  const summary = new Gtk.Label({ label: noti?.summary ?? "", xalign: 0, ellipsize: 3 })
  summary.add_css_class("summary")
  summary.set_hexpand(true)
  // Cap the NATURAL width — otherwise the label's full-text width drives the
  // card wider than popup.width (set_size_request is only a minimum) and the
  // text never wraps/ellipsizes. Mono 14px ≈ 30 chars ≈ 250px.
  summary.set_max_width_chars(30)

  const time = new Gtk.Label({ label: relativeTime(noti?.time ?? 0), xalign: 1 })
  time.add_css_class("time")
  const stopTick = onClockTick(() => time.set_label(relativeTime(noti?.time ?? 0)))

  const close = new Gtk.Button({ label: "✕" })
  close.add_css_class("close")
  close.set_valign(Gtk.Align.CENTER)
  close.set_can_focus(false)
  close.connect("clicked", () => {
    log(`card close clicked id=${noti.id}`)
    // The popup's ✕ takes the notification off the screen (its history entry
    // stands); the centre's ✕ removes the entry from the list it sits in.
    if (variant === "centre") forget(noti.id)
    else dismiss(noti.id)
  })

  head.append(summary)
  head.append(time)
  head.append(close)

  // ── Main body (default-action area) ──
  const main = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 })
  main.add_css_class("card-main")
  main.set_hexpand(true)

  // The big slot is the SENDER's artwork and the card's only copy of it: the
  // head row's 18px indicator carries the app identity instead, and it skips
  // this file (see artworkPath above). Popup cards have no big slot at all —
  // the body text claims the full popup width.
  if (artwork) main.append(artwork)

  const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
  textBox.add_css_class("text-box")
  textBox.set_hexpand(true)
  // No vexpand here: an expanding child of the card absorbs any height the card
  // is handed beyond its content and renders it as a void under the text (the
  // actions row then sits at the far bottom). The card hugs its content; a
  // holder with slack must not be able to stretch it.

  const body = new Gtk.Label({ xalign: 0, wrap: true })
  body.add_css_class("body")
  body.set_hexpand(true)
  // Same natural-width cap: wrap inside the card, never widen it.
  body.set_max_width_chars(30)
  setBody(body, noti?.body ?? "")

  textBox.append(body)

  // Progress bar from the "value" hint (0–100).
  try {
    const v = noti?.hints?.lookup_value("value", null)
    if (v !== null && v !== undefined) {
      const val = v.unpack()
      if (typeof val === "number" && val >= 0) {
        const bar = new Gtk.ProgressBar({ fraction: Math.min(1, val / 100) })
        bar.set_hexpand(true)
        textBox.append(bar)
      }
    }
  } catch (e) {
    // No "value" hint → the card renders without a progress bar.
    ignore("notification value hint read", e)
  }

  main.append(textBox)

  // ── Assembly: the sender's artwork is a COLUMN on the LEFT of the card and
  // the card's own content — header line, text, actions — is the column beside
  // it. That column belongs to the POPUP variant only: a popup card has no large
  // slot, so the thumbnail is the sender image's one surface there, while the
  // centre card paints the same file in its large slot and must not draw a
  // second copy beside the text. ──
  const bodyRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 })
  bodyRow.add_css_class("card-row")
  const thumb = variant === "popup" ? bodyImagePicture(noti) : null
  if (thumb) bodyRow.append(thumb)

  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
  content.add_css_class("card-content")
  content.set_hexpand(true)
  content.append(head)
  content.append(main)
  bodyRow.append(content)
  card.append(bodyRow)

  // ── Click behaviour (swaync parity) ──
  const click = new Gtk.GestureClick()
  click.set_button(0)
  // A drag still ends with a GestureClick release on this GTK — grouping does
  // NOT suppress it (annotate's phantom-dot bug). Without the flag a swipe would
  // also fire the card's default action at the release point, so the click acts
  // on `released` and is gated on the drag that owned the sequence. The flag is
  // reset on click-press, which fires before the drag threshold is crossed.
  let swipeOwned = false
  click.connect("pressed", () => {
    swipeOwned = false
  })
  click.connect("released", (_g: unknown, _n: number, _x: number, _y: number) => {
    if (swipeOwned) return
    const btn = (click as any).get_current_button()
    log(`card gesture released id=${noti.id} btn=${btn}`)
    if (btn === 1) {
      if (props.onActivate) props.onActivate(noti)
      else invokeDefault(noti)
    } else if (btn === 2 || btn === 3) {
      dismiss(noti.id)
    }
  })
  main.add_controller(click)

  // ── Swipe to dismiss ──
  // Left or right on the card body: the card fades under the pointer by as much
  // of the gesture as its own width allows, and a release past a third of the
  // width dismisses it. GTK4 has no per-widget translate an app may set (a
  // layout-managed child is re-allocated by its parent every frame), so the drag
  // reads through the fade rather than sliding the card sideways.
  const swipe = Gtk.GestureDrag.new()
  // Grouped with the click: two sibling gestures on one widget are otherwise
  // mutually exclusive and the drag never starts (annotate's pattern). The
  // grouping runs AFTER both controllers are attached — GTK refuses to group a
  // controller that has no widget yet, so grouping before `add_controller(swipe)
  // left the two ungrouped and logged a Gtk-CRITICAL per card.
  const swipeThreshold = (): number =>
    Math.max(SWIPE_MIN_PX, Math.round(Math.max(card.get_width(), 1) / 3))
  swipe.connect("drag-begin", () => {
    swipeOwned = true
  })
  swipe.connect("drag-update", () => {
    // A history entry has nothing left on the screen to dismiss: the drag is
    // claimed (so it stays a drag, not a click) and moves nothing.
    if (!live) return
    const [ok, dx] = swipe.get_offset()
    if (!ok) return
    card.opacity = Math.max(0.3, 1 - Math.abs(dx) / swipeThreshold())
  })
  swipe.connect("drag-end", () => {
    const [ok, dx] = swipe.get_offset()
    // Whatever the outcome the card returns to full opacity: a dismissed popup
    // runs its own exit fade, and a centre row that stays listed must not keep
    // the pointer's last opacity.
    card.opacity = 1
    if (!live || !ok || Math.abs(dx) < swipeThreshold()) return
    log(`card swipe id=${noti.id} dx=${Math.round(dx)}`)
    dismiss(noti.id)
  })
  main.add_controller(swipe)
  click.group(swipe)

  // ── Actions row (2FA COPY first, then each action) — FlowBox, one line
  // up to 7 (swaync's alt-actions layout). A history entry has no sender left
  // to answer an action, so only the local COPY button renders for it.
  const actions: any[] = live ? (noti?.actions ?? []) : []
  // Scan summary first, fall back to body (separate scans — concatenating
  // would let a summary/body boundary merge into a false grouped code). The
  // scan only runs for an allowlisted sender or an auth-code keyword signal
  // (config code.apps / code.keywords).
  const code = copyCodeAllowed(noti)
    ? (detect2fa(noti?.summary ?? "") ?? detect2fa(noti?.body ?? ""))
    : null
  if (code || actions.length > 0) {
    const row = new Gtk.FlowBox({ column_spacing: 4, row_spacing: 4 })
    row.add_css_class("actions")
    // The shared label-button row rule: a FlowBox wraps every child in a
    // flowboxchild, and the theme pads + tints that wrapper on hover (a second,
    // larger box around the button). `card-actions` flattens it, so the
    // button's own box is the only box the pointer hits or repaints.
    row.add_css_class("card-actions")
    row.set_selection_mode(Gtk.SelectionMode.NONE)
    row.set_halign(Gtk.Align.START)
    row.set_max_children_per_line(Math.max(1, Math.min((code ? 1 : 0) + actions.length, 7)))

    const makeBtn = (label: string, onClick: () => void): Gtk.Button => {
      const b = new Gtk.Button({ label })
      b.add_css_class("action")
      b.set_can_focus(false)
      b.connect("clicked", onClick)
      return b
    }

    if (code) {
      row.append(
        makeBtn(`COPY "${code}"`, () => {
          copy(code)
          dismiss(noti.id)
        }),
      )
    }
    for (const a of actions) {
      if (typeof a?.id !== "string") continue
      if ((a.id || "").toLowerCase() === "default") continue // default = card-body click (invokeDefault), not a button
      row.append(makeBtn(a.label || a.id, () => invokeAction(noti, a.id)))
    }
    // The actions ride in the content column, not the card: they belong beside
    // the thumbnail, under the text, and a full-width row under the image would
    // push the thumbnail's column out of the card's width.
    content.append(row)
  }

  // Animate in (popup only): fade from 0 over timing.transitionMs. The tick
  // must start at REALIZE (add_tick_callback returns 0 on unrealized widgets);
  // a failed tick falls back to instant opacity.
  if (variant === "popup") {
    const durMs = get<number>("timing.transitionMs", 200)
    if (durMs > 0) {
      const durUs = durMs * 1000
      let runner = 0
      card.connect("realize", () => {
        card.opacity = 0
        const t0 = GLib.get_monotonic_time()
        runner = (card as any).add_tick_callback(() => {
          const t = Math.min(1, (GLib.get_monotonic_time() - t0) / durUs)
          card.opacity = 1 - (1 - t) * (1 - t)
          return t < 1
        })
        if (runner === 0) card.opacity = 1
      })
      card.connect("destroy", () => {
        if (runner) {
          try {
            ;(card as any).remove_tick_callback(runner)
          } catch (e) {
            // The card's frame source is already gone with the widget.
            ignore("notification card progress tick remove", e)
          }
        }
      })
    }
  }

  // Stop the 60s clock when the card is torn down (popup removal detaches the
  // column child; the widget finalizes once unreferenced, firing "destroy").
  card.connect("destroy", () => stopTick())

  return card
}
