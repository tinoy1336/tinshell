# AGENTS.md — dock

The dock surface: per-monitor launcher/status bars with applets and menus.
A REAL standalone app (bus `io.Astal.dock`).

**READ the root `~/dev/tinshell/AGENTS.md` FIRST** (multi-app rules: bus
naming, router, launch path, shell aggregation, common modules, onboarding).
This file is the app-specific spec; the root file is the cross-app contract.

## Identity

| | |
| --- | --- |
| Instance / bus | in shell: inside `shell` (`io.Astal.shell`); dev island: `dock` (`io.Astal.dock`) |
| Unit | none (dev island; production = `tinshell-shell.service`) |
| Window namespaces | `dock-pill` (ONE shared dock surface per monitor), `dock-menu`, `dock-menu-scrim`, `dock-corner` |
| Hyprland rules | blur `dock-.*` + `dock-pill` (`hl.layer_rule`, ignore_alpha 0.05) — the frosted-glass dock; rules in hyprland.lua |
| Router | `route-map.conf`: `dock=shell,dock` |
| Keybinds | none direct — the dock is always visible; applets summoned by click (no summon bind). The **Print** screen-capture bind routes IN via `tinshell-route` (`common/shell/ensure-screengrab.sh` → `dock screengrab capture still select`)

## Architecture — SINGLE SURFACE per monitor

The dock is ONE layer window per monitor (`DockSurface.tsx` — the dock's
substrate for the shared renderer — namespace/class `dock-pill`) hosting the
WHOLE row in a `Gtk.Fixed`: applet icons are DrawingAreas at slot positions,
open panels are `Gtk.Overlay`s at their applet's slot — 1 GL renderer + 1 blur
chain + 1 commit per frame. The RENDERER is shared code
(`common/applets/surface`: entry table, band engine, backdrop paint, input
region, geometric routing, panel placement) and the applet mounts live in
`common/applets/<key>/` and see an `AppletWindow` bound to that surface — the
dock and the greeter strip mount the SAME renderer and differ only in their
substrate (the layer-shell band here vs the greeter's embedded strip).

- **Geometry**: grow-axis WINDOW extent = `layout.pillHeight`, CONSTANT — the
  extra band hosts open panels (opening a panel never resizes the surface).
  The BACKDROP (a Cairo stadium DrawingArea, the fixed's FIRST child = bottom
  z-order, `appearance.backdrop` colours it) does NOT fill that band: it paints
  iconSize thick, flush at the icons' grow edge, its LENGTH tracked per frame
  from the live slot union (no separate tween, so the strip's edges move with
  the applets) so overflow open/close glides instead of
  snapping with the window resize. It ABSORBS mouse events across the whole
  band (row-region unions a band stadium — sized to the window's band, not
  the eased paint length); the extra pillHeight band above the icons stays
  click-through. Row-axis extent
  = the union band of the displayed applets, with an eager-extend /
  lazy-shrink policy: dock-row calls `surface.provisionSlot(name, target)`
  BEFORE animating a slide (one resize at animation start) and
  `surface.settle()` at every animation/session completion applies any pending
  shrink — never per frame (per-frame resize = compositor pointer re-eval =
  swallowed clicks). The row-axis margin (band start) animates with
  centre-aligned re-centres. In MOVE MODE the band is FROZEN
  (`collapseToSlot` sets it, `setBandFrozen(false)` on exit): the
  ghost-fading entries must not re-extend the band over the collapsed slot.
  Parked (`setHiddenState(true)`) icons LEAVE the Gtk.Fixed — a parked icon
  left in the fixed pins its minimum size and silently defeats every band
  shrink; they are re-put on unpark.
- **Input region / capture lock** (`@common/applets/utils/row-region.ts` — the ONE owner): the capture shapes in surface coordinates — chord discs (visible closed icons at their animated slots) + the open panel's latched stadium + the row band stadium (the backdrop's silhouette, gated on `host.captureBand`) — compiled into the rect union the WINDOW installs as its wl_surface input region AND into the point test the shared router applies to every enter/motion/press. Re-issued on actual geometry change (gated on a serialized spec); everything else is click-through. Every shape is built by row-region's own `bandCaptureShape` / `panelCaptureShape` and oriented through the geometry's axis pair (`CaptureAxes`: row/grow → the real surface x/y), because a stadium that reads its long axis from a hard-coded orientation lays a left/right dock's bar and panels across the wrong axis and un-captures the very pixels it was built for (a rotation that is invisible on a top/bottom dock, where both axes coincide) — `row-region.probe.ts` asserts the compiled box of both shapes at all 12 positions. The router's half of that compilation is what makes the capture model substrate-independent: the dock's layer surface already delivers only captured positions, while the greeter's embedded strip (no surface region of its own, GTK pick across the whole row rect) relies on the test alone.
- **Pointer routing** (the shared router in `common/applets/surface`, fed by
  this substrate's window controllers): a row-level EventControllerMotion +
  GestureClick route enter/leave/motion/press GEOMETRICALLY to the applet
  whose slot band contains the pointer — the slot coordinate is the ROW-axis
  coordinate (`g.rowAxis`: x for top/bottom, y for left/right; hit-testing x
  unconditionally flipped left/right input). Panel-internal gestures are
  unchanged (the pill DrawingArea stays the pick target inside the overlay).
  Move-mode gestures attach to the shared window; the drag reconstructs the
  pointer's SCREEN travel from
  the surface-local GestureDrag offsets plus the applied margin delta
  (`S = offset + k·(margin - base)`) — integrating the surface-local deltas
  alone cancels the window's own motion every update (the icon never left
  the begin point).
