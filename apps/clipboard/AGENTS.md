# AGENTS.md — clipboard

The clipboard surface: resident cliphist capture + a picker popup. A REAL
standalone app (bus `io.Astal.clipboard`); this directory IS the app.

**READ the root `~/dev/tinshell/AGENTS.md` FIRST** (multi-app rules: bus
naming, router, launch path, shell aggregation, common modules, onboarding).

## Identity

| | |
| --- | --- |
| Instance / bus | in shell: inside `shell` (`io.Astal.shell`); dev island: `clipboard` (`io.Astal.clipboard`) |
| Unit | none (dev island; production = `tinshell-shell.service`) |
| Window namespace | `clipboard-picker` |
| Hyprland rule | blur `clipboard-picker` (`hl.layer_rule`, ignore_alpha 0.2 — own rule; the surface is a picker popup) |
| Router | `route-map.conf`: `clipboard=shell,clipboard` |
| Keybind | mod+SHIFT+V → `tinshell-route clipboard toggle` |

## Sources (what lives here)

- `capture.ts` — the resident capture loop (`startCapture()`): watches the
  cliphist store so history is populated before the picker opens.
  Config-gated: `clipboard.capture` (startup-read, keyboard-gating style).
- `Picker.tsx` — the popup window: searchable history list, pin/delete/
  clear actions, persist-images toggle. Every row leads with a delete control in
  its own left slot (`common/card/header`'s `glyphButton`, so the glyph is
  optically centred): dim at rest, brighter ink on hover and focus, always
  visible. The control is deliberately chrome-free — no outline, border,
  box-shadow or background fill in ANY state (the GTK theme's `button:hover` box
  and `button:focus:focus-visible` outline are neutralised for this control
  alone), so ink is its only cue and a boxed hover or focus ring is a regression.
  It deletes that row and nothing else — the row's own click still copies/activates
  — and deleting the selected row leaves the selection on the row that takes its
  place (the previous one when the removed row was the last). An IMAGE row carries
  a SECOND control BESIDE that one: a preview button (`PREVIEW_GLYPH`,
  `md-eye_outline`) that opens that entry's PNG in the media app against the
  most-recent media window (request `media open <absolute img/<id>.png>`). It is
  IMAGE-ONLY: a text row renders no preview control at all, so its row box is the
  one it always had. Built and styled exactly like the delete control (the shared
  `glyphButton`), and it dismisses the picker like an ordinary entry click does.
  The row's own copy/pin gesture IGNORES a press that lands on a control
  (`pressedOnControl` hit-tests the press): a row press runs the copy and hides
  the card, so without that rule a control press would copy the row instead and
  the control's own click would never complete its press/release pair. The
  delete control obeys the same rule. Dismissal via
  `common/window/popup-dismiss` (Escape / click-outside / focus-loss).
  The card is BOUNDED: `window.width`/`maxWidth` fix its width and
  `window.maxHeight` caps the list, which scrolls past that cap — a card
  sized to the full natural height of every entry is an impossible layer
  surface (shm reports "too big", the GL renderer segfaults in Mesa).
- `store.ts` — the app's state hub (history, pins, visibility) and the OWNER of
  the storage layout under `~/.local/share/clipboard`: `history.jsonl`,
  `img/<id>.png`, `thumbs/<id>.png`, `pinned.json` (the GC sweeps `img/` and
  `thumbs/` alike; `deleteImage()` drops both). Every entry carries a `hash`
  (the content hash of its text or of its PNG bytes, `contentHash()`) and
  `append()` treats an EXACT hash already in history as a duplicate: that row
  moves to the front with its own id, blob and thumbnail, and the incoming
  duplicate's blob is dropped — one content, one row. `promotedOrder()` is that
  ordering rule as a pure function. `remove(id)` is the ONE removal path (the
  picker's delete control, the Delete key and `clipboard delete <id>` all call
  it): the history line is rewritten through the same writer `append()` uses, the
  blob and its cached thumbnail are unlinked, and the id is dropped from the
  pinned set — no orphan blob, no pin pointing at nothing. `withoutEntry()` and
  `withoutPin()` are its pure halves, and an unknown id removes nothing (false,
  no file written).
- `store.probe.ts` — headless probe for the pure store rules: the duplicate
  rule (`promotedOrder`, `findDuplicate`, `entryHash`), removal
  (`withoutEntry`, `withoutPin`: id gone from history and from the pins, unknown
  id a no-op) and the tolerant JSONL loader (`parseHistory`). Blob/thumbnail
  unlinking is NOT pinned here — the probe writes no file, so those side effects
  need a real store.
  It exercises the pure functions only, so it never reads or rewrites the real
  history: `ags bundle --gtk 4 apps/clipboard/store.probe.ts /tmp/p.sh && bash /tmp/p.sh`.
