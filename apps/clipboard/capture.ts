/**
 * Probes are ASYNC + bounded by `timeout 1` — a sync `wl-paste` on the main
 * loop BLOCKS on an empty
 * selection → the shell froze (a 420s hang). Async communicates keep
 * the main loop free; the timeout kills a blocked wl-paste so a probe can
 * never pend forever. A busy-flag drops overlapping probes (watch lines can
 * fire faster than a 2s probe chain).
 */
import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { get as getConfig } from "./config"
import { log } from "./log"
import { append, contentHash, deleteImage, gcImages, newId, saveImage } from "./store"
import { ensureThumb } from "./thumbs"

let clip: Gdk.Clipboard | null = null
let running = false
let lastOwnAt = 0
let lastOwnFingerprint: string | null = null
let lastEvent: { at: number; kind: string; note?: string } | null = null

let watchStream: Gio.DataInputStream | null = null
let respawnTimer = 0
let probeBusy = false

/** Capture-loop state, for `clipboard debug`. */
export function captureState(): string {
  return JSON.stringify({
    running,
    lastEvent: lastEvent ? { ...lastEvent, at: new Date(lastEvent.at / 1000).toISOString() } : null,
    lastOwnAgoMs: lastOwnAt > 0 ? Math.round((GLib.get_monotonic_time() - lastOwnAt) / 1000) : null,
    hasFingerprint: lastOwnFingerprint !== null,
    persistImages: getConfig("persistImages", true),
    maxEntries: getConfig("maxEntries", 100),
  })
}

/** Re-claim text: registers text/plain + utf-8 (common/clipboard.ts
 *  precedent). new_for_value is the path that works — new_for_bytes needs
 *  (mime, bytes) and a bare byte array breaks text/plain paste. */
function reclaimText(text: string): void {
  try {
    const provider = Gdk.ContentProvider.new_for_value(text)
    clip?.set_content(provider)
  } catch (e) {
    log(`re-claim text failed: ${(e as Error).message}`)
  }
}

/** Re-claim an image from its saved PNG bytes (new_for_texture does NOT
 *  exist in the installed GDK — its constructors are new_for_bytes +
 *  new_for_value only). */
function reclaimImage(pngBytes: Uint8Array): void {
  try {
    const provider = Gdk.ContentProvider.new_for_bytes("image/png", pngBytes)
    clip?.set_content(provider)
  } catch (e) {
    log(`re-claim image failed: ${(e as Error).message}`)
  }
}

/** Probe + persist the current selection. Called once per watch line
 *  (i.e. once per selection change). Text first (common case), then image.
 *  Async chain — probeText → probeImage → done; busy-flag drops overlap. */
function handleProbe(): void {
  if (!running || probeBusy) return
  probeBusy = true
  probeText()
}

function probeText(): void {
  const now = GLib.get_monotonic_time()
  let sub: Gio.Subprocess
  try {
    sub = Gio.Subprocess.new(
      ["timeout", "1", "wl-paste"],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    )
  } catch {
    probeBusy = false
    return
  }
  sub.communicate_utf8_async(null, null, (_s: unknown, res: any) => {
    // wl-paste appends ONE trailing newline; strip it so the stored text
    // matches what the source actually offered.
    let text: string | null = null
    try {
      const [ok, out] = sub.communicate_utf8_finish(res)
      if (ok && sub.get_exit_status() === 0 && out) {
        const trimmed = out.replace(/\n$/, "")
        if (trimmed.trim()) text = trimmed
      }
    } catch {
      text = null
    }

    if (text !== null) {
      const hash = contentHash(text)
      if (hash === lastOwnFingerprint) {
        lastEvent = { at: now, kind: "echo", note: "own re-claim" }
        probeBusy = false
        return
      }
      // Timestamp backstop (fingerprint-first, backstop only):
      // an echo the compositor mangled past md5 equality still lands inside
      // 500ms of our re-claim. Known tradeoff: a real user copy within the
      // window is skipped (Klipper-style consecutive-identical dedupe).
      if (now - lastOwnAt < 500_000) {
        lastEvent = { at: now, kind: "echo", note: "timestamp backstop" }
        probeBusy = false
        return
      }
      // Guard BEFORE set_content — the echo must not re-append.
      lastOwnAt = now
      lastOwnFingerprint = hash
      const id = newId()
      // A re-copy of a content already in history moves that row to the front
      // instead of adding a second copy (store.append's exact-hash rule).
      const stored = append({ id, ts: Date.now(), mime: "text", text, hash })
      reclaimText(text)
      lastEvent = {
        at: now,
        kind: stored.deduped ? "text-dup" : "text",
        note: text.slice(0, 40),
      }
      probeBusy = false
      return
    }

    probeImage()
  })
}

