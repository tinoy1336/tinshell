/**
 * common/applets/render-state.ts — the per-applet render state.
 *
 * ONE plain object per applet binding, owned by the binding (`AppletWindow.render`)
 * and handed to every writer of a frame's render values: the applet core (pointer
 * position), the appear animation (whole-composition alpha), the open panel
 * (value / ring fill / disc skip / step-quantized text) and the dock row
 * (attention pulse). The icon's draw trampoline reads it.
 *
 * Fields are left `undefined` while unset, so each reader's `?? fallback` keeps
 * its own resting value (the icon is at steady-state intro 1 with no panel
 * value, ring fill 1, its own disc painted, text from the value).
 */

/** The pointer position last reported over the applet's window, plus the
 *  over/out latch (`over` = 0 after a leave). Consumed by the panel's debug
 *  trace only. */
interface RenderCursor {
  x: number
  y: number
  over: number
}

export interface RenderState {
  /** Appear progress 0..1. 1 = steady state (no cairo group, no extra paint). */
  intro: number
  /** Panel-driven value while a panel animates (continuous applets). */
  value?: number
  /** Panel-driven accent-ring fill 0..1 while a panel animates. */
  ringFill?: number
  /** While true the icon skips its own disc — the open pill paints it once. */
  skipDisc?: boolean
  /** Step-quantized value for % text while the slider glides on the float. */
  textValue?: number
  /** Recording blink pulse 0..1, driven by the dock row's attention tick. */
  attention: number
  /** Last pointer position over the window. */
  cursor?: RenderCursor
}

/** Create the state for one applet binding. `intro` is the binding's seed: 0
 *  when the host plays a birth appear, 1 for a steady-state host. */
export function createRenderState(intro: number): RenderState {
  return { intro, attention: 0 }
}
