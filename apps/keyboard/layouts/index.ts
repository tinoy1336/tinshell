/**
 * Layout engine types + registry.
 *
 * Layouts are JSON (wvkbd-style custom schema): rows of keys, each key with a
 * label, an xkb keysym (for the ydotool backend) or an action, a width in
 * grid units, and optional repeat. Layouts are bundled at build time (esbuild
 * JSON imports), so the engine + layouts ship inside the shell bundle.
 *
 * Thumbs rows: a `gap` (grid units) marks the centre palm-rest split; the
 * renderer splits the row at the first key with action "gap" (explicit
 * marker) — or, absent a marker, auto-splits by cumulative width half.
 */
import standard from "./standard.json"
import thumbs from "./thumbs.json"

type KeyAction =
  | "space"
  | "backspace"
  | "enter"
  | "tab"
  | "caps"
  | "shift"
  | "symbols"
  | "layout"
  | "hide"
  | "gap"
  | "emoji"
  | "letters"

export interface KeyDef {
  label?: string
  /** xkb keysym name, resolved to an evdev keycode by keys/evdev.ts. */
  keysym?: string
  /** Keysym sent while shift/caps is active (e.g. "exclam" for "1"). */
  shiftKeysym?: string
  /** Raw UTF-8 text typed via sendText (emoji etc.) — no keysym/action. */
  text?: string
  /** Keysym sent on a horizontal swipe (quick punctuation: tap = keysym,
   *  swipe = swipeKeysym). */
  swipeKeysym?: string
  action?: KeyAction
  /** Key width in grid units (default 1). */
  width?: number
  /** Press-hold auto-repeats (client-side, keys/repeat.ts). */
  repeat?: boolean
  /** Label alignment within the key (default "center"). Left-edge
   *  modifiers use "left", right-edge modifiers "right". */
  align?: "left" | "right" | "center"
}

export interface RowDef {
  keys: KeyDef[]
  /** Thumbs only: centre palm-rest gap in grid units. */
  gap?: number
}

export interface LayoutDef {
  name: string
  rows: RowDef[]
  /** Symbols layer — same row shape (same row count keeps the height stable). */
  symbols?: RowDef[]
  /** Emoji layer — same row shape (same row count keeps the height stable). */
  emoji?: RowDef[]
}

// SAFETY: JSON module inference is loose (plain string fields); pin the imports to
// the layout contract here — the JSONs remain the data spec.
const LAYOUTS: Record<string, LayoutDef> = {
  standard: standard as unknown as LayoutDef,
  thumbs: thumbs as unknown as LayoutDef,
}

export function getLayout(name: string): LayoutDef | undefined {
  return LAYOUTS[name]
}

export function layoutNames(): string[] {
  return Object.keys(LAYOUTS)
}