function probeImage(): void {
  const now = GLib.get_monotonic_time()
  if (!getConfig("persistImages", true)) {
    lastEvent = { at: now, kind: "skipped", note: "persistImages=false" }
    probeBusy = false
    return
  }
  let sub: Gio.Subprocess
  try {
    sub = Gio.Subprocess.new(
      ["timeout", "1", "wl-paste", "--type", "image/png"],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    )
  } catch {
    probeBusy = false
    return
  }
  sub.communicate_async(null, null, (_s2: unknown, res2: any) => {
    let pngBytes: Uint8Array | null = null
    try {
      const [ok, outBytes] = sub.communicate_finish(res2)
      if (ok && sub.get_exit_status() === 0 && outBytes && outBytes.get_size() > 0) {
        const raw = outBytes.get_data()
        if (raw) {
          // get_data may return a view larger than the bytes object — slice
          // to the exact size so saveImage/reclaimImage never write padding.
          pngBytes = raw.length === outBytes.get_size() ? raw : raw.subarray(0, outBytes.get_size())
        }
      }
    } catch {
      pngBytes = null
    }
    probeBusy = false

    if (pngBytes) {
      const hash = contentHash(pngBytes)
      if (hash === lastOwnFingerprint) {
        lastEvent = { at: now, kind: "echo", note: "own re-claim (image)" }
        return
      }
      if (now - lastOwnAt < 500_000) {
        lastEvent = {
          at: now,
          kind: "echo",
          note: "timestamp backstop (image)",
        }
        return
      }
      lastOwnAt = now
      lastOwnFingerprint = hash
      const id = newId()
      // saveImage ensures img/ exists (store's mkdir_with_parents) — the
      // first image capture must not fail on a missing dir.
      if (!saveImage(id, pngBytes)) {
        lastEvent = { at: now, kind: "error", note: "saveImage" }
        return
      }
      const stored = append({
        id,
        ts: Date.now(),
        mime: "image",
        imagePath: `img/${id}.png`,
        hash,
      })
      if (!stored.ok) {
        deleteImage(id) // JSONL is the source of truth — no entry, no file
        lastEvent = { at: now, kind: "error", note: "store append failed" }
        return
      }
      // Build the picker's thumbnail here, off the open path: the picker would
      // otherwise decode this full PNG every time it is shown. On a duplicate
      // this is the surviving row's id — its thumbnail is already there, and a
      // row that somehow has none gets it now.
      ensureThumb(stored.id)
      reclaimImage(pngBytes)
      lastEvent = {
        at: now,
        kind: stored.deduped ? "image-dup" : "image",
        note: stored.id,
      }
      return
    }

    lastEvent = { at: now, kind: "skipped", note: "unsupported mime" }
  })
}

/** Read stdout lines from the watcher — one line per selection change. */
function pump(): void {
  if (!watchStream) return
  watchStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s: unknown, res: any) => {
    try {
      const [line] = watchStream!.read_line_finish(res)
      if (line) {
        void handleProbe()
        pump()
      } else {
        // EOF — the watcher died (wl-paste exited / compositor gone).
        watchStream = null
        scheduleRespawn()
      }
    } catch (e) {
      log(`clipboard watch read failed: ${(e as Error).message}`)
      watchStream = null
      scheduleRespawn()
    }
  })
}

function scheduleRespawn(): void {
  if (!running || respawnTimer) return
  respawnTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    respawnTimer = 0
    if (running) spawnWatcher()
    return GLib.SOURCE_REMOVE
  })
}

function spawnWatcher(): void {
  try {
    const sub = Gio.Subprocess.new(
      ["wl-paste", "--watch", "sh", "-c", "echo changed"],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    )
    const pipe = sub.get_stdout_pipe()
    if (!pipe) {
      log("clipboard watcher: no stdout pipe")
      scheduleRespawn()
      return
    }
    watchStream = new Gio.DataInputStream({ base_stream: pipe })
    pump()
  } catch (e) {
    log(`clipboard watcher spawn failed: ${(e as Error).message}`)
    scheduleRespawn()
  }
}

/** Start the resident capture loop. Idempotent; no-op when already running. */
export function startCapture(): void {
  if (running) return
  const display = Gdk.Display.get_default()
  if (!display) {
    log("startCapture: no display")
    return
  }
  clip = display.get_clipboard()
  const removed = gcImages()
  if (removed > 0) log(`gcImages removed ${removed} orphan(s)`)
  running = true
  lastEvent = { at: GLib.get_monotonic_time(), kind: "started" }
  spawnWatcher()
  log("capture started (wl-paste --watch)")
}