- **Synthetic enter classes (CRITICAL — do not regress)**: the shared
  surface receives enteers that are NOT real pointer crossings, and both
  classes hover-opened panels before they were fixed:
  1. Hyprland projects the resting pointer's position onto the surface on
     map/geometry commits — out-of-bounds coordinates (e.g. y=-169 on a
     140px band). The router drops any enter/motion/press whose coordinates
     fall outside the current surface bounds (real hovers are always
     in-bounds — the input region is a subset of the bounds).
  2. GDK replays enter events with CACHED in-bounds coordinates after our
     own geometry commits (band resize/margin move/panel attach) — routed as
     hovers they re-open panels under a pointer parked outside the dock.
     Hover-open routing is suppressed for a BOUNDED window
     (`timing.leaveGrace`) after every geometry commit: GDK's replays land
     within a frame, so they stay blocked, while a genuine crossing arriving
     later opens on the enter ALONE (the pointer often stops dead on the
     icon, so a motion-must-follow rule would starve exactly those hovers).
     A suppressed enter parks its target as
     `pendingOpen`, and the next in-bounds motion over the SAME applet
     promotes it to a genuine open — so a genuine hover approaching from the
     gap/off-dock inside the grace window still opens. The per-applet
     map-enter guard (below) stays as belt-and-suspenders for the boot map.
- **Stale hover after slot slides**: slot animations move applet bands under
  a stationary pointer; a compositor re-eval enter can land on a band that
  then slides away with no following leave (no further commits) — the stale
  hover keeper would pin the reveal session open. `settle()`
  re-evaluates the routed hover target against the last seen pointer
  position after every geometry settle.
- **Rebuild**: `rebuildDocks()` destroys ONE surface per monitor (bindings
  share it) — the retract+intro animation plays on that one surface.

## Sources (what lives here)

- `Dock.tsx` — per-monitor dock factory: builds the shared surface, the
  applet bindings, the row; `rebuildDocks` (1 surface destroy/build per
  monitor), `redrawAllDocks`, debug accessors.
- `DockSurface.tsx` — the dock's LAYER-SHELL SUBSTRATE for the shared renderer
  (`common/applets/surface`): creates the one layer window per monitor, applies
  the extent (band × pillHeight), the grow-axis minimum and the row-start
  margin, installs the capture region's rect union as the wl_surface input
  region (the same geometry the shared router enforces — see the capture lock
  above), fades the surface in on map and
  feeds the window's pointer controllers into the shared router. It implements
  `AppletSurfaceHost` and nothing else — the rendering lives in common. The
  window is created `Astal.Keymode.NONE` (keyboard interactivity NONE): see the
  keyboard-interactivity gotcha below.
