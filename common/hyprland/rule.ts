/**
 * common/hyprland/rule.ts — the TS model of a compositor rule.
 *
 * The build renders these definitions into Lua fragments under
 * `~/.config/hypr/rules/` (`scripts/gen-hypr-rules.ts`, npm `gen:hypr-rules`);
 * the config requires that directory with a wildcard. A definition names the
 * surface it describes through that surface's own identity constant
 * (`apps/<app>/identity.ts`), never through a repeated literal, so renaming a
 * namespace or an app_id cannot leave a stale rule behind.
 *
 * Every field is the same key of the Lua rule spec — `hl.window_rule` /
 * `hl.layer_rule`, reference `/usr/share/hypr/stubs/hl.meta.lua`
 * (`HL.WindowRuleSpec` / `HL.LayerRuleSpec`) — so a rendered fragment and a
 * hand-written rule have identical semantics and a reader can diff them.
 *
 * `match` values are REGULAR EXPRESSIONS to Hyprland (not globs or literals):
 * `class`/`title`/`namespace` are matched with `regex_search`, so a surface
 * family is selected by its prefix (`dock-.*`) and an app_id has to have its
 * dots escaped (`appIdPattern`).
 *
 * A rule definition is loaded by a plain-Node script, so it imports its identity
 * module and this one with an explicit `.ts` path — the same constraint the
 * schema sources under `apps/<app>/` carry for the schema generator, which has
 * no tsconfig-paths mapping and no extensionless resolution.
 */

/** A layer-shell rule. `match.namespace` selects the layer surface: the
 *  namespace the surface itself passed to layer-shell. */
export type LayerRuleSpec = {
  match: { namespace: string }
  blur?: boolean
  ignore_alpha?: number
  no_anim?: boolean
}

/** The map size a window rule pins, read from the app's OWN config when the
 *  compositor loads the fragment.
 *
 *  WHY it is not a number here: the rule applies at map time, and a fresh float
 *  whose first commit loses the startup race is given Hyprland's half-monitor
 *  default configure — GTK4 obeys that nonzero configure and an XDG window has
 *  no post-map resize API, so the rule's size and the app's configured size
 *  must come from one value. `fallback` is the app's shipped default, used
 *  while its live config file does not exist yet. */
export type ConfigMapSize = {
  app: string
  fallback: { width: number; height: number }
}

/** A toplevel rule. `name` is required: Hyprland merges a re-declared name
 *  instead of adding a second rule, and the per-open rules a card app registers
 *  from its own window code are named into the same space. */
export type WindowRuleSpec = {
  name: string
  match: { class?: string; title?: string }
  float?: boolean
  rounding?: number
  size?: ConfigMapSize
  decorate?: boolean
  border_size?: number
  move?: { x: number; y: number }
}

/** Why a rule that rounds a float also sets `decorate` and `border_size`.
 *
 *  Stated once here, beside the two keys it constrains, and emitted by the rule
 *  generator above every rule that sets them: the constraint belongs to the KEY,
 *  not to an app — the session's smart-gaps workspace rule affects every floating
 *  window in the same way, so no owner can set these keys for a different reason,
 *  and a copy per rule set would only be a place to drift. */
export const DECORATION_REASSERTION_REASON =
  "The smart-gaps workspace rule (w[tv1]: zero gaps and no decorations while a single tiled window is visible) sets no_border and decorate = false, which would strip a floating window's border and frame on such a workspace; decorate and border_size re-assert them for this window. rounding re-asserts the corner radius against the same rule's no_rounding."

/** The rules one owner contributes — one owner is one generated file. `owner`
 *  names the file (`<order>-<owner>.lua`) and the surface the rules describe;
 *  `identityModule` names where that surface's Wayland identity names live, and
 *  is printed in the generated header so a reader can find them.
 *
 *  `note` is a reason for the SHAPE of this rule set — why positions are pinned
 *  by a rule at all, say — written as technical fact and emitted as a comment
 *  above the rules, so the fragment explains its own shape to whoever reads the
 *  compositor config. A reason that belongs to one key rather than to this owner
 *  goes on the key's declaration instead (see `DECORATION_REASSERTION_REASON`). */
export type HyprRuleSet = {
  owner: string
  identityModule: string
  note?: string
  layer?: LayerRuleSpec[]
  window?: WindowRuleSpec[]
}

/** The `class` match for a window rule that selects one app's toplevels: the
 *  app's Wayland app_id, regex-escaped and anchored. Escaping matters — an
 *  app_id like `io.Astal.notes` carries dots, and Hyprland reads an unescaped
 *  dot as "any character". */
export function appIdPattern(appId: string): string {
  return `^(${appId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})$`
}
