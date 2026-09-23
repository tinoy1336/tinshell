/**
 * Find the window that is actually playing media, for the media applet's
 * "Goto player" step. Inputs: the raw `hyprctl -j clients` JSON plus the
 * the mpris domain's published snapshot (player/title/artist) of the current
 *
 * Matching, in order:
 *  1. TITLE — the window whose title contains the current track title (or
 *     artist). Picks the exact playing tab/window even among many browser
 *     windows. Guarded by a min length so short titles can't false-match
 *     (e.g. a track literally named "New").
 *  2. CLASS — the player name's known window classes (Electron apps register
 *     MPRIS as `org.mpris.MediaPlayer2.chromium`, so the class map covers
 *     e.g. "YouTube Music Desktop App" for player "chromium").
 * Returns the window's workspace id + address for the hyprctl dispatches, or
 * null when nothing matches (headless players, unlisted windows).
 */

import { ignore } from "@common/log/logger"

const CLASS_MAP: Record<string, string[]> = {
  chromium: ["chromium", "youtube music desktop", "ytmdesktop"],
  firefox: ["firefox"],
  spotify: ["spotify"],
  mpv: ["mpv"],
  discord: ["discord"],
  vlc: ["vlc"],
}

export interface MediaWindow {
  ws: number
  addr: string
}

export function findMediaWindow(
  clientsJson: string,
  player: string,
  title: string,
  artist: string,
): MediaWindow | null {
  let clients: any[] = []
  try {
    clients = JSON.parse(clientsJson)
  } catch (e) {
    ignore("hyprctl clients parse", e)
    return null
  }

  const t = (title || "").trim().toLowerCase()
  const a = (artist || "").trim().toLowerCase()

  if (t.length >= 4) {
    for (const c of clients) {
      const ct = (c.title || "").toLowerCase()
      if (ct.includes(t)) return { ws: c.workspace?.id, addr: c.address }
    }
  }
  if (a.length >= 4) {
    for (const c of clients) {
      const ct = (c.title || "").toLowerCase()
      if (ct.includes(a)) return { ws: c.workspace?.id, addr: c.address }
    }
  }

  const base = (player || "").split(".")[0].toLowerCase()
  const classes = CLASS_MAP[base]
  if (classes) {
    for (const c of clients) {
      const cl = (c.class || "").toLowerCase()
      if (classes.some((k) => cl.includes(k))) return { ws: c.workspace?.id, addr: c.address }
    }
  }
  return null
}