- `dock-row.ts` — per-monitor dock row coordinator; the OVERFLOW feature
  (ordered slot list, hidden set, tri-state mode `auto`/`show`/`hide`
  persisted in this module's own state store — app `dock`, key `overflowMode`).
  Owns slots (drives
  `surface.setSlot`/`provisionSlot`/`settle`), the reveal session, move mode
  (free-margin drag on the shared window) and the move-mode snap math
  (`windowDims`/`discOrigin` — single-applet extent + disc origin).
- `applets.ts` — the dock's applet MANIFEST: one entry per hosted applet
  (`{ name, create, debug? }`), `overflow` flagged `dockLocal`. `Dock.tsx`
  builds the row from it and the manifest registers each applet's own `dock
  debug <name>` command. It also builds `dockBackend` — the OS-domain object
  every applet mount receives — from `createInProcessBackend()`
  (`common/applets/host/in-process`) plus the two dock-owned capture domains.
  The applet CLASSES live in `common/applets/<key>/`
  and the factories they build on (`create-applet-core`,
  `create-continuous/step-applet`, `draw-utils`) in `common/applets/shared` —
  every applet host (this dock, the greeter strip) imports them from there.
- `Overflow.tsx` — the row's overflow control (clock, hide/show-all,
  move-mode entry). Deliberately dock-LOCAL, not a `common/applets` class: the
  greeter strip has its own layout and needs none of those policies. It takes
  `dockBackend` as a second argument (`applets.ts`) so its clock can read the
  battery and the volume/brightness domains. Its rim-marker scale
  (`litMarkerCount` / `notchRun` / the run state its declared fade element is fed,
  `notchRunState` / the two-tier `notchTicks`) is pinned by `Overflow.probe.ts`
  beside it.
- **Battery notches (overflow `hide` mode).** With every applet parked the
  battery icon is off the row, so the clock dial's 12 rim ticks double as the
  charge readout: the 12 ticks sit `100/n` apart — ≈ 8.33 % each — and marker
  `i` (0 at 12 o'clock, clockwise) lights once the charge REACHES it: 12 o'clock
  at 0 %, 1 o'clock at 8.33 %, 2 o'clock at 16.67 %, up to the 11 o'clock marker
  at 91.67 %. Each threshold is `i · 100/n` — derived from the marker count, not
  a constant (`floor(pct · n/100)`, capped at the last marker) — so a 0 % dial
  keeps its 12 o'clock marker lit and a full charge lights all twelve. The scale
  itself is ONE exported pure function in the same file — `notchRun(value, count,
  colour)`, with `litMarkerCount` under it: marker `i` lights once the value
  reaches `i·100/count`, and a marker past the lit run answers null so the caller
  paints its own idle colour there.
  A lit marker takes the shared battery colour policy
  (`common/applets/shared/battery-colour`, the same call
  the battery applet's ring makes: `charging` while sysfs status reads
  `Charging`, `plugged` while AC is present with the pack neither filling nor
  draining — status `Full` or `Not charging`, which is what a topped-out and a
  charge-capped battery each report — else `warn`/`low`/`ok` by
  `appearance.thresholds`), while a
  depleted marker keeps `appearance.clock.dot`. The state colour is the WHOLE lit
  run's, not a per-marker shade: every notch the charge has reached carries that
  one colour (the blend mixes two RUNS, never an index), and how MANY notches
  carry it is the charge's fraction — so the run's surface is supplied by the
  lane's painted value, which ADOPTS the first reading it is handed (a fresh
  lane starts at 0 and would otherwise paint the 12 o'clock notch alone until an
  unrelated transient started the frame loop). Ticks only (analogue + digital —
  clean mode's 4 cardinal dots carry no such scale). The charge comes from
  `backend.battery.batteryState(timing.poll.batteryPower)`, read with `peek()`
  on the clock's existing 1 s repaint tick — no extra timer.
- **The two-tier tick scale (`appearance.clock.minorTicksPerGap`).** The tick
  dials divide every gap between adjacent rim markers into `minorTicksPerGap + 1`
  slots (`notchTicks(count, minorPerGap)` — the ONE scale description, exported
  beside `notchRun`; 0 = the 12 majors alone), so the ring reads much finer
  without a second renderer: all slots sit evenly on ONE circle, and the value
  lights them by ONE run — `notchRun` is handed the WHOLE slot count, majors and
  sub-ticks alike. `RIM_MARKER_COUNT` (12) is still the major count and
  `notchTicks` places major `i` at slot `i·(minorPerGap+1)`, which is the same
  angle and the SAME threshold it has on a majors-only scale — the sub-ticks fill
  in between the majors' thresholds instead of moving them (proved by the probe
  at every subdivision). Colour policy and the battery/transient runs are
  untouched: the sub-ticks share the majors' run, so they can never
  fade inconsistently with them. The sub-ticks differ in GEOMETRY only,
  from the `MINOR_TICK` constants in `Overflow.tsx` (inset from the rim, length,
  width, alpha) — same shadow path as the majors, since both draw through
  `drawShadowedNotch`. The sub-ticks sit INSIDE the majors' outer tip (16.35/18
  against the majors' 16.5/18), and the second hand's tip is flush with the
  MAJORS (both 16.5/18, reaching 0.952 of the radius with their round caps), so
  nothing about the hand is radially short of the ring; the one deliberate gap is
  the shared 0.5/18 icon-border margin the hands and the ticks both keep (see the
  `CLOCK_GEOM` comment — the caps must not poke past the icon border).
- **Transient readout (`appearance.clock.transientHoldMs`).** While the volume or
  the screen brightness is being adjusted the dial shows THAT value on the same
  marker scale, in the adjusting applet's own ring colour — `ringColours.volume`
  / `volumeByType` through `common/applets/volume/colour.ts` for volume,
  `ringColours.brightness` for brightness. **It is the `hide` mode's readout
  only:** the dial reads the row's own mode (`dock-row.ts` `getMode()` — the ONE
  source the pill's steps and the reveal session answer to) and paints a coloured
  notch only while that mode is `hide`, where every other applet is parked; in
  `auto`/`show` the volume and brightness applets sit on the row, so a reading on
  the dial would only repeat them. The gate is read per paint, so a mode switch
  takes effect on the next frame, and a reading offered outside `hide` starts no
  transient at all (no frame loop and no hold timer for a dial that paints none of
  it). `transient` — the reading the dial is on, null = the idle charge scale — IS
  the run the dial paints, so every change of what the dial shows is a change of
  that run's COLOUR and goes through the dial's ONE declared fade element below:
  the outgoing run's alpha falls as the incoming one rises, each pass painting its
  own run's lit slots, so the idle run is never left underneath the reading and
  neither run is ever painted at full strength over the other. Both directions
  cross-fade: into the reading (charge run out) and back out to the battery
  readout once the reading has held for `transientHoldMs`, and a switch between
  volume and brightness cross-fades too. A step within ONE adjustment (a slider
  drag, a held media key) RETARGETS the run the dial is on instead: the run takes
  the new value, its colour is unchanged so no transition is owed, and the lit
  fraction eases to the new reading. A per-step restart would reset the
  transition on every step, and a drag's steps arrive far faster than a fade
  lasts, so the incoming run would never arrive and the dial would sit on the
  outgoing reading for the whole drag. Duration and easing are the shared fade's
  (`timing.fadeAnim` / `timing.fadeEasing`); there is no separate crossfade key. It
  reads the domains those two applets read (`backend.brightness`, and the OPTIONAL
  `backend.volume`, which the dock's in-process binder supplies), so a slider
  drag, a media key and an external change all read the same. A lane compares each
  reading against the one it holds: a lane with no reading yet adopts the first
  one it is handed as its baseline (never painted), and every later change paints.
  The lane carries no settling rule of its own, because READINESS IS THE DOMAIN'S
  DECISION — the volume domain answers `available: false`, publishing nothing,
  until WirePlumber has bound the sink with its volume parameter (see root
  AGENTS.md, `common/applets/domains/volume`), so no pre-settle reading can reach
  the clock. A fresh process's volume lane therefore opens empty and adopts the
  domain's single real reading; the lane is seeded from the sink's level when the
  domain already reports one (a dock row REBUILD, whose domains are already bound),
  so the first adjustment after a rebuild paints too. The brightness lane always
  opens empty — its domain's state starts at a placeholder 100 % until its first
  async read lands, so a mount snapshot there is not necessarily the screen's real
  level — and the domain publishes that first read whatever the screen sits at (a
  machine at 100 % included: the placeholder is the value, not the reading, and a
  device-less process publishes nothing), so the lane adopts a real baseline and
  the first adjustment off it paints. That publish rule lives in
  `common/applets/domains/brightness-publish`, beside the domain rather than
  inside it, because the domain module's exported surface IS the applets backend
  contract (`AppletBackend.brightness` is that module's type, so every value
  export becomes a transport member every host must provide). Tick dials only, and
  a hidden clock paints nothing.
- **The rim-notch colour fade (the dial's declared element `notches`).** The tick
  scale is painted as TWO elements. The **run** — the notches the colour policy
  colours on the idle scale (the battery charge) or the live transient
  volume/brightness reading, whichever the dial is showing — is the dial's ONE
  declared fade element, created through the shared
  `common/applets/shared/element-fade.ts` exactly as the battery applet's ring arc
  is: its painted state is the run itself, built by the pure `notchRunState(value,
  colour)` (the lit fraction it is scaled by, then the colour every notch it lights
  carries), and the identity it fades on is that COLOUR. So ANY change of the
  run's colour cross-fades — a battery state change (charging starting or stopping,
  the charger being plugged in or out, a level crossing one of the policy's
  thresholds) and a reading arriving, leaving or switching source alike — the
  outgoing run's alpha falling as the incoming one rises, each pass painting its
  OWN run's lit slots, with no frame ever recorded or replayed. A change of the
  lit fraction alone (a charge step, a slider step) is the notch value sweep's
  business and adopts at once — including while a colour cross-fade is in
  flight: the value adopts and the cross-fade keeps running, which is what the
  shared mechanism now does for a declaration that passes an `id`. There is
  exactly ONE mechanism for every notch colour change — the transient lane keeps
  no crossfade of its own — so nothing can
  paint one change twice. The **unlit notches** keep the clock's dot colour, which
  never changes: they are painted once per paint, OUTSIDE the fade, at full
  opacity, and stay byte-identical through a transition. The declaration appears
  in `fade status` as `<applet>.notches`, and the transition's frames are the
  fade's own source, not the clock's frame loop.
- **Per-frame repaint only while the dial is actually moving (`CLOCK_SMOOTH_FPS`).**
  The dial paints every frame while something on it is MOVING: a clock fade
  in flight, the notch scale's lit fraction still easing, or a transient
  volume/brightness reading live on a visible clock. Outside those windows the
  clock is back on its idle repaint (`timing.clockTickMs`): a permanently 60fps
  clock costs ~2W (4W→6W), so the loop is never armed while nothing is animating.
  There is exactly ONE frame source (`runFrames`, the shared frame primitive):
  `clockFade` is the tween it steps, every start request goes
  through `ensureSmoothLoop` (a request while it runs joins the running loop
  rather than starting a rival), and `stopSmoothLoop` settles that tween and is
  safe on an already-stopped loop — so a transient arriving mid-fade can neither
  start a second loop nor leave a half-faded frame. The policy is the exported
  pure `smoothLoopRuns(animating, easing, transient, clockVisible)`: a transition
  in flight always keeps the loop, an easing lit fraction or a live reading keeps
  it only on a VISIBLE clock (a hidden clock paints nothing). The rate is
  `CLOCK_SMOOTH_FPS` (60), admitted per `smoothFrameBudgetUs` — one frame at that
  rate less a millisecond of slack, because a 60 Hz frame clock's own deltas land
  a hair UNDER the nominal interval and a strict budget would refuse every one of
  them (judder). The loop is frame-synced: a slower panel paints every frame it
  gets, a faster one is held to the rate. **Consequence:** an ordinary charge
  change is no longer free of frames — the idle tick spots it (the dial reads the
  battery with `peek`; it holds no battery subscription), arms the loop, and the
  loop runs only for the sweep: a 1 % step is ~5 frames (~83 ms at 60 Hz), a
  full-scale jump ~17 (~280 ms), and the loop stops itself once the value has
  settled. `Overflow.probe.ts` pins the policy truth table, the interval
  arithmetic and the easing's frame counts; whether the frame source actually
  fires on a mapped widget is the live check, not a probe's.
- **The notch value eases to its reading (`NOTCH_SMOOTH_FACTOR` / `NOTCH_SMOOTH_EPSILON`).**
  The lit fraction does not snap when the reading changes — it walks there, so a
  charge step and a volume/brightness adjustment both sweep the ticks. The shape
  is the applet rings' OWN closed-state smoothing
  (`common/applets/shared/create-applet-core.ts`: a frame moves
  `ringValue += diff * 0.3`, settled under 0.3) mirrored verbatim in
  `createNotchSmoother` rather than shared: that mechanism is an inline closure
  inside the applet core's factory, not an exported primitive, and the file that
  owns it is outside this applet's claim. Two lanes hold the LAST PAINTED value —
  the idle scale's charge and the live transient reading — and both advance in
  the frame loop's step, so the dial never returns to a stale charge. The first
  reading a lane is handed is ADOPTED, never swept from a made-up value (a fresh
  process has no charge to sweep from); a step WITHIN one adjustment eases; a
  source switch ADOPTS, because the fade is that transition's own animation.
  The approach is exponential, not a fixed duration, and it SNAPS onto the reading
  as it settles — that snap is the loop's stop condition and the reason one change
  costs a bounded number of frames, and a hidden clock spends no frames on one
  at all.
- **The hands ride ONE pinned 1 Hz reading (`dialTime`).** The second hand
  steps once per second, never sweeps: the dial paints `dialTimeOf(new Date())`
  stamped at exactly three moments — mount, the 1 s repaint tick, and each
  reappear BEFORE its fade (so the first visible frame carries the CURRENT
  second) — and every repaint reads the stamp. The frame loop (`CLOCK_SMOOTH_FPS`)
  therefore animates the notch ring and its value sweep freely
  without ever advancing a hand: a repaint from a fade frame, the transient
  fade or a config reload paints the second already on screen. A clock hidden
  while the loop runs advances nothing either — the tick is the only advancer
  and it is stopped while hidden. `dialTimeOf` takes the second BOUNDARY
  (milliseconds ignored), and the digital `HH:MM` rides the same reading.
- Applet machinery and classes live in `common/applets/`, NOT here (its spec sheet is `common/applets/AGENTS.md` — the mount contract, the draw path, the row/panel/pointer model, the backend and config seams): `shared/`
  (factories), `types.ts` (Panel/PanelHandle/Dial surface + the `Applet` /
  `AppletContext` contract), `layout.ts` (position string → `DockGeometry`, the
  single auditable directionality core), `panel-hub.ts` (panel open/leave hub),
  `backdrop.ts` (stadium backdrop painter), `panel-framework.tsx` (
  `continuousPanel`, step selector, corner-cancel surface), `utils/`
  (`row-region` = the capture-region owner of the shared surface (one shape
  list compiled into the input region AND the router's point test),
  `run-frames` + `appear` + `smoother` =
  frame/animation helpers, `drag` = dial accumulator, `reactive` = value
  container, `geo-log`), plus the two contracts the applets read through the
  mount context: `config.ts` (the config types + `AppletConfigSource`) and
  `backend.ts` (the `AppletBackend` OS-call domains).
- The applet menus live with their applet (`common/applets/<key>/menu.tsx`)
  over the shared shell in `common/menus/`.
- `applet-hooks.ts` — the dock-side host policy over the DockRow
  (`common/applets/hooks`). The applet dependencies travel the other way:
  `applets.ts` builds each `AppletContext` (its config mirror, the facade
  itself as `store`, and the dock's OS-domain object).
- `config.ts` / `config.schema.ts` / `config.defaults.json` / `config.json` —
  the dock's config trio + its facade (see Config), and `style.css` for the
  dock-scoped CSS.
- `config-clone.ts` — `safeClone`, the DETACHED copy a config write path stages
  before `dock.queueWrite` (clone → apply to the clone → write → apply to the
  live tree). ONE implementation for the move-mode snap persist (`dock-row.ts`)
  and the `config set|update` batch commit (`commands/config.ts`); the dotted
  path both apply is `setDottedPath` (`common/config/loader`), the same walk
  `setLive` uses.
- `screengrab/` — grim/slurp capture + wf-recorder recording (capture.ts,
  naming.ts). `stopRecording()` SIGINTs wf-recorder to finalize the file.
  Region select runs on a FROZEN frame: `selectGeo()` spawns hyprpicker as a
  still-frame overlay, waits for its layer surface to report `alpha >= 1`
  before slurping (both claim exclusive keyboard focus and Hyprland pins it to
  whichever maps last), and leaves the picker mapped until `takeStill()` ends
  it — grim must see the frozen frame, and killing the picker first races its
  fade-out. `endFreeze()` escalates SIGTERM → SIGKILL (hyprpicker ignores
  SIGTERM inside its screencopy loop) and a 60s guard drops a stuck overlay.
- `fade.ts` — surface fade in/out. Dock log lines go through
  `common/log/logger` (`ignore`/`log`) directly.
  The OS-facing helpers (battery, bluetooth, brightness, cpu, mpris, network,
  power incl. the `systemctl suspend` path, power-profile, power-supply-events,
  system, tablet, tlp, volume, wifi, workspaces, `fs` sysfs/sudo-tee writes,
  `media-window`) live in the shared `common/applets/domains/*` modules. The
  dock binds those domains IN PROCESS (it is their host — see Hosting the applet
  backend) and reads them through the same `AppletBackend` object the greeter
  reaches over the socket; no applet call site knows the difference.
- `commands/` — config (tier RESPONSE: rebuildDocks/redrawAllDocks), debug,
  menu, quit (`dock quit`: fade the surfaces out, then quit only in a process
  the dock owns — its island, the universal or per-app bundle — while a host
  that merely mounts the dock, such as the production shell or a combo, fades
  and stays alive), tablet.
- Runtime state: every value is persisted by the module that owns it, through
  the SHARED `common/state` factory (the same state-store implementation
  notes and launcher use; sync atomic writes) — this row's mode (`dock-row.ts`,
  app `"dock"`) and the applet settings in
  `common/applets/domains/{power,battery,bluetooth,power-profile}.ts`. One versioned
  `state.json` per app under the XDG state dir
  (`~/.local/state/tinshell/apps/<app>/`, NOT `~/.config`).
- **Low-battery warning (`appearance.thresholds.batteryNotifyPct`).** The battery
  applet notifies once per DESCENT: the level reaching the threshold from above
  warns, every later reading at or below it stays silent, and the level climbing
  back above it re-arms — so one descent warns once whatever the poll rate, and a
  shell restart mid-discharge neither repeats it nor swallows the next crossing.
  The armed flag is durable (`~/.local/state/tinshell/apps/battery/state.json`, key
  `lowBatteryWarned`, the applet's own store; the charge cap stays machine-level
  in `/var/lib/tinshell/charge-cap`). A charging battery never warns and charging does
  not consume the latch, so unplugging below the threshold still warns, and a
  config without the key warns not at all rather than inventing a level.
  Delivery is in-process through the notifications app's own send
  (`apps/notifications/Notifd` → `notify`, the same `AstalNotifd.send_notification`
  the screengrab applet's action notification goes through) at NORMAL urgency
  (`critical` is a zero-second timeout on this surface — sticky — so it is never
  used). The level and the armed flag are both read AT DECISION time: `appearance`
  is a live config tier whose set only redraws, so a level captured at mount would
  be ignored until a rebuild, and the flag is re-read from the file so a second
  mount of this applet (the in-session lock screen mounts the same strip) cannot
  warn again for the same descent.
- **Fully-charged counter (`common/applets/battery/charge-counter.ts`).** While the
  pack sits plugged-and-idle — AC present with it neither filling nor draining, the
  state `common/applets/shared/battery-colour` already encodes (sysfs `Full` or
  `Not charging`) — the applet's GLYPH shows how long it has been that way,
  formatted by `common/applets/shared/elapsed` (the elapsed-text arithmetic the
  power applet's uptime face established, moved there so both readouts share ONE
  formatter). The start time is durable (same state file, key `pluggedSince`, epoch
  SECONDS; `0` = not running): the state began when the pack BECAME idle, so a host
  restart mid-state RESUMES the count, and a machine that boots already topped out
  counts from its first observation — there is no earlier moment to claim. Leaving
  the state (charging or discharging resumes) clears the record and the glyph
  returns to its wattage figure. The counter keeps the glyph's existing metrics and
  wattage colour — only the CONTENT changes — and its text is recomputed on a 1 s
  tick (`timing.poll.uptime`) that repaints only when the TEXT changed, never per
  frame.
- Scripts: `amdgpu-watch.sh` (the helper `amdgpu-watch.service` runs).

## Hosting the applet backend

The dock is the user session's applet OS-call backend: `dockMount()` calls
`mountAppletsBackend()` (`common/applets/host/mount.ts`), which registers one
handler per domain under the `applets` request namespace, binds the
shared-group unix socket `/run/tinshell/applets.sock` for the pre-login greeter, arms
the machine-wide tablet watchdog and re-applies the persisted sleep inhibit
(`restoreInhibitState`). The namespace therefore lives in whichever instance
hosts the dock (the shell in production), with no route-map entry and no
cold-start target of its own — the `common/applets/host/` row and the
applets-backend section of the root spec own the surface details.

Cost of the arrangement: everything the backend holds is PROCESS bound and dies
with the dock process — the logind inhibit fd, the D-Bus subscriptions, the
tablet helper child and the applet state stores' single owner. A dock restart
re-arms the watchdog and re-applies the stored inhibit, so both survive it. The
helper child itself is SHARED per request within a process (`spawnHelperStream`
refcounts it), so a shell that also hosts the keyboard runs ONE poll loop for
the machine switch; the domain's start latch is per process. The panel
auto-close POLICY stays here (`startTabletPanelClose`,
see Lifecycle) because its inputs and effects are host state.

## Config

The dock's OWN config trio (`apps/dock/config.{defaults,schema,json}`);
`dock/config.ts` owns the `createConfigStore` instance, wraps it in
`common/config/facade.ts`, and exports that facade (`dock`) plus the typed
`config` mirror — consumers call the facade's own vocabulary:

| Section | Purpose |
| --- | --- |
| `applets` | enabled applets, order |
| `layout` | position, iconSize, pillHeight, spacing, margins |
| `fonts` | family + sizes |
| `timing` | framerate, animations, tabletCloseMs, workspacePoll, overflow/move-mode timings, per-applet polls (`timing.poll.volume` is the default sink domain's safety net, the same hybrid event+poll shape as `timing.poll.brightness`) |
| `appearance` | colours (discs/rings/glyphs/text), pill backdrop, clock (incl. `appearance.clock.transientHoldMs` — how long a transient reading holds — and `appearance.clock.minorTicksPerGap` — sub-ticks per gap between the rim markers, 0 = majors alone), icons, ringColours (`battery` carries `charging` / `plugged` / `ok` / `warn` / `low` / `cap`, the tokens `common/applets/shared/battery-colour` picks between: `plugged` is the AC-present-but-idle state — status `Full` or `Not charging` — and a config whose map lacks it falls back to the level colour), stepColours, thresholds (percent levels: `batteryLow` 15 / `batteryWarn` 30 colour the battery ring through `common/applets/shared/battery-colour`, `batteryNotifyPct` 10 is the level whose DESCENT raises the low-battery notification, `cpuHigh` 80 / `cpuMid` 50 colour the performance ring, `dragDeadZone` 4 is the panel drag threshold, `volumeHigh` 50 picks the volume glyph's loud variant), wifi, menu theming, debugFill |
| `screengrab` | dir, format, codec, quality, name template, audio/cursor, overlay, capture mode, hwEncode/vaapi |

- `config` is the STABLE mirror of the dock config (identity never changes;
  re-synced in place — see the contract in `common/config/facade.ts`).
- Tiers: the schema marks paths `restart` vs live; the tier RESPONSE is
  dock-side (`commands/config.ts` `onConfigChanged` → rebuild/redraw) and
  fires only on DOCK subtree changes.
- `set()` validates against the prefixed schema path before mutating +
  persisting the whole config.json.

## Event sources vs polls

Applets use the hybrid pattern — EVENT primary + low-freq safety poll
(never 100% trust signal delivery, esp. across suspend/resume):

| Applet | Event source | Poll (safety net) |
| --- | --- | --- |
| Media | MPRIS `signal_subscribe` (common/applets/domains/mpris.ts) | 30s resync |
| Bluetooth | BlueZ PropertiesChanged (common/applets/domains/bluetooth.ts) | 30s |
| Wifi | NM signal_subscribe ×4 (common/applets/domains/wifi.ts) | 30s |
| Workspaces | Hyprland socket2 stream (common/applets/domains/workspaces.ts `onWorkspaceEvents`, reconnect w/ backoff) | 30s (`timing.workspacePoll`) |
| Battery | BAT0 kernel uevent via GUdev (common/applets/domains/power-supply-events.ts) — instant STATUS flips only; kernel NEVER uevents during steady discharge | 2s (`timing.poll.batteryPower`) — stays 2s |
| Charge threshold | same BAT0 uevent → instant heal after asus_wmi reset | 30s (`timing.poll.chargeThreshold`) |
| Brightness | backlight `change` uevent via GUdev (common/applets/domains/brightness.ts) — every write (ours/logind/Fn) fires it | 30s (`timing.poll.brightness`) |

Keep polling (no event source exists): Performance cpu/ram/temp, autoProfile,
TLP profile drift, uptime. NEVER migrate Battery values to UPower:
DisplayDevice PropertiesChanged is a payload-less ping every 30s (4 events /
2min vs 36 real sysfs changes) — a 30s poller wearing an event hat.

The charge cap is MACHINE state, not applet state: the dock's applets backend
and the greeter's strip bind the SAME `chargeThresholdStore`
(common/applets/domains/battery.ts), and that store OBSERVES
`/var/lib/tinshell/charge-cap` (`Gio.FileMonitor`) — a cap set on the lock screen
reaches the session host instead of being displayed, and healed against, as a
stale value. `set()` stays authoritative in the writing process: a monitor
event that arrives while its own write is in flight is ignored.

## Command surface

All registered PREFIXED (`["dock", …]`) — same paths in shell (`ags -i shell
request "dock …"`) and the island (`ags -i dock request "dock …"`):

| Path | Purpose |
| --- | --- |
| `dock config get/set/reload/update` | live config read/write/reload + update (schema-validated) |
| `dock debug geo/gc/windows/state/redraw/menu/wifi/overflow/screengrab/region/focus` | geometry introspection, GC, applet list, state-store dump (path/version/keys), redraw, menu debug (incl. `scrimVisible`), wifi scan, overflow snap-info + guard repro, screengrab capture, single-surface band/slot/region dump, layer-window keyboard state (`focus` — per-window namespace + keyboard-interactivity mode + focus flags). The `wifi` and `screengrab` probes are APPLET-declared: their handlers live in `common/applets/<Name>/commands.ts` and are registered by `apps/dock/applets.ts` under these same paths |
| `dock menu wifi/bluetooth/close/screengrab-capture/screengrab-settings` | open the wifi/bt/screengrab menus, close menus |
| `dock screengrab capture still-or-video fullscreen-or-window-or-select` | run the applet's OWN capture pipeline from a request — the Print keybind's path. Same implementation as the overlay menu (`common/applets/screengrab/capture-run`), plus the clipboard copy. The notification's Annotate action is dispatched through an IN-PROCESS handler, so a capture started anywhere but the hosting instance would raise a button that goes nowhere |
| `dock quit` | SIGINT an in-flight wf-recorder (finalizes the file), fade the dock surfaces out (~200ms, SYNC — the helper pumps the main context), then quit the instance only when the process is the dock's own (its island, the universal or per-app bundle); in a host that mounts the dock among other apps (the production shell, a combo) the fade is the whole teardown and the request never ends the host. The builtin `ags -i dock quit` exits without a fade |
| `dock tablet set/get` | manual tablet-mode override (`on/off/auto`), session-scoped |

## Lifecycle

`dockMount()` (the shell's universal entry or island `app.ts`), in order:

1. `menuInit(monitor)` — pre-create the hidden click-through menu window so
   the wifi/bt GUI's first open never maps a fresh surface at click time.
2. `Dock(monitor)` per monitor.
3. `cornerCancelInit(monitor)` — pre-create the corner-cancel surface.
4. `restoreFollowMouseAtStartup()`.
5. `mountAppletsBackend()` — bring the applet backend up (the `applets` request
   namespace, the greeter's unix socket, the tablet watchdog ingest, the
   persisted sleep inhibit).
6. `startTabletPanelClose()` — the panel auto-close policy (host-side, over the
   `tablet` domain the step above publishes; the latch/listener core is shared:
   `common/tablet`, `fallback: "switch-only"`; the helper child is refcounted
   per request, so it is the keyboard's one when that app is hosted here too).

Teardown: `dock quit` is the only quit path with app-level work — it
SIGINTs an in-flight wf-recorder so the file finalizes, fades the surfaces,
then quits the process only in a process the dock owns (its island, the
universal or per-app bundle); in any other host that mounts the dock among
other apps — the production shell, a combo — the fade is the whole teardown
and the host stays alive. The dock registers that command itself
(apps/dock/commands/quit.ts) rather than leaning on createApp's generic
`<instanceName> quit`: the shim's
quit (`App.quit` → `g_application_quit` → `exit(code)`) hard-exits before
GApplication emits `::shutdown`, so a request command is the only reachable
quit path — `tinshell-host stop dock` drives exactly this one. An island killed
by SIGTERM (`systemctl --user restart tinshell-dock`) runs no app code at all —
wf-recorder is left in the unit's cgroup and finalizes on the SIGTERM it
receives there (wf-recorder treats SIGTERM/SIGINT/SIGHUP as graceful stop).

## Gotchas (documented traps)

- **Layer-surface keyboard interactivity — the band is POINTER-ONLY.** The
  dock-pill window is `Astal.Keymode.NONE`. Hyprland hands the seat's keyboard
  focus to ANY layer surface whose keyboard interactivity is not NONE the
  moment it maps (`CLayerSurface::onMap` — `GRABS_KEYBOARD` /
  `rawSurfaceFocus`) and again on every pointer motion over it
  (`InputManager::mouseMoveUnified`), and it does so WITHOUT touching
  `m_focusWindow`, so `hyprctl activewindow` still reports the user's window
  while their keystrokes go nowhere — the tell for this bug class. With
  ON_DEMAND the band therefore stole the user's keys at every dock
  spawn/restart (and on every pointer pass over the bar), so the mode now
  follows the OPEN PANEL: `dock-row.ts` `setPanelOpen()` raises the pill to
  ON_DEMAND while any panel is open — the one state whose Escape drag-bail
  (panel-framework `attachPanelEscape`, attached to the pill window) needs the
  compositor to deliver keys here — and drops it to NONE on the last close.
  The same rule applies to any other mapped-at-birth surface: the menu window
  (`common/menus/menu-framework.tsx`, keymode NONE while idle, ON_DEMAND only
  while a menu is open). Regression hook: `dock debug focus` prints every dock
  layer window with its `keymode`; `keymode=0` on every surface with no panel
  or menu open is the pass condition.
- **MPRIS arg0 is matched EXACTLY** — gjs exposes no arg0namespace, so the
  media applet filters by the bus-name prefix in the callback (a trailing-dot
  namespace form does not work).
- **Tablet mode** needs the `input` group + a lingering-manager restart
  (pre-usermod groups persist until reboot). Manual override:
  `dock tablet set on|off|auto`. Open applets auto-close after
  `timing.tabletCloseMs` (3000) while tablet mode is on.
- **Screengrab notify** (`notifyWithAction` from `@apps/notifications/Notifd`)
  is the app's ONE cross-app import — the daemon is LAZY there, so importing
  never claims `org.freedesktop.Notifications`. In dev, the notification
  displays via whichever process owns the daemon (shell always). The capture
  pipeline itself lives in `common/applets/screengrab/capture-run.ts`, shared by
  the applet overlay and `dock screengrab capture` (the Print keybind) — the
  action is dispatched through an in-process handler, so only a capture running
  in the instance that hosts the dock can offer a working Annotate button.
  `AstalNotifd.Action` takes a PROPERTIES OBJECT (`{ id, label }`); the
  positional form throws and aborts the whole notification.
- **State store** — every persisted value's OWNER holds it, through the SHARED
  `common/state` factory (`createStateStore`): the row mode in
  `dock-row.ts` (app `"dock"`), each applet setting in the
  `common/applets/domains/*` module that uses it. Never hand-roll a flat file or
  write these values with `writeUserFileAsync` directly (sync atomic writes +
  one source of truth per app). `dock debug state` dumps the dock store's
  keys.
- **`amdgpu-watch.sh`** is the dock-local helper `amdgpu-watch.service` runs
  (chmod'd by setup.sh).
- **Media applet overflow/despawn lifecycle** — playing → row. The
  playing→paused transition starts the `timing.mediaIdleMs` grace (default
  300000, live tier; restarts on every playing snapshot); when it expires the
  applet moves INTO OVERFLOW with its state preserved (progress ring,
  activePlayer, goto origin — only the auto-hide rule flips), and playback
  resuming returns it to the row instantly. NO MPRIS player at all → the
  applet DESPAWNS: `setAppletDeactivated` (hidden in EVERY overflow mode,
  excluded from the reveal fan-out) instead of parking in overflow; a player
  appearing re-spawns it normally.
- **Scrim stuck-map hardening** — `assertScrimIdle()` (from `menuInit()` and
  every `openMenu`) forces the scrim unmapped + empty region whenever no
  menu is active; `dock debug menu` reports `scrimVisible` so a stuck state
  is observable.
- **Map-enter guard (spontaneous overflow-open fix)** — a dock window that
  maps under a RESTING pointer (fresh boot, or the move-commit reflow where
  the pointer sits on the just-dragged overflow icon) receives a synthetic
  wl_pointer enter from the compositor that never crossed the window's
  boundary. TWO rules make the guard complete: (1) an enter is swallowed
  while the post-map arming grace (`timing.leaveGrace`) has not passed; (2)
  MOTION NEVER OPENS A PANEL — motion updates only the cursor channel.
  Suppression lifts ONLY on a genuine leave→re-enter boundary crossing after
  the arming grace, or via the explicit `pressOpen` tap (touch): a
  motion-lifts-the-guard path re-opened panels on the user's next real mouse
twitch (the synthetic enter leaves `pointerInside=true`). Never
re-introduce a motion-driven open. Regression hook: `ags -i shell request
"dock debug
  overflow guard repro"` replays the synthetic post-map condition through the
  REAL handler chain on every applet core (`openedByMotion=false` is the
  pass condition; also leaves reveal-keeper state clean); `dock debug
  overflow guard` dumps per-applet guard state + path counters. With the
  single surface, the router-level synthetic-enter filters (Architecture
  above) carry most of this protection; the per-applet guard covers the
  boot map.
- **Input regions are rect-union approximations**
  (`@common/applets/utils/row-region.ts` `compileCaptureRegion` — the shape
  compiler behind BOTH the wl_surface input region and the router's capture
  test) — gjs
  cairo has no region-circle API. Rounded caps MUST be per-scanline chord
  rects (circle equation); full-width cap squares union into the whole
  bounding rect and make the empty corners capture hover/click input.
- **BT/WiFi scan steps are TOGGLES, not one-shots** (step 2 in both applets): BT starts discovery when off and calls `Adapter1.StopDiscovery` when the adapter is already scanning — BlueZ scans indefinitely until stopped (the optimistic `setSpin` covers only the D-Bus roundtrip; the spin itself follows the adapter's `Discovering` property via event+poll in `refresh()`). WiFi: NM's `rescan` is ONE-SHOT — there is no backend scan to stop, so "off" cancels the applet's scan state (the 2800ms window timer + spin); a second tap can end it early. The bluetooth GUI's auto-discovery-on-open is UNCHANGED and only stops discovery IT started (`weStartedDiscovery`), so an applet-initiated scan survives menu open/close.
- **The WiFi menu's scan spin lives on the APPLET's scan glyph** (step 2), not in the menu (common/applets/wifi/scan-bridge.ts — the menu notifies scan state, the applet owns the affordance; the connecting spinner stays in the menu). While the menu is open `menuScan` keeps the applet's 2800ms window RE-ARMING, so the glyph spins for as long as the menu scans; menu close (any path) or radio-off releases it via `wifiMenuScanNotify(false)`. A manual step-2 toggle still cancels (stopScan clears menuScan).
- **The WiFi menu opens PRIMED — no shrink-then-grow**: `openWifiMenu` reads status + the active AP's SSID (`activeWifiSsid()` in common/applets/domains/wifi.ts, fast bounded D-Bus) BEFORE `openMenu`, so the window maps with the CURRENT network as its only row; the panel height is stable from the first frame and only ever GROWS (scan results + saved markers render per stage as they land — refresh() renders after each stage, snapshot-guarded). Not connected/SSID race → a stable-height "Scanning…" TEXT row (never a spinner row; never an empty list).
- **The WiFi menu's connect flow submits on the password entry's `::activate`** (common/menus/menu-framework.tsx `menuEntryRow`): the entry's internal text widget claims Return on its way up and emits `activate` instead, so a bubble-phase key controller on the entry NEVER sees Return — the entry takes focus and typing lands, yet Enter submits nothing. The row's failure line renders FIRST in `buildRows` (common/applets/wifi/menu.tsx): the list is capped at `appearance.menu.maxRows` rows, so an error appended after a full network list is painted below the visible panel. `connectWifi` (common/applets/domains/wifi.ts) runs nmcli as an argv — the password is one argument whatever it holds — with stderr captured, so the row carries nmcli's own reason (`Error: …`) instead of a bare exit code.
- **BT device list sort** — named devices sort ABOVE ID-only ones (ID-only = a name that is a MAC address in EITHER separator form — colon OR the dash form BlueZ uses as the alias for unnamed devices, e.g. `7C-4A-68-32-F0-15` — or a bare hex blob), within each group: connected, then paired, then alphabetical (comparator in `common/applets/domains/bluetooth.ts` `listBluetoothDevices`).
- **`setRebuildDocks` is armed at MODULE SCOPE in Dock.tsx** (top-level call, not inside `rebuildDocks()`): the move-mode commit path (`detachForRebuild` → `rebuildDocksRef?.()`) fires before any `rebuildDocks()` call has ever run, so an in-function arm leaves the ref null at first mount — first move-mode drag commits config but never rebuilds (overflow alone lands at the dragged spot). Keep the arm top-level.
- The dock is the heaviest mount in shell — a restart reloads all dock
  windows (brief bar flicker is expected).
- **DBus tuple replies: deepUnpack yields ONE element per signature child.**
  `ListNames` is `(as)` → `[string[]]` — destructuring `[, names]` takes index
  1 (undefined) and a swallowed catch turns that into a silent no-op
  (mpris.ts's seed loop never sees a player that was ALREADY on the bus at
  (re)build time).
  Pattern check: `const [x] = …deepUnpack() as [T[]]` for `(as)`/`(ao)`.
- **GTK pick descent stops at the first `can_target=false` ancestor** —
  hosting applet cores OUTSIDE the shared renderer (a prototype embedding them
  in its own window) breaks hover entirely if the host's container widget is
  `can_target=false`: the pointer CROSSING/pick never descends past it, so NO
  enter reaches the applet cores (they look dead — no hover, no click). The
  container must stay targetable; only the transparent filler regions are made
  non-targets (the renderer's row is the pointer target and the icons are
  non-targets, so the row's geometric router receives every crossing). Symptom
  signature: applet cores alive in the dock but frozen when embedded
  elsewhere.
