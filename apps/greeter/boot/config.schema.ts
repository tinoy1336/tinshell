/**
 * boot config schema — TypeBox source of truth for the pre-login splash.
 * Generated artifact: apps/greeter/boot/config.schema.json (scripts/gen-config-schemas.ts).
 *
 * These are BUILD-TIME values, not a running app's settings: tinshell-boot-refresh
 * reads config.defaults.json, paints the splash's images at these sizes and compiles
 * the program with the timings and positions below. Every tier is therefore "baked":
 * nothing here is read after the boot images are built, and changing one means
 * rebuilding them.
 *
 * Units are the ones each consumer already works in. Sizes the tool paints with
 * (mark.height, field.*, bullet.size) are PANEL pixels, because the boot image has no
 * image decoder and nothing is resampled at boot. Positions the program places
 * (mark.top, frame.left, frame.top) are REFERENCE pixels against a 1440-wide screen,
 * which the program converts to the live framebuffer.
 */
import { obj, type Static, Type } from "../../../common/config/schema-build.ts"

export const schema = obj({
  // The field fades in a tenth of the picture at a time: steps of stepMs each.
  fade: obj({
    steps: Type.Integer({ minimum: 1, maximum: 60 }),
    stepMs: Type.Integer({ minimum: 10, maximum: 500 }),
  }),
  // The mark the field is replaced by, and where both are drawn.
  mark: obj({
    top: Type.Integer({ minimum: 0, maximum: 4000 }),
    height: Type.Integer({ minimum: 8, maximum: 512 }),
  }),
  // The passphrase well, and one bullet per typed character.
  field: obj({
    width: Type.Integer({ minimum: 80, maximum: 2000 }),
    height: Type.Integer({ minimum: 8, maximum: 400 }),
    radius: Type.Integer({ minimum: 0, maximum: 200 }),
    edge: Type.Integer({ minimum: 0, maximum: 12 }),
  }),
  bullet: obj({
    size: Type.Integer({ minimum: 4, maximum: 64 }),
  }),
  // Where the firmware's own frame sits on the panel.
  frame: obj({
    left: Type.Integer({ minimum: 0, maximum: 8000 }),
    top: Type.Integer({ minimum: 0, maximum: 8000 }),
  }),
})

export type Config = Static<typeof schema>

/** x-tier placement. Everything here is settled when the boot images are built. */
export const tiers: Record<string, string> = {
  "": "baked",
}