- `style.probe.ts` — headless probe for the picker's stylesheet invariants, the
  one place a row control's chrome-freedom is checked: every rule targeting a
  control is scoped under the picker's window (so the override cannot leak
  onto another button), NO rule targeting it paints an outline, border,
  box-shadow or background fill in any state, hover and focus still change the
  glyph COLOUR, and the row box / the shared `common/shell/theme.css` carry no
  control rule. The control checks run per control — `row-delete` and
  `row-preview` — so a new row control is either neutralised the same way or
  fails the probe. It then hands the assembled sheet to a real `Gtk.CssProvider`
  (`parsing-error` is the only way to know a declaration was understood) and
  asserts `glyphButton`'s class lands on the BUTTON node.
  `ags bundle --gtk 4 apps/clipboard/style.probe.ts /tmp/s.sh && bash /tmp/s.sh`.
- `thumbs.ts` — the picker's cached scaled PNGs. **The picker must never decode
  an entry's full image**: one 2880x1800 screenshot costs ~47 ms to decode, paid
  per image row on EVERY open (~740 ms to show the picker with 35 image entries,
  versus ~20 ms to hide it). `ensureThumb()` builds a 96 px thumbnail once
  (~124 ms, a ~6 KB file) — on the CAPTURE path for new entries, and at MOUNT via
  `backfillThumbs()` for entries captured before the cache existed (one per idle
  tick, so a large legacy history never stalls the loop). A row whose thumbnail
  is still missing renders an empty picture rather than falling back to the full
  PNG.
- `commands.ts` — request handlers (prefixed `["clipboard", …]`).
- `config.ts` — owns the app's config store + facade (`createConfigStore`
  via `common/config/facade.ts`; no shared surface registry).
- `style.ts` — dynamic CSS builder; `log.ts` — the `[clipboard]`-tagged logger.

## Config

The clipboard app's OWN config (apps/clipboard/config.{defaults,schema,json}) via its facade:

| Section | Purpose |
| --- | --- |
| `capture` | resident capture loop (startup-read gate) |
| `maxEntries` | history cap |
| `persistImages` | keep images across reboots |
| `window` | picker geometry (width fraction, maxWidth, maxHeight cap) |
| `appearance` | colours, theming |

## Command surface

All registered PREFIXED (`["clipboard", …]`):

| Path | Purpose |
| --- | --- |
| `clipboard toggle/show/hide` | picker visibility |
| `clipboard focus-search` | focus the search entry |
| `clipboard history` | list history |
| `clipboard clear/delete` | clear all / delete one entry |
| `clipboard pin/unpin` | pin an entry (survives clearing) |

There is NO command for the row preview: the preview button calls the MEDIA
app's own request surface in process (`media open <path>` through
`common/commands/registry`, with the lazy pre-step `common/app/lazy`'s
`ensureLoaded` runs for a routed request of a lazy app), so no second call path
into media exists and no clipboard command is involved.
| `clipboard debug` | introspection |
| `clipboard config get/set/reload` | live config via facade |

## Lifecycle

`clipboardMount()` (the shell's universal entry or island `app.ts`):

1. `startCapture()` if `clipboard.capture` — resident capture loop
   (startup-read gate, keyboard-gating style).
2. `Picker()` + `setControl()` — build the picker popup once, show it on
   demand (launcher/promptd pattern).

No quit hook (state is cliphist/config-persisted).

## Gotchas

- The picker is a layer-surface popup like the launcher — the same
  dismissal semantics apply via the shared popup-dismiss util.
- Duplicate matching is EXACT content hash: no trimming, no whitespace
  normalisation, no fuzzy comparison. History written before the field existed
  still loads, and a hash-less TEXT row takes part in the rule (its hash is
  computed from its own text when compared); a hash-less IMAGE row does not —
  re-deriving one would re-read its PNG on every lookup, so it stops being a
  duplicate candidate once it is captured again.
- capture.ts drops any capture within 500 ms of the previous one (the own-echo
  backstop for a selection we set ourselves, fingerprint-first). A genuine
  re-copy inside that window is skipped; outside it the hash rule pops the
  existing row to the front.
- Pins survive `clipboard clear` by design (they are the point of pinning).
- The picker's rows are a GTK4 app, so every `Gtk.Button` starts with the default
  theme's chrome: `button:hover` (border + background-image + box-shadow) and the
  2px `button:focus:focus-visible` outline. The app sheet neutralises both for the
  row delete control only (its state list is scoped to `.row-delete`), which is
  what keeps the control reading as bare ink; any new button in this app keeps the
  theme's chrome unless it opts out the same way.
- The capture gate is startup-read — toggling `clipboard.capture` needs a
  restart (no hot-reload for the gate).
