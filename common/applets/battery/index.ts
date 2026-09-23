/**
 * Battery applet — charge-threshold slider with the battery/wattage rings.
 *
 * The ASUS asus_wmi driver resets charge_control_end_threshold to 100 on every
 * power cycle (AC plug/unplug/reboot); the chosen threshold is persisted in the
 * MACHINE-level intent file (`/var/lib/ags/charge-cap`, reached through the
 * battery domain's `chargeThresholdStore`) and re-applied whenever sysfs
 * drifts. Machine-level rather than per-user because the pre-login greeter sets
 * this cap as a different user.
 *
 * A host whose backend does not serve the fs domain (`fs.available` false —
 * the lock screen's socket client) is READ-ONLY: it displays the configured
 * limit and never reads or writes sysfs. The durable store is written only by
 * an explicit user set — never seeded from a sysfs read, which is how a denied
 * read once became a persisted 100.
 */
import GLib from "gi://GLib"
import { notify } from "@apps/notifications/Notifd"
import type { AppletBackend } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import { continuousPanel } from "@common/applets/panel-framework"
import { batteryRingColour, isPluggedIdle } from "@common/applets/shared/battery-colour"
import { createContinuousApplet } from "@common/applets/shared/create-continuous-applet"
import type { RingSpec } from "@common/applets/shared/draw-utils"
import { clamp01, drawDisc, drawGlyph, drawRings } from "@common/applets/shared/draw-utils"
import { createElementFade, withFadeAlpha } from "@common/applets/shared/element-fade"
import { createValueTick } from "@common/applets/shared/value-tick"
import type { AppletContext, DrawIcon } from "@common/applets/types"
import { mkReactive } from "@common/applets/utils/reactive"
import { createStateStore, type StateStore } from "@common/state"
import { onCleanup } from "gnim"
import { createChargeCounter } from "./charge-counter"
import { createLowWarningLatch } from "./low-warning"

// ASUS-specific battery naming (BAT0). On a machine with a different supply
// name the reads fail and the writes are refused — the applet then has no
// applied value to show and never invents one.
const THRESHOLD_SYSFS = "/sys/class/power_supply/BAT0/charge_control_end_threshold"
/** Durable store key holding the user's charge limit. */
const THRESHOLD_KEY = "chargeThreshold" as const

/** Durable low-battery warning latch: true while the warning has fired for the
 *  current discharge and has not been re-armed (see ./low-warning.ts). */
const LOW_WARNING_KEY = "lowBatteryWarned" as const

/** Durable start of the plugged-and-idle state, in epoch SECONDS; 0 = the state
 *  is not running. The key of the battery domain's MACHINE-level store
 *  (`pluggedSinceStore` → /var/lib/ags/plugged-since), NOT of this applet's
 *  per-user state file: the pre-login greeter paints the same counter and cannot
 *  read this user's state dir, so the stamp has to live where both hosts read
 *  it. The counter reads it so a host restart mid-state resumes the count
 *  instead of restarting it (see ./charge-counter.ts). */
const PLUGGED_SINCE_KEY = "pluggedSince" as const

/** This applet's own per-user state file
 *  (~/.local/state/tinshell/apps/battery/state.json): the low-battery latch. It has
 *  to outlive the process — a restart mid-discharge must neither repeat a
 *  warning already sent nor swallow the next crossing. Built per mount so the
 *  file is read fresh, never from a mirror older than the mount. */
function lowWarningStore(): StateStore<typeof LOW_WARNING_KEY> {
  return createStateStore<typeof LOW_WARNING_KEY>({
    app: "battery",
    version: 1,
    keys: {
      lowBatteryWarned: (v: unknown) => typeof v === "boolean",
    },
  })
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v))
}

/** BAT0's applied charge limit, or null when sysfs cannot be read (attribute
 *  absent, unreadable, or a host the backend does not serve the fs domain to).
 *  A failed read is NOT a value. */
async function readSysfs(fs: AppletBackend["fs"]): Promise<number | null> {
  const raw = await fs.readFileAsync(THRESHOLD_SYSFS)
  const val = parseInt(raw, 10)
  return Number.isNaN(val) ? null : clampPct(val)
}

