/**
 * common/media/preview.ts — the ONE preview preference, shared by every host
 * that mounts the media pane (files' browser, the portal chooser).
 *
 * The preference lives in its OWN state store (`common/state`, app id
 * `media-preview` — `~/.local/state/tinshell/apps/media-preview/state.json`), never
 * in a host's config: two hosts reading two config files would be two owners of
 * one setting, and a flip in one host could not reach the other. Hosts read the
 * effective settings and write through the setters here; nothing else persists
 * a preview preference.
 *
 * Nothing stored means OFF: an opt-in pane must not silently change a host's
 * layout on a first run. Every other field falls back to its shipped default
 * the same way, and a stored value that fails its validator is dropped by the
 * store on load (a hand-edited file cannot put the hosts in a broken state).
 *
 * The file MONITOR is what makes one preference real across processes: in the
 * shell every host shares one process, but in dev each host is its own island
 * (the portal unit is resident while the files island comes and goes), so a
 * write in one process must reach the subscribers in the other. The monitor is
 * per process and lives as long as the module does; listeners come and go with
 * their windows.
 *
 * WHAT IS SHARED AND WHAT IS PER WINDOW: `mode` and `width` are shared state —
 * the divider's drag writes the one side-slot width every host reads. The
 * feature SWITCH is per WINDOW (`createPreviewSession`): the stored `enabled`
 * value is the last applied setting a new window starts from, and a flip in one
 * window is written back as that memory, but it never moves another open
 * window's pane.
 */
import Gio from "gi://Gio"
import { ignore } from "@common/log/logger"
import { createStateStore, type StateStore } from "@common/state"
import type { MediaPaneMode } from "./pane"

/** State-store app id — its own XDG state dir, not a host's. */
const STATE_APP = "media-preview"

/** The pane's MINIMUM SIZE in px, the floor of a stored width, and the width a
 *  drag is held to. A narrower slot cannot show a still legibly, so a stored
 *  value below it is rejected rather than clamped silently. The shared divider
 *  (`common/media/divider`) also holds a DRAG at this width: the pane resists at
 *  its floor instead of being pushed past it, so no drag can leave a sliver on
 *  screen, and a width at or above the floor is the width that gets stored. Only
 *  a drag that travels below `PREVIEW_SNAP_SHUT_WIDTH` — half the floor — folds
 *  the pane shut and turns this switch off.
 *
 *  200 is the pane's own content floor plus slack: the detail grid is the
 *  widest fixed content it draws (a label column capped at 6 characters, 10px of
 *  column spacing, a value column capped at 10 characters), which measures
 *  around 150px at the note size derived from the shipped 16px body font. Below
 *  that the detail values are clipped rather than usefully abbreviated, and a
 *  still is a thumbnail rather than a preview. */
export const PREVIEW_MIN_WIDTH = 200

/** The pane width a DRAG has to travel below before the pane snaps shut: HALF
 *  the floor, so the pane is held at its floor while the divider sits anywhere in
 *  the band between the two, and closing the pane takes a deliberate overshoot —
 *  the drag has to ask for less than half the width the pane needs before the
 *  divider stops resisting it.
 *
 *  DRAG-TIME ONLY. This is not a second floor for the STORED width: `isWidth`
 *  validates against `PREVIEW_MIN_WIDTH`, so a width in the snap band is never
 *  persisted and the pane always returns at a width it can show. */
export const PREVIEW_SNAP_SHUT_WIDTH = PREVIEW_MIN_WIDTH / 2

/** The host-facing preference. */
interface PreviewSettings {
  /** The feature switch — false until something stores a value. */
  enabled: boolean
  /** The pane's shape: a side slot beside the host's list, or the full body. */
  mode: MediaPaneMode
  /** Side-slot width in px (`pane` mode). */
  width: number
}

/** Shipped defaults: OFF, a side slot, a 260px slot. */
const DEFAULTS: PreviewSettings = { enabled: false, mode: "pane", width: 260 }

const KEYS = ["enabled", "mode", "width"] as const
type Key = (typeof KEYS)[number]

let store: StateStore<Key> | null = null
let watch: Gio.FileMonitor | null = null
const listeners = new Set<(settings: PreviewSettings) => void>()
let current: PreviewSettings = { ...DEFAULTS }

function isMode(v: unknown): v is MediaPaneMode {
  return v === "pane" || v === "full"
}

function isWidth(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= PREVIEW_MIN_WIDTH
}

/** The stored value for each key, falling back to its default. The store has
 *  already dropped invalid values on load, so a key is either valid or unset. */
function read(s: StateStore<Key>): PreviewSettings {
  const enabled = s.get("enabled")
  const mode = s.get("mode")
  const width = s.get("width")
  return {
    enabled: typeof enabled === "boolean" ? enabled : DEFAULTS.enabled,
    mode: isMode(mode) ? mode : DEFAULTS.mode,
    width: isWidth(width) ? width : DEFAULTS.width,
  }
}

