/**
 * common/media/classify.ts — the ONE media-kind predicate: which kind of media
 * a path names, by extension.
 *
 * The image set is a contract about what actually renders, not a guess: every
 * image extension below was verified by decoding a real file of that format
 * through `Gdk.Texture.new_from_filename` on this machine (PNG, JPEG, GIF,
 * BMP, WebP, TIFF, ICO, HEIC, AVIF, JXL, SVG — all thirteen returned a
 * texture). A format whose loader is absent must NOT be listed: a consumer
 * would route the user into a decoder error instead of a fallback.
 *
 * Extension parsing: the text after the LAST dot, lowercased, with the dot
 * index required to be > 0 (a dotfile such as `.bashrc` has no extension). No
 * content sniffing — a mis-named file reports its extension's kind.
 */
import type { MediaKind } from "./types"

/** Extension → kind. Still images on top, then the motion-capable image
 *  formats whose first frame a still consumer renders, then the streams. */
const KIND_BY_EXT: Record<string, MediaKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  bmp: "image",
  svg: "image",
  tif: "image",
  tiff: "image",
  ico: "image",
  heic: "image",
  avif: "image",
  jxl: "image",
  gif: "animated-image",
  webp: "animated-image",
  mp3: "audio",
  flac: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  opus: "audio",
  mp4: "video",
  mkv: "video",
  webm: "video",
  avi: "video",
  mov: "video",
  m4v: "video",
  wmv: "video",
  flv: "video",
}

/** The kind of media `path` names (`other` for anything not in the table). */
export function mediaKind(path: string): MediaKind {
  const dot = path.lastIndexOf(".")
  if (dot <= 0) return "other"
  return KIND_BY_EXT[path.slice(dot + 1).toLowerCase()] ?? "other"
}

/** Does `path` name an image a still consumer can render? An animated image
 *  counts — a still consumer renders its first frame. */
export function isStillImage(path: string): boolean {
  const kind = mediaKind(path)
  return kind === "image" || kind === "animated-image"
}