/** The user's configured limit, or null while the store holds none or has not
 *  answered yet. NEVER writes: the durable value changes only on an explicit
 *  user set, so a runtime read can never overwrite the user's choice.
 *  `get` FIRST, never `ready`: a transport-read store (the greeter's socket
 *  client) only fetches on a get, so probing `ready` alone can never answer and
 *  the value would stay UNKNOWN for the host's whole lifetime. The memo miss it
 *  guards IS "nothing has arrived yet" — `undefined`, never a confirmed
 *  absence — and both callers below read null as UNKNOWN (nothing shown,
 *  nothing written). */
function storedThreshold(battery: AppletBackend["battery"]): number | null {
  const store = battery.chargeThresholdStore
  const v = store.get(THRESHOLD_KEY)
  return typeof v === "number" && !Number.isNaN(v) ? clampPct(v) : null
}

function persistThreshold(battery: AppletBackend["battery"], pct: number): boolean {
  return battery.chargeThresholdStore.set(THRESHOLD_KEY, Math.round(pct))
}

/** Apply a user-chosen limit: sysfs, plus the durable store that records the
 *  intent. A host without the fs domain is read-only — nothing is applied and
 *  nothing is persisted. */
async function applyThresholdAsync(
  fs: AppletBackend["fs"],
  battery: AppletBackend["battery"],
  pct: number,
): Promise<void> {
  if (!fs.available) return
  await Promise.all([
    fs.writeFileAsync(THRESHOLD_SYSFS, String(Math.round(pct))),
    persistThreshold(battery, pct),
  ])
  // Authoritative echo: the sysfs write fires no uevent,
  // so without this the icon ring waited for the 30s safety poll. One extra
  // tick right after the write re-reads the REAL applied value — if the write
  // was refused, the ring snaps back to truth instead of lying.
  void _threshTick?.()
}

/** One threshold tick: the value to display, or null when there is nothing
 *  verified to show (the caller keeps its last value).
 *  Heal: sysfs drifting from the stored limit means a power event reset it, so
 *  re-apply the user's choice — but only from VERIFIED values. An unreadable
 *  sysfs read cannot be compared, and a store that has not answered is not
 *  "unset". */
async function tickThreshold(
  fs: AppletBackend["fs"],
  battery: AppletBackend["battery"],
): Promise<number | null> {
  const stored = storedThreshold(battery)
  // No fs domain (the lock screen's socket client): the applied value is not
  // readable and must never be written — show the configured limit only.
  if (!fs.available) return stored
  const sysfs = await readSysfs(fs)
  // No verified sysfs value: show the user's own configured limit rather than
  // a constant, and leave the machine alone.
  if (sysfs === null) return stored
  if (stored === null || sysfs === stored) return sysfs
  await fs.writeFileAsync(THRESHOLD_SYSFS, String(stored))
  return stored
}

// mkReactive instead of ags createPoll: createPoll exposes no setter and its
// timer is subscriber-gated — we need event-driven ticks (uevent → readAndHeal
// NOW) injected between the safety-net poll ticks.
let _threshState: ReturnType<typeof mkReactive<number>> | null = null
let _threshTick: (() => Promise<void>) | null = null
/** Whether the cap behind the closed icon's CAP SEGMENT has ever been
 *  VERIFIED — by a store answer or a real sysfs read. A host that can verify
 *  neither (the greeter's socket client: `fs` is denied and the owner's state
 *  file is not readable) must not paint the 100 fallback as a charge limit; the
 *  ring then shows the battery's percentage alone (see drawBatteryIcon). One
 *  piece of state with the seed above, hence module scope. */