/** Hand the settings to the listeners — only when they actually changed, so a
 *  write that rewrites the file with the same content costs no host a repaint. */
function emit(s: StateStore<Key>): void {
  const next = read(s)
  if (
    next.enabled === current.enabled &&
    next.mode === current.mode &&
    next.width === current.width
  ) {
    return
  }
  current = next
  for (const cb of [...listeners]) cb(next)
}

/** The store, created on first use: one file, one monitor per process. */
function ensureStore(): StateStore<Key> {
  if (store) return store
  const created = createStateStore<Key>({
    app: STATE_APP,
    version: 1,
    keys: {
      enabled: (v) => typeof v === "boolean",
      mode: isMode,
      width: isWidth,
    },
  })
  store = created
  current = read(created)
  try {
    const file = Gio.File.new_for_path(created.path())
    watch = file.monitor_file(Gio.FileMonitorFlags.NONE, null)
    watch.connect("changed", () => {
      // Another process owns the same preference — re-read and fan out. Our own
      // writes land here too; emit() then sees no change.
      created.reload()
      emit(created)
    })
  } catch (e) {
    // No monitor means no cross-process flip; the in-process path still works,
    // so this degrades instead of failing the host.
    ignore("preview state monitor", e)
  }
  return created
}

/** The effective settings (defaults where nothing is stored). */
export function previewSettings(): PreviewSettings {
  const s = ensureStore()
  return read(s)
}

/** The effective feature switch. */
export function previewEnabled(): boolean {
  return previewSettings().enabled
}

/** Set the feature switch. Returns the effective settings after the write. */
export function setPreviewEnabled(enabled: boolean): PreviewSettings {
  const s = ensureStore()
  s.set("enabled", enabled)
  emit(s)
  return read(s)
}

/** Set the pane shape. Returns the effective settings after the write. */
export function setPreviewMode(mode: MediaPaneMode): PreviewSettings {
  const s = ensureStore()
  if (!isMode(mode)) return read(s)
  s.set("mode", mode)
  emit(s)
  return read(s)
}

/** Set the side-slot width in px. Returns the effective settings after the
 *  write (unchanged when the value fails the floor / integer check). */
export function setPreviewWidth(width: number): PreviewSettings {
  const s = ensureStore()
  if (!isWidth(width)) return read(s)
  s.set("width", width)
  emit(s)
  return read(s)
}

/** Flip the feature switch. Returns the effective settings after the write. */
export function togglePreview(): PreviewSettings {
  return setPreviewEnabled(!previewEnabled())
}

/** Subscribe to preference changes, local and cross-process. Returns the
 *  unsubscribe function — every host drops its subscription with its window. */
export function onPreviewChanged(cb: (settings: PreviewSettings) => void): () => void {
  ensureStore() // arm the file monitor even for a host that only listens
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * ONE HOST WINDOW's show/hide switch.
 *
 * The stored `enabled` value is the LAST APPLIED setting, not a live broadcast:
 * a new window starts from it, and a flip is written back to it, but a flip in
 * one window never moves another window's pane. Two open browsers (or a browser
 * and an open dialog) each keep their own switch — the store is only what the
 * NEXT window reads. `mode` and `width` stay shared: the divider's drag writes
 * the one side-slot width every host uses.
 *
 * The subscription covers the window's own flip AND every store change, so a
 * host re-applies its layout (mode, width) from the same callback and its
 * visibility from `enabled()`. The host drops the session with its window.
 */
export interface PreviewSession {
  /** THIS window's switch. */
  enabled(): boolean
  /** Set THIS window's switch. `remember` (default) also stores it as the last
   *  applied setting a NEW window starts from — false for a close the window's
   *  own size forced, which is not the user's choice (`common/media/divider`). */
  setEnabled(enabled: boolean, remember?: boolean): void
  /** Flip THIS window's switch. */
  toggle(): void
  /** Subscribe to this window's flips and to store changes. Returns the
   *  unsubscribe function. */
  subscribe(cb: () => void): () => void
  /** Drop the subscriptions — the window is going away. Idempotent. */
  dispose(): void
}

/** Create the preview switch for one host window, seeded from the stored
 *  last-applied value. */
export function createPreviewSession(): PreviewSession {
  let enabled = previewEnabled()
  const sessionListeners = new Set<() => void>()

  function notify(): void {
    for (const cb of [...sessionListeners]) cb()
  }

  function setEnabled(next: boolean, remember = true): void {
    if (next === enabled) return
    enabled = next
    notify()
    // The store write is the memory for the NEXT window, not a broadcast: the
    // other windows' sessions keep the switch they already hold.
    if (remember) setPreviewEnabled(next)
  }

  const offStore = onPreviewChanged(notify)
  return {
    enabled: () => enabled,
    setEnabled,
    toggle: () => setEnabled(!enabled),
    subscribe(cb: () => void): () => void {
      sessionListeners.add(cb)
      return () => {
        sessionListeners.delete(cb)
      }
    },
    dispose(): void {
      offStore()
      sessionListeners.clear()
    },
  }
}
