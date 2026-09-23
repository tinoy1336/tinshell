import type { Dial, DialOpts } from "@common/applets/types"

/**
 * A 1-D drag accumulator for slider panels.
 *
 * Axis-aware: uses the dock's grow axis and direction so it works for all
 * 12 positions (vertical top/bottom and horizontal left/right). growAxis
 * determines which GestureDrag offset to track; growDir sets the sign.
 *
 * `update(offsetX, offsetY)` takes offsets relative to the drag start point
 * (exactly what Gtk.GestureDrag::drag-update delivers).
 */
export function createDial(opts: DialOpts): Dial {
  const growAxis = opts.growAxis ?? "y"
  const growDir = opts.growDir ?? -1
  const num = (v: any, dflt: number): number =>
    typeof v === "function" ? (v as () => number)() : (v ?? dflt)

  let active = false
  let anchor = 0
  let current = 0

  function selectFrom(growOff: number) {
    const min = num(opts.min, 0)
    const max = num(opts.max, 100)
    const pxPerUnit = num(opts.pxPerUnit, 2)
    // growDir * growOff / pxPerUnit:
    //   growDir=-1 (bottom/right): cursor toward origin (up/left) = value up
    //   growDir=+1 (top/left):   cursor away from origin (down/right) = value up
    const raw = anchor + (growDir * growOff) / pxPerUnit
    current = raw < min ? min : raw > max ? max : raw
    opts.onSelect?.(current)
  }

  return {
    begin() {
      const min = num(opts.min, 0)
      const max = num(opts.max, 100)
      active = true
      const start = opts.getStart()
      anchor = start < min ? min : start > max ? max : start
      current = anchor
    },
    update(offsetX, offsetY) {
      if (!active) return
      selectFrom(growAxis === "x" ? offsetX : offsetY)
    },
    end() {
      active = false
    },
  }
}
