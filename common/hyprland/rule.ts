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

/** A command the compositor runs at session start.
 *
 *  WHY it is declared here and not written into a fragment as a plain call: the
 *  config mounts the rule directory with a PARSE-TIME `pcall(require, …)`, so a
 *  bare `hl.exec_cmd` at a fragment's top level would run while the config is
 *  being read, not at login. A start hook fires after parse, and a required
 *  fragment runs in the same Lua global state as the config, so the fragment can
 *  register one — and the generator emits it that way. */
export type StartEntry = {
  /** The command line, verbatim: `hl.exec_cmd` runs it through `sh -c`, so an
   *  argument carrying a space needs its own quoting. */
  cmd: string
  /** Why this owner starts this at session start; emitted as a comment above the
   *  command, so the fragment carries the reason for its own line. */
  note?: string
}

/** Why a start command is registered on a hook instead of emitted as a plain
 *  call.
 *
 *  Stated once here, beside the entry type it constrains, and emitted by the
 *  rule generator above the registration: the constraint belongs to the
 *  mechanism, not to an owner — every start command in every fragment carries
 *  it, so no owner can be the one that states it. */
export const START_HOOK_REASON =
  "The rule directory is mounted with a parse-time require, so a command run at a fragment's top level would run while the config is being read instead of at login; the hook below fires after parse, and a required fragment registers it in the same Lua global state the config uses."

/** A keybind the owner of a surface declares beside that surface.
 *
 *  `keys` is the key string `hl.bind` takes VERBATIM (`"SUPER + Space"`): the data
 *  spells the modifier itself, so no fragment needs a shared `mod` local and no
 *  translation grammar sits between this field and the emitted call.
 *
 *  Exactly ONE of `cmd` / `dispatch` is set. `cmd` is a shell command line whose
 *  command word is a path relative to the tree root — keybind exec has no
 *  `~/.local/bin` in PATH, so the fragment prefixes the root it derives from
 *  `$HOME` at config load. `dispatch` is a compositor dispatcher the data
 *  declares directly (a workspace key whose number the surface's own step count
 *  dictates). */
export type BindEntry = {
  keys: string
  cmd?: string
  dispatch?: { kind: "focus" | "move"; workspace: number }
  opts?: { locked?: boolean; repeating?: boolean; mouse?: boolean }
  /** Why this key runs this command; emitted as a comment above the call. */
  note?: string
}

/** Why a bind's position in the rendered tree does not decide its behaviour.
 *
 *  Stated once here, beside the entry type it constrains, and emitted by the
 *  rule generator in every bind-carrying fragment: the constraint belongs to the
 *  mechanism, not to an owner — Hyprland keys a bind by (modmask, key) rather
 *  than matching the declarations in order, so the only order-sensitive case is
 *  one key declared twice, which the generator rejects outright. */
export const BIND_POSITION_REASON =
  "A keybind is keyed by (modmask, key) rather than matched in order, so a bind's position does not decide which command its key runs, and one fragment may carry binds beside its rules. The only order-sensitive case is the SAME key declared twice — a later registration would silently win — which `npm run check:hypr-rules` rejects."

/** The rules one owner contributes — one owner is one generated file. `owner`
 *  names the file (`<order>-<owner>.lua`) and the surface the rules describe;
 *  `identityModule` names where that surface's Wayland identity names live, and
 *  is printed in the generated header so a reader can find them; an owner that
 *  matches no name contributes no rule and needs none (the shell's own start
 *  hook, say).
 *
 *  `start` holds commands the compositor runs at session start — a fragment
 *  carries more than rules, and a start command is registered on the start hook
 *  rather than run at the fragment's top level (see `StartEntry`).
 *
 *  `bind` holds the keys that summon or control this owner's surface: the key is
 *  registered by `hl.bind` at the fragment's top level, which IS parse-time
 *  registration — the same call the config made inline — so a bind needs no hook
 *  and no position of its own (see `BindEntry`).
 *
 *  `note` is a reason for the SHAPE of this rule set — why positions are pinned
 *  by a rule at all, say — written as technical fact and emitted as a comment
 *  above the rules, so the fragment explains its own shape to whoever reads the
 *  compositor config. A reason that belongs to one key rather than to this owner
 *  goes on the key's declaration instead (see `DECORATION_REASSERTION_REASON`). */
export type HyprRuleSet = {
  owner: string
  identityModule?: string
  note?: string
  layer?: LayerRuleSpec[]
  window?: WindowRuleSpec[]
  /** Keybinds that summon or control this owner's surface, in the order
   *  declared. */
  bind?: BindEntry[]
  /** Commands the compositor runs at session start, in the order declared. */
  start?: StartEntry[]
}

/** The `class` match for a window rule that selects one app's toplevels: the
 *  app's Wayland app_id, regex-escaped and anchored. Escaping matters — an
 *  app_id like `io.Astal.notes` carries dots, and Hyprland reads an unescaped
 *  dot as "any character". */
export function appIdPattern(appId: string): string {
  return `^(${appId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})$`
}
