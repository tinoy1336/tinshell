/**
 * keys/evdev.ts — keysym → evdev keycode mapping for the ydotool backend.
 *
 * ydotool speaks raw evdev keycodes (KEY_A=30, KEY_ENTER=28, ...) via uinput;
 * the compositor's own keymap translates them, so NO keymap upload is needed.
 * Why ydotool and not wtype: see keys/backend.ts.
 *
 * Only the keysyms the layouts actually use are mapped (letters, digits,
 * punctuation + their shifted forms, and the action keysyms). The standard
 * layout's modifier keys (Control_L/Super_L/Alt_L/Alt_R) are not mapped yet,
 * so they resolve to null and are logged by the backend, never silently
 * dropped.
 */

interface KeySpec {
  /** evdev keycode (KEY_A = 30, KEY_ENTER = 28, ...). */
  code: number
  /** Send with the left-shift modifier held (shifted symbols, capitals). */
  shift?: boolean
}

/** Left Shift evdev keycode. */
const SHIFT_CODE = 42

// Unshifted punctuation + control keysyms (evdev keycodes).
const PUNCT: Record<string, KeySpec> = {
  minus: { code: 12 },
  equal: { code: 13 },
  bracketleft: { code: 26 },
  bracketright: { code: 27 },
  semicolon: { code: 39 },
  apostrophe: { code: 40 },
  grave: { code: 96 },
  backslash: { code: 43 },
  comma: { code: 51 },
  period: { code: 52 },
  slash: { code: 53 },
  space: { code: 57 },
  Tab: { code: 15 },
  Return: { code: 28 },
  BackSpace: { code: 14 },
  Escape: { code: 1 },
}

// Shifted symbols (the same physical key with shift held).
const PUNCT_SHIFT: Record<string, KeySpec> = {
  exclam: { code: 2, shift: true },
  at: { code: 3, shift: true },
  numbersign: { code: 4, shift: true },
  dollar: { code: 5, shift: true },
  percent: { code: 6, shift: true },
  asciicircum: { code: 7, shift: true },
  ampersand: { code: 8, shift: true },
  asterisk: { code: 9, shift: true },
  parenleft: { code: 10, shift: true },
  parenright: { code: 11, shift: true },
  underscore: { code: 12, shift: true },
  plus: { code: 13, shift: true },
  braceleft: { code: 26, shift: true },
  braceright: { code: 27, shift: true },
  bar: { code: 43, shift: true },
  colon: { code: 39, shift: true },
  quotedbl: { code: 40, shift: true },
  less: { code: 51, shift: true },
  greater: { code: 52, shift: true },
  question: { code: 53, shift: true },
  asciitilde: { code: 96, shift: true },
}

const LETTERS: Record<string, number> = {
  a: 30,
  b: 48,
  c: 46,
  d: 32,
  e: 18,
  f: 33,
  g: 34,
  h: 35,
  i: 23,
  j: 36,
  k: 37,
  l: 38,
  m: 50,
  n: 49,
  o: 24,
  p: 25,
  q: 16,
  r: 19,
  s: 31,
  t: 20,
  u: 22,
  v: 47,
  w: 17,
  x: 45,
  y: 21,
  z: 44,
}

const DIGITS: Record<string, number> = {
  "1": 2,
  "2": 3,
  "3": 4,
  "4": 5,
  "5": 6,
  "6": 7,
  "7": 8,
  "8": 9,
  "9": 10,
  "0": 11,
}

/** Resolve an xkb keysym name (as the layouts use) to an evdev key spec. */
export function keysymToEvdev(keysym: string): KeySpec | null {
  if (/^[a-z]$/.test(keysym)) return { code: LETTERS[keysym] }
  if (/^[A-Z]$/.test(keysym)) return { code: LETTERS[keysym.toLowerCase()], shift: true }
  if (DIGITS[keysym]) return { code: DIGITS[keysym] }
  if (PUNCT[keysym]) return PUNCT[keysym]
  if (PUNCT_SHIFT[keysym]) return PUNCT_SHIFT[keysym]
  return null
}

/** Build the ydotool argv for a key spec (press[+shift] … release). */
export function keyArgv(spec: KeySpec): string[] {
  const down = spec.shift ? [`${SHIFT_CODE}:1`, `${spec.code}:1`] : [`${spec.code}:1`]
  const up = spec.shift ? [`${spec.code}:0`, `${SHIFT_CODE}:0`] : [`${spec.code}:0`]
  return ["ydotool", "key", ...down, ...up]
}