let _capVerified = false
function thresholdState(
  config: AppletConfig,
  backend: AppletBackend,
): ReturnType<typeof mkReactive<number>> {
  if (!_threshState) {
    // Seed the closed icon's cap from the configured limit when the store can
    // already answer (the dock's file read is synchronous), else the ring's
    // resting value until the first tick lands — UNVERIFIED, so it paints no
    // cap segment until a real value arrives.
    const seeded = storedThreshold(backend.battery)
    _capVerified = seeded !== null
    _threshState = mkReactive(seeded ?? 100)
    let last: number | null = null
    const tick = async (): Promise<void> => {
      const v = await tickThreshold(backend.fs, backend.battery)
      if (v === null) return
      // A verification flip must repaint even when the NUMBER is unchanged: the
      // cap SEGMENT appears with "verified", not with the digit (the seed and
      // the real cap can both be 100).
      if (v === last && _capVerified) return
      last = v
      _capVerified = true
      _threshState?.set(v)
    }
    _threshTick = tick
    // Safety net (timing.poll.chargeThreshold, now 30s).
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, config.timing.poll.chargeThreshold, () => {
      void tick()
      return GLib.SOURCE_CONTINUE
    })
    // Event-driven heal: the asus_wmi reset happens on power events, which
    // fire a BAT0 `change` uevent — heal instantly instead of waiting for
    // the next poll tick. The heal's own sysfs write re-fires the uevent
    // once; the second tick is a no-op.
    backend.powerSupplyEvents.onPowerSupplyEvent(() => {
      void tick()
    })
    void tick()
  }
  return _threshState
}

