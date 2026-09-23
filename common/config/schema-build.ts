/**
 * Schema build adapter — thin TypeBox wrapper used ONLY by per-app
 * config.schema.ts source files and the schema generator. Never imported by
 * app runtime code (config.ts imports the derived type type-only), so
 * TypeBox stays a devDependency and never enters an ags bundle.
 *
 * Why wrapper helpers instead of raw TypeBox everywhere:
 *   - The TINSHELL loader (common/config/loader.ts) consumes a small draft-07-ish
 *     subset: type, enum, items, minItems/maxItems, properties,
 *     additionalProperties === false (a schema-valued additionalProperties is
 *     treated as "unknown keys allowed, unvalidated" — same as absent), the
 *     BOUNDS keywords minimum/maximum/minLength/maxLength (enforced by
 *     validate()), and the custom x-tier keyword read by tierOf(). TypeBox
 *     emits several standard keys that subset cannot read (required, anyOf,
 *     patternProperties) — those would silently change loader behaviour or
 *     bloat the emitted JSON, so the helpers emit only loader-readable forms
 *     and the generator prunes the rest.
 *   - enumOf(): TypeBox string-literal unions serialize as anyOf (unreadable
 *     by the loader); Type.Enum emits a plain `enum` array, which is what the
 *     loader reads. Static inference still gives the string-literal union.
 *   - mapOf(): TypeBox Type.Record serializes as patternProperties (unreadable
 *     by the loader, so the generator prunes it); the pruned node is an OPEN
 *     object — unknown keys allowed, unvalidated — which is all the loader
 *     needs for Record<string, T> colour/icon maps.
 *
 * IMPORTANT: these helpers return their TypeBox types UNANNOTATED — the
 * literal structure must flow through to `Static<typeof schema>` (a `: any`
 * annotation would collapse the derived config type to `unknown`).
 *
 * This module must stay Node-safe (no gi:// imports) — the generator runs it
 * under `node --experimental-strip-types`.
 */

import type { TSchema } from "typebox"
import { Type } from "typebox"

export type { Static } from "typebox"
export { Type }

/** Closed object — additionalProperties: false (the loader's "extra property
 *  not allowed" gate). This is the default shape for config groups. */
export function obj<P extends Record<string, TSchema>>(props: P) {
  return Type.Object(props, { additionalProperties: false })
}

/** Open object — unknown keys allowed (loader treats absent additionalProperties
 *  the same as non-false: allow, unvalidated). */
export function openObj<P extends Record<string, TSchema>>(props: P) {
  return Type.Object(props)
}

/** Map idiom — Record<string, T> for Static (index-signature access). TypeBox
 *  serializes Record as patternProperties, which the loader ignores (open,
 *  unvalidated); the generator prunes it. */
export function mapOf<T extends TSchema>(value: T) {
  return Type.Record(Type.String(), value)
}

/** A config array node. */
export function arr<I extends TSchema>(items: I, minItems?: number, maxItems?: number) {
  return Type.Array(items, {
    ...(minItems !== undefined ? { minItems } : {}),
    ...(maxItems !== undefined ? { maxItems } : {}),
  })
}

/** String-literal enum → loader-readable `enum` array (not anyOf), with the
 *  literal union preserved in Static via Type.Unsafe (Type.Enum's Static is
 *  not the literal union). */
export function enumOf<const V extends readonly string[]>(values: V) {
  return Type.Unsafe<V[number]>({
    type: "string",
    enum: [...values],
  } as any)
}
