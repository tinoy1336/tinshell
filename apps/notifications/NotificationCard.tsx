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
 * circular 22px close button. The 48px circular main icon exists ONLY in the
 * centre variant — popup cards have no big icon: the small 18px header
 * app-indicator beside the app-name label is the only icon, and the body text
 * uses the full popup width.
 *
 * Behaviour parity (swaync):
 *   - primary click on the card body → "default" action if present, else dismiss;
 *     middle/right click → dismiss;
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
 *     clock.
 */

import GLib from "gi://GLib"
import { copy } from "@common/clipboard"
import { loadStill } from "@common/media/decode"
import { NullIntrinsicPaintable } from "@common/media/paintable"
import { Gdk, Gtk } from "ags/gtk4"
import { get } from "./config"
import { ignore, log } from "./log"
import { dismiss, invokeAction, invokeDefault, onClockTick } from "./Notifd"

interface NotificationCardProps {
  noti: any // AstalNotifd.Notification
  variant: "popup" | "centre"
  /** Centre-only: click body = invoke default (like swaync); selection is keyboard. */
  onActivate?: (n: any) => void
}

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

function appIconPicture(noti: any, sizeOverride?: number, cssClass = "app-icon"): Gtk.Picture {
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
  // Icon source candidates, in order: app_icon (name), desktop_entry (name),
  // then the image-path hint — many senders (notify-send -i) deliver their
  // icon as image-path with a THEME NAME value, with an empty app_icon.
  const candidates = [noti?.app_icon, noti?.desktop_entry, noti?.image].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
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

/** Notification image → the card's left thumbnail. The daemon caches
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

export default function NotificationCard(props: NotificationCardProps): Gtk.Box {
  const { noti, variant } = props
  const iconSize = get<number>("appearance.iconSize", 48)

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
  const headerIcon = appIconPicture(noti, HEADER_ICON_SIZE, "header-app-icon")
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
    dismiss(noti.id)
  })

  head.append(summary)
  head.append(time)
  head.append(close)

  // ── Main body (default-action area) ──
  const main = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 })
  main.add_css_class("card-main")
  main.set_hexpand(true)

  // Popup cards have NO big 48px main icon — the body text claims the
  // full popup width (the head row's small 18px header-app-icon is the only
  // icon there). The centre variant keeps the main icon.
  if (variant === "centre") {
    const icon = appIconPicture(noti)
    main.append(icon)
  }

  const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
  textBox.add_css_class("text-box")
  textBox.set_hexpand(true)
  textBox.set_vexpand(true)

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

  // ── Assembly: the image is a COLUMN on the LEFT of the card, and the card's
  // own content — header line, text, actions — is the column beside it. The
  // column splits the card's width: the image carries its own bounded box
  // (`bodyImagePicture`) and the content keeps hexpand, so nothing the sender
  // ships can widen the card past its own `popup.width` request. ──
  const bodyRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 })
  bodyRow.add_css_class("card-row")
  const thumb = bodyImagePicture(noti)
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
  click.connect("pressed", (_g: unknown, _n: number, _x: number, _y: number) => {
    const btn = (click as any).get_current_button()
    log(`card gesture pressed id=${noti.id} btn=${btn}`)
    if (btn === 1) {
      if (props.onActivate) props.onActivate(noti)
      else invokeDefault(noti)
    } else if (btn === 2 || btn === 3) {
      dismiss(noti.id)
    }
  })
  main.add_controller(click)

  // ── Actions row (2FA COPY first, then each action) — FlowBox, one line
  // up to 7 (swaync's alt-actions layout).
  const actions: any[] = noti?.actions ?? []
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
