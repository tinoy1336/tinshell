/**
 * media active-instance registry — which playback pipeline the transport
 * commands and MPRIS reflect.
 *
 * The media app is multi-instance (one window per media output), so "the
 * current media" is a selection policy owned HERE, not by the shared playback
 * layer: window.tsx points it at the most-recently-playing else last-focused
 * TRANSPORT surface. The surface registry keeps the pointer coherent — when
 * the last transport surface closes or switches to the still viewer it points
 * the registry at null, and a closed surface is never active.
 */

import { log } from "@common/log/logger"
import type { MediaPipeline } from "@common/media/types"

let active: MediaPipeline | null = null
const activeSubs: Array<(i: MediaPipeline | null) => void> = []

/** Point the transport commands / MPRIS at the active media window. */
export function setActiveInstance(i: MediaPipeline | null): void {
  if (i === active) return
  active = i
  for (const s of [...activeSubs]) {
    try {
      s(i)
    } catch (e) {
      log(`active-instance listener failed: ${(e as Error).message}`)
    }
  }
}

export function getActiveInstance(): MediaPipeline | null {
  return active
}

/** Subscribe to active-instance changes (MPRIS resubscribes on switch). */
export function onActiveChange(cb: (i: MediaPipeline | null) => void): () => void {
  activeSubs.push(cb)
  return () => {
    const idx = activeSubs.indexOf(cb)
    if (idx >= 0) activeSubs.splice(idx, 1)
  }
}
