/**
 * The volume colour policy — the ONE place that decides which entry of
 * `appearance.ringColours` a volume reading renders in.
 *
 * Two surfaces show the same reading in the same colour: this applet's level
 * ring and the overflow clock's transient readout (`apps/dock/Overflow.tsx`),
 * so the mapping lives in one function instead of being derived twice.
 *
 * The device CLASS comes from the volume domain
 * (`common/applets/domains/volume`, which reads the sink's PipeWire bus and
 * form factor); the colour mapping is config policy and lives here.
 */
import type { AppletConfig } from "@common/applets/config"
import type { SpeakerKind } from "@common/applets/domains/volume"

/** The colour for a sink of `kind`: its `ringColours.volumeByType` entry (an
 *  open record in the schema), else the base `ringColours.volume`. */
export function volumeRingColour(
  kind: SpeakerKind,
  config: AppletConfig,
): [number, number, number, number] {
  const colours = config.appearance.ringColours
  const byType = colours.volumeByType as Partial<
    Record<SpeakerKind, { rgb: number[]; alpha: number }>
  >
  const c = byType?.[kind] ?? colours.volume
  return [c.rgb[0], c.rgb[1], c.rgb[2], c.alpha]
}
