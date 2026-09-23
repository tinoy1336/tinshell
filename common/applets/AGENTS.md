# AGENTS.md — the applet machinery

The shared applet substrate: the applets themselves, the binding they are
mounted on, the shared row renderer, and the OS-domain contract behind them.
**READ the root `~/dev/tinshell/AGENTS.md` FIRST** (launch path, addressing,
`common/` rules); this file is the applet-specific spec.

Everything here is host-agnostic. Two hosts mount it — the dock's layer-shell
band (`apps/dock`) and the greeter strip (`apps/greeter/strip`) — and they
differ only in their SUBSTRATE port (`common/applets/surface/host.ts`), never
in the applets, the binding or the renderer. Per-app code (a slider's UI, an
applet's GUI, its request surface) stays in `common/applets/<key>/`.

## Layout

| Path | What it owns |
| --- | --- |
| `types.ts` | the applet contract: `AppletContext` (`port`, `hooks`, `config`, `store`, `backend`), `AppletMount`, `DrawIcon`, `Panel` / `PanelHandle`, `Dial`, the TLP/power unions |
| `applet-window.ts` | the binding the applets see (`AppletWindow`, `AppletRowLike`, `AppletGeometry`) and the substrate-independent state machine (`createAppletBinding`) |
| `surface/` | the shared ROW renderer: `surface.ts` (entry table, band engine, backdrop, input region, geometric router), `host.ts` (the substrate port), `applet.ts` (`createSurfaceApplet` — the ONE per-applet binding factory) |
| `shared/` | the drawing + lifecycle machinery below |
| `utils/` | UI-only helpers: `row-region` (capture-region owner), `appear` (birth/intro), `smoother` (value easing), `drag` (dial accumulator), `reactive`, `geo-log` |
| `domains/` | one module per OS domain — the implementations the `AppletBackend` contract names (`battery`, `wifi`, `bluetooth`, `volume`, `power`, …). Bound in process by the dock and by the pre-login greeter; every other host proxies them (`backend-client`) |
| `config.ts` / `config.schema.ts` | the applet-facing config contract + the schema slice the owning app composes (the dock's `config.schema.ts` composes this file, so the dock keeps owning the generated artifact) |
| `backend.ts` | the `AppletBackend` type — one domain namespace per service |
| `panel-framework.tsx`, `panel-hub.ts`, `backdrop.ts`, `layout.ts`, `tablet-panel-close.ts`, `hooks.ts`, `render-state.ts` | the panel machinery, the single-open hub, the backdrop painter, dock geometry, the host-owned tablet auto-close, the host-policy hooks, the render state |
| `host/`, `*-protocol.ts`, `backend-client.ts` | the hostable applets backend (dock) and the transports a host that does not own it uses |

## An applet

`common/applets/<key>/index.ts` default-exports ONE mount function —
`export default function mount(ctx: AppletContext): void` (`AppletMount`) —
named after the operation, aliased by each host where it needs the
distinction (`import mountBattery from "@common/applets/battery"`). Every piece
of per-instance state lives in the closure `mount` creates, so one module
serves the dock and the greeter independently. A directory may hold the
applet's own modules beside `index.ts` (`menu.tsx` for its GUI, `commands.ts`
for its request surface, `<module>.probe.ts` for a probe).

Most applets are built from a factory rather than the core directly:

- `createContinuousApplet(aw, opts)` — a slider applet (volume, brightness,
  battery, workspaces): an open panel drives the icon's value through the
  render state, the closed icon reads a smoothed `ringValue`.
- `createStepApplet(aw, opts)` — a step-selector applet (wifi, bluetooth,
  power, performance, lockSession, screengrab, media).

Both are thin wrappers over `shared/create-applet-core.ts`, which owns the
hover open / grace close / reopen-in-place machine, the icon ↔ panel
reparenting, the single-open hub, the escape bail and the icon's draw.

**The applet's draw IS the frame.** Every applet composes its icon from the
shared Cairo primitives in `shared/draw-utils.ts` — `drawDisc`, `drawRings`,
`drawOverlapRings`, `drawGlyph` — plus the geometry/colour helpers they share
(`clamp01`, `layoutBox`, `compensatedAlpha`, `effectiveDiscAlpha`), all resolved
from the applet's own config. Raw cairo is fine beside them: paths, clips and a
`translate`/`rotate` context paint exactly where the applet sets them, and every
`cr.save()` has its `cr.restore()`. Measuring (`cr.textExtents` before a text
run) paints nothing.

## The icon's draw path

`shared/create-applet-core.ts` installs the icon's draw function. It reads the
applet's `render` state (`render-state.ts` — unset fields stay `undefined` so
each reader's `?? fallback` keeps its own resting value: `intro`, `value`,
`ringFill`, `skipDisc`, `textValue`, `attention`, `cursor`), resolves the draw
arguments (the panel value while a panel is open, otherwise the smoothed
`ringValue` for a continuous applet or 0 for a step applet) and paints the
applet's `drawIcon` straight into the frame — the applet reads live domain
state, so the frame it draws IS the state on screen.

The birthday intro (`utils/appear.ts`, `timing.appearAnim` / `appearOutAnim`)
is an alpha on the WHOLE composition: while `render.intro < 1` the core draws
into a cairo group (`pushGroup` → `drawIcon` → `popGroupToSource` →
`paintWithAlpha(intro)`, disc/rings/glyph/text uniformly, no radial sweep), and
at 1 it paints without the group (zero overhead). The 9th `DrawIcon` parameter
is passed 1 so the applets' per-glyph intro multiplication does not double-fade,
and `playAppear` retracts from wherever the intro currently is.