export default function mount({ port, config, backend }: AppletContext): void {
  const bat = backend.battery.batteryState(config.timing.poll.batteryPower)
  const tlp = backend.tlp.tlpProfile(config.timing.poll.tlp)
  const threshold = thresholdState(config, backend)

  // The wattage READOUT (the `${n}W` digits) walks its digits from the old
  // reading to the new one through the shared value tick — the same walk the
  // performance applet's temperature readout uses. A wattage the domain
  // reports as absent (null: a failed read, the pre-poll seed) is not a
  // reading, so the glyph paints `--W` and the tick holds its last value.
  const wattTick = createValueTick({
    source: bat,
    read: (bs) => (bs.wattage === null || Number.isNaN(bs.wattage) ? null : Math.abs(bs.wattage)),
    widget: port.icon,
    config,
    deadband: 1,
    isVisible: () => !port.isHiddenState(),
  })
  onCleanup(() => wattTick.dispose())

  // The applet's ONE fade-eligible element: the ring arc the level policy
  // colours (see the level-arc block in drawBatteryIcon). Nothing else in this
  // applet fades — the wattage glyph, the charge-cap segment and the threshold
  // text are painted once per paint at full opacity.
  const levelArcFade = createElementFade<[number, number, number, number]>(port, config, "ring")
  onCleanup(() => levelArcFade.dispose())

  // Low-battery warning: the percentage whose DESCENT raises the notification
  // (appearance.thresholds.batteryNotifyPct, a level like the ring's own
  // batteryLow/batteryWarn). Both inputs are read at DECISION time, never
  // captured: `appearance` is a LIVE config tier whose set only redraws, and the
  // durable already-warned flag is the only state a SECOND mount of this applet
  // shares (the in-session lock screen mounts the same strip). Feeding happens
  // on battery CHANGES only, so the pre-poll seed is not a reading.
  const warnStore = lowWarningStore()
  const lowWarning = createLowWarningLatch({
    threshold: () => {
      const level = config.appearance.thresholds.batteryNotifyPct
      // A level that is not a number warns at nothing rather than inventing one:
      // -Infinity sits below every reading, so the step never reaches it.
      return Number.isFinite(level) ? level : Number.NEGATIVE_INFINITY
    },
    warned: () => {
      // The store's mirror is per process, so a false answer is re-read from the
      // file before a warning goes out: that read is how another surface's write
      // is seen. One small file read per battery change.
      if (warnStore.get(LOW_WARNING_KEY) === true) return true
      warnStore.reload()
      return warnStore.get(LOW_WARNING_KEY) === true
    },
    onWarn: (pct) => {
      warnStore.set(LOW_WARNING_KEY, true)
      // NORMAL urgency: `critical` is a zero-second timeout on this surface
      // (sticky until dismissed by hand), which a low battery at a configurable
      // level is not.
      notify({
        appName: "Battery",
        summary: "Battery low",
        body: `${Math.round(pct)}% remaining`,
      })
    },
    onRearm: () => {
      warnStore.set(LOW_WARNING_KEY, false)
    },
  })

  // Fully-charged counter: while the pack sits plugged-and-idle the glyph shows
  // how long it has been that way. The start time is DURABLE — the state began
  // when the pack BECAME idle, not when this process started — and the state rule
  // is the colour policy's own, so the counter and the ring cannot disagree about
  // it. The stamp's owner is the battery domain's machine-level store, because
  // the pre-login greeter paints this same counter over its own strip: every host
  // reads the ONE start time the session recorded (see
  // common/applets/domains/battery.ts).
  const nowSeconds = (): number => Math.floor(Date.now() / 1000)
  const chargeCounter = createChargeCounter({
    read: () => {
      const v = backend.battery.pluggedSinceStore.get(PLUGGED_SINCE_KEY)
      return typeof v === "number" ? v : 0
    },
    write: (epochSeconds) => {
      backend.battery.pluggedSinceStore.set(PLUGGED_SINCE_KEY, epochSeconds)
    },
  })
  /** The counter text the tick last painted, so a repaint happens only on a
   *  change: the text is what the eye sees, not the seconds behind it. */
  let counterText = ""

  const drawBatteryIcon: DrawIcon = (
    cr,
    w,
    h,
    value,
    _state,
    ringFill = 1,
    skipDisc = false,
    textValue = value,
  ) => {
    const size = config.layout.iconSize
    const cx = w / 2
    const cy = h / 2
    const thickness = config.appearance.ringThickness
    const radius = (size - thickness) / 2
    const bc = config.appearance.ringColours.battery
    const ct = (c: { rgb: number[]; alpha: number }): [number, number, number, number] =>
      [c.rgb[0], c.rgb[1], c.rgb[2], c.alpha] as [number, number, number, number]

    const bs = bat.peek()
    const batPct = Math.max(0, Math.min(bs.percentage, 100))
    const capPct = Math.max(0, Math.min(value, 100))

    const rf = clamp01(ringFill)
    const overlayAlpha = rf
    const pctTextAlpha = 1 - rf

    // ── Disc (always) ──
    if (!skipDisc) {
      drawDisc(config, cr, cx, cy, size / 2)
    }

    // ── Non-overlapping rings, drawn in declaration order ──
    if (overlayAlpha > 0.001) {
      const rings: RingSpec[] = []

      const chargeColour = ct(bc.charging)
      /** The battery's own percentage ring colour (the applet's threshold
       *  policy: charging / warn / low / ok), resolved by the shared policy
       *  every battery surface reads its colour through. */
      const pctColour = (pct: number): [number, number, number, number] =>
        ct(
          batteryRingColour(
            { percentage: pct, status: bs.status },
            config.appearance.thresholds,
            bc,
          ),
        )

      // The level-coloured arc: the ring segment the colour policy colours and
      // the applet's declared fade element. It is painted through the fade, so
      // ANY change of the colour this arc renders cross-fades — a level the
      // ring crosses (ok → warn → low), charging starting or stopping, the
      // charger being plugged or unplugged — while the constant segments beside
      // it (the charge-cap segment) paint once. The fade keys on that painted
      // colour itself: a colour change fades however it was caused.
      let arcEnd = batPct
      let arcPct = batPct

      if (!_capVerified) {
        // No VERIFIED charge limit: the ring paints the battery's percentage
        // and NO cap segment. The 100 fallback (the seed above) is not a
        // reading — painting it drew a 0.28-grey arc over pct→100 that no host
        // with a readable cap ever shows (the dock's cap equals its
        // percentage). The value itself stays available for the panel's limit
        // display; the difference is the segment, not the number.
      } else if (capPct > batPct) {
        rings.push({ start: batPct, end: capPct, colour: ct(bc.cap) })
      } else if (batPct > capPct) {
        rings.push({ start: capPct, end: batPct, colour: chargeColour })
        arcEnd = capPct
        arcPct = capPct
      }

      drawRings(cr, cx, cy, radius, thickness, rings, ringFill)
      levelArcFade.paint(pctColour(arcPct), (colour, alpha) =>
        drawRings(
          cr,
          cx,
          cy,
          radius,
          thickness,
          [{ start: 0, end: arcEnd, colour: withFadeAlpha(colour, alpha) }],
          ringFill,
        ),
      )

      // Wattage text (or idle icon when no power flow)
      const tlpColour = backend.tlp.tlpProfileColour(tlp.peek())
      const wc =
        config.appearance.batteryWattColours[tlpColour] ?? config.appearance.batteryWattColours.none
      const sh = config.appearance.textShadow
      const r = wc.rgb[0],
        g = wc.rgb[1],
        b = wc.rgb[2]

      const elapsed = chargeCounter.text(nowSeconds())
      if (elapsed) {
        // Fully-charged counter: the SAME metrics and the SAME wattage colour the
        // figure below uses, so only the CONTENT changes while the pack sits idle
        // on AC — the glyph takes no colour decision of its own.
        drawGlyph(
          config,
          cr,
          cx,
          cy,
          elapsed,
          config.fonts.labelSize,
          [r, g, b, 0.9 * overlayAlpha],
          undefined,
          sh.alpha * overlayAlpha,
        )
      } else if (bs.wattage === 0) {
        // Idle icon when no power flow (drawGlyph: shadow + foreground).
        drawGlyph(
          config,
          cr,
          cx,
          cy,
          config.appearance.icons.batteryIdle,
          config.fonts.iconSize,
          [r, g, b, 0.9 * overlayAlpha],
          undefined,
          sh.alpha * overlayAlpha,
        )
      } else {
        const wattage = bs.wattage
        const text =
          wattage !== null && !Number.isNaN(wattage) ? `${Math.round(wattTick.peek())}W` : "--W"
        drawGlyph(
          config,
          cr,
          cx,
          cy,
          text,
          config.fonts.labelSize,
          [r, g, b, 0.9 * overlayAlpha],
          undefined,
          sh.alpha * overlayAlpha,
        )
      }
    }

    // ── Threshold % text (fades in as ringFill→0) ──
    // Uses `textValue` (step-quantized) not `value`/`capPct` (float): the ring
    // cap glides smoothly, but the % text ticks in 5% steps (the panel's step).
    if (pctTextAlpha > 0.001) {
      const text = `${Math.round(textValue)}`
      const pt = config.appearance.pctTextColour
      drawGlyph(config, cr, cx, cy, text, config.fonts.labelSize, [
        pt.rgb[0],
        pt.rgb[1],
        pt.rgb[2],
        pt.alpha * 0.95 * pctTextAlpha,
      ])
    }
  }

  createContinuousApplet(port, {
    config,
    drawIcon: drawBatteryIcon,
    getState: () => false,
    getValue: () => threshold.peek(),
    setupSubscriptions: ({ redraw, sync }) => {
      onCleanup(
        bat.subscribe(() => {
          const bs = bat.peek()
          // Entering or leaving the plugged-and-idle state is a battery CHANGE,
          // so the counter is driven from the same subscription the glyph redraw
          // uses — never from a poll of its own.
          if (chargeCounter.observe(isPluggedIdle(bs.status), nowSeconds())) counterText = ""
          lowWarning.handle(bs)
          redraw()
        }),
      )
      // The counter's text moves with no battery event at all (a pack sitting
      // idle on AC sends none), so a 1 s tick — the cadence the power applet's own
      // elapsed readout uses (`timing.poll.uptime`) — recomputes it and repaints
      // ONLY when the text changed. Never a per-frame repaint, and nothing at all
      // while the state is not running.
      const counterTimer = setInterval(() => {
        if (!chargeCounter.active()) return
        const text = chargeCounter.text(nowSeconds())
        if (text === counterText) return
        counterText = text
        if (!port.isOpen() && !port.isHiddenState()) port.icon.queue_draw()
      }, config.timing.poll.uptime)
      onCleanup(() => clearInterval(counterTimer))
      onCleanup(tlp.subscribe(() => redraw()))
      // threshold → full sync (not just redraw): ringValue is seeded from the
      // poll's static default (100) at mount and only gets the real value when
      // the first async readAndHeal() resolves. sync() eases ringValue to the
      // new value so the closed icon's cap ring reflects the real threshold
      // without needing a hover. Mirrors Volume's vol→sync() wiring.
      onCleanup(threshold.subscribe(() => sync()))
    },
    buildPanel: ({ setDragActive, setPanelOh }) =>
      continuousPanel({
        config,
        setDragActive,
        setPanelOh,
        initialValue: threshold.peek(),
        onValue: (v) => {
          void applyThresholdAsync(backend.fs, backend.battery, v)
        },
        step: 5,
        // The charge-threshold sysfs write happens once on release, not per drag-update.
        commitOnRelease: true,
        externalIcon: port.icon,
        render: port.render,
        dockGeometry: port.geometry,
      }),
    logLabel: "battery",
  })
}
