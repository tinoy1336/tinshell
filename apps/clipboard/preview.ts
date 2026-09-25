/**
 * The picker's row preview action: one image entry shown in a media window.
 *
 * The route is media's SPAWNING verb (`new`), never the retargeting one
 * (`open`). `new` always builds another media window — its own GStreamer
 * pipeline, its own file — so a preview leaves every window already on screen
 * untouched. `open` focuses the most-recent media window and loads the file
 * into it, which makes a second preview replace the image the first one is
 * showing.
 *
 * The picker's effects arrive as a host rather than being reached for directly,
 * so the request this action sends is asserted without a window
 * (`preview.probe.ts`).
 */

import { ensureLoaded, isLazyApp, isLoaded } from "@common/app/lazy"

/** The picker callbacks this action needs. */
export interface PreviewHost {
  /** One request, to the in-process command registry. */
  dispatch(tokens: string[], onReply: (reply: string) => void): void
  /** The app's `[clipboard]`-tagged log. */
  log(message: string): void
  /** Dismiss the picker. */
  hide(): void
}

/** Tokens of one preview request: media's spawn verb plus the entry's absolute
 *  PNG path, the file the spawned window loads. */
export function previewTokens(path: string): string[] {
  return ["media", "new", path]
}

/** Show the still at `path` in a media window of its own, then dismiss the
 *  picker. In-process request path (no subprocess): this instance hosts the
 *  media app — eagerly when it is a set member, otherwise through the lazy
 *  loader — so the request goes through the same command registry every other
 *  handler in this app uses, with the lazy pre-step the dispatcher itself runs
 *  for a routed request (`ensureLoaded` before dispatch). Returns the tokens it
 *  sends (the lazy load may defer the send to a later tick). */
export function previewEntry(path: string, host: PreviewHost): string[] {
  const tokens = previewTokens(path)
  const onReply = (reply: string) => {
    if (reply !== "ok") host.log(`picker preview failed for ${path}: ${reply}`)
  }
  if (isLazyApp("media") && !isLoaded("media")) {
    ensureLoaded("media").then(
      () => host.dispatch(tokens, onReply),
      () => host.log("picker preview: media failed to load"),
    )
  } else {
    host.dispatch(tokens, onReply)
  }
  // Same dismissal an ordinary entry click performs (activateEntry hides
  // too): the preview opens onto the media window, which takes focus anyway
  // — the shared focus-loss dismiss would close the picker regardless.
  host.hide()
  return tokens
}