An applet that owns a drawing area OUTSIDE the core (volume's no-session
disabled disc) applies that same group alpha itself.

## Element fades

An applet DECLARES which of its elements may cross-fade, and nothing else in
the applet fades. The declaration is one call,
`createElementFade(port, config, "<element>")` (`shared/element-fade.ts`), and
the element is then painted through the returned fade from inside the applet's
draw:

    glyphFade.paint(pickIcon(status, config), (glyph, alpha) => drawGlyph(…, alpha))

The transition animates the element's OWN INPUTS: while it runs the painter is
called twice inside the SAME ordinary paint — the outgoing state at alpha
(1 − eased t), then the incoming state at eased t — so a frame carries moving
values instead of a replayed recording of an earlier one. Settled (and with
`timing.fadeAnim` 0) the painter is called once at alpha 1. Everything else in
the applet paints once per frame at full opacity.

Which changes fade is the declaration, and the third `paint` argument is its
granularity: a transition runs only when the element's painted state AND its
`id` both move, so an element whose painted value is also driven by an input
that must not fade passes that input as `id` and adopts that move at once
instead of starting a transition. A declaration that passes none fades on the
value it paints, so every change of that value cross-fades.

A move the declaration does NOT fade is adopted WITHOUT ending a transition
that is already running: the transition animates the identity change, and the
move only decides what its incoming side paints. The dock's charge run is the
case that needs it — its painted state carries the lit fraction as well as the
colour, and the lit fraction eases on its own, so a capacity step can land on
the frame after a colour change and would otherwise paint the new colour at
alpha 1 one frame into the fade.

| applet | declared element | fades when |
| --- | --- | --- |
| battery | `ring` | the ring arc's painted colour changes, whatever caused it — a level crossing (`ok`/`warn`/`low`), charging starting or stopping, the charger being plugged or unplugged |
| volume | `ring`, `glyph` | the sink class's ring colour changes; the volume glyph changes |
| wifi | `glyph` | the signal-strength glyph changes |
| bluetooth | `glyph` | the adapter/pairing glyph changes |

Every other applet declares nothing, so a change on it (a brightness ring, the
performance temperature text, the overflow clock's own caret/clock transition)
paints at once, with no cross-fade frames at all — an animated READOUT's digits
move through their own value tick instead (see below).

`timing.fadeAnim` (ms, 0 = no transition) and `timing.fadeEasing` (`linear` |
`easeOut` | `easeInOut`) are read from the LIVE config at transition start. A
transition owns a frame source only between the change and t = 1
(`timing.framerate`); a settled element holds no frame source and does no
per-frame work. `fade status` is the side-effect-free probe listing every
declaration in the process with its transition, frame and paint counters.

## Animated readouts

A poll-driven NUMBER an applet paints — the performance applet's temperature
digits, the battery applet's wattage digits — is painted through a VALUE TICK
(`shared/value-tick.ts`), which walks it from the reading it was showing to the
new one frame by frame, so the digits count through the intermediate values
instead of snapping. ONE tick per readout, created in the applet's mount:

    const tempTick = createValueTick({
      source: temp, read: (v) => v ?? 0, widget: port.icon,
      config, deadband: 1, isVisible: visible,
    })

The applet paints `tempTick.peek()` with its own unit, precision and colour —
the tick formats nothing — and `dispose()`s it on unmount. Nothing else about
the readout changes.

The walk lasts `timing.tickAnim` ms (0 = the readout paints the new reading at
once, and no frame source is ever created) at `timing.framerate`, and it ends at
the reading by itself: a settled tick holds no frame source and does no
per-frame work. A walk starts only for a reading that moved by more than the
tick's own `deadband` (in the reading's unit — °C, W) AND while the applet
reports itself visible; the reading that starts the FIRST walk is ADOPTED rather
than walked (the tick holds no earlier reading to walk from), and a reading the
source reports as absent (`read` → null) neither animates nor moves the target.
The frames themselves come from the smoother (`utils/smoother`), which every
applet RING value still uses directly.

`value-tick.probe.ts` drives the tick with a stub widget and a stub poll — the
walk, the kick policy and the `tickAnim` 0 snap, with no display:
`ags bundle --gtk 4 common/applets/shared/value-tick.probe.ts /tmp/p.sh && bash /tmp/p.sh`.

## Row, panels, pointer

`surface/surface.ts` is the ONE row renderer: the entry table, the band engine
(`provisionSlot` eager-extend / `settle` lazy-shrink), the segmented backdrop
paint, the input region (compiled by `utils/row-region.ts` into BOTH the
wl_surface region and the router's point test) and the geometric pointer router
(enter/leave/motion/press by slot band, capture lock, open suppression after a
geometry commit, pending-enter promotion). Open panels are `Gtk.Overlay`s at the
applet's slot; the icon is reparented into the panel and returns on close.

## Backends and config

The applets never read a bound global: the host supplies `config` (its live
config view), `store` (the `AppletConfigSource` — the host's facade) and
`backend` (`AppletBackend`, one domain namespace per service; `volume` is the
one OPTIONAL domain, because it is session-bound). The dock BINDS the domains in
process and also hosts the request surface and the greeter's socket; any other
host reaches them through `backend-client`. Host policy (park/restore,
deactivate, attention) travels the other way through `hooks`.

The applet config roots are authored in `config.schema.ts` here and composed by
the owning app's schema (`apps/dock/config.schema.ts`), which stays the
generated artifact's source. This file reads no config of its own.
