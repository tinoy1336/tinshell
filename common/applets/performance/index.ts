import GLib from "gi://GLib"
import type { AppletBackend } from "@common/applets/backend"
import type { AppletConfig } from "@common/applets/config"
import { createStepApplet } from "@common/applets/shared/create-step-applet"
import type { OverlapRing } from "@common/applets/shared/draw-utils"
import { clamp01, drawDisc, drawOverlapRings, layoutBox } from "@common/applets/shared/draw-utils"
import { createValueTick } from "@common/applets/shared/value-tick"
import type { AppletContext, DrawIcon, GpuColour, TlpProfile } from "@common/applets/types"
import { createSmoother } from "@common/applets/utils/smoother"
import { onCleanup } from "gnim"

// ── Profile ↔ step mapping (step 0 = Auto) ──

function readAutoMode(powerProfile: AppletBackend["powerProfile"]): boolean {
  const am = powerProfile.autoProfileStore.get("autoProfile")
  return am === true
}

function writeAutoMode(powerProfile: AppletBackend["powerProfile"], on: boolean): void {
  powerProfile.autoProfileStore.set("autoProfile", on)
}

function profileToStep(p: TlpProfile): number {
  switch (p) {
    case "power-saver":
      return 1
    case "balanced":
      return 2
    case "performance":
      return 3
    default:
      return 2
  }
}

function stepToProfile(s: number): TlpProfile {
  switch (s) {
    case 1:
      return "power-saver"
    case 2:
      return "balanced"
    case 3:
      return "performance"
    default:
      return "balanced"
  }
}

async function readAcOnline(fs: AppletBackend["fs"]): Promise<boolean> {
  // ASUS-specific: the AC supply is named AC0 on this laptop. On machines with
  // a different supply name this reads "" → false (treated as on battery).
  return (await fs.readFileAsync("/sys/class/power_supply/AC0/online")) === "1"
}

const stepDefs = (config: AppletConfig): { label: string; emoji: string }[] => [
  { label: "Auto", emoji: config.appearance.icons.autoProfile },
  { label: "Powersave", emoji: config.appearance.icons.powerSaver },
  { label: "Balanced", emoji: config.appearance.icons.balanced },
  { label: "Performance", emoji: config.appearance.icons.performanceProfile },
]

// ── Ring colour ──

function ringColour(cpuPct: number, config: AppletConfig): [number, number, number, number] {
  const ring = config.appearance.ringColours.cpu
  const t = config.appearance.thresholds
  const c = cpuPct > t.cpuHigh ? ring.high : cpuPct > t.cpuMid ? ring.mid : ring.low
  return [c.rgb[0], c.rgb[1], c.rgb[2], c.alpha]
}

// ── Temperature text (alpha'd via ringFill) ──

function gpuRgba(gpucolour: GpuColour, config: AppletConfig): [number, number, number, number] {
  const c = config.appearance.performanceTempColours[gpucolour]
  return [c.rgb[0], c.rgb[1], c.rgb[2], c.alpha]
}

function drawTempText(
  config: AppletConfig,
  cr: any,
  w: number,
  h: number,
  cpuTemp: number | null,
  gpucolour: GpuColour,
  alpha: number,
): void {
  if (alpha < 0.001) return
  const { cx, cy } = layoutBox(w, h)
  const sh = config.appearance.textShadow

  const [r, g, b, baseA] = gpuRgba(gpucolour, config)
  const a = baseA * alpha

  const num = cpuTemp === null ? "--" : `${Math.round(cpuTemp)}`
  const deg = "°"

  cr.selectFontFace(config.fonts.family, 0, 0)
  cr.setFontSize(config.fonts.labelSize)
  const numExt = cr.textExtents(num)
  const numX = cx - numExt.width / 2 - numExt.xBearing - 1
  const numY = cy - numExt.height / 2 - numExt.yBearing

  // Shadow
  cr.setSourceRGBA(sh.rgb[0], sh.rgb[1], sh.rgb[2], a * sh.alpha)
  cr.moveTo(numX + sh.offset, numY + sh.offset)
  cr.showText(num)
  // Main
  cr.setSourceRGBA(r, g, b, a)
  cr.moveTo(numX, numY)
  cr.showText(num)

  // Degree symbol
  cr.setFontSize(config.fonts.degreeSize)
  cr.setSourceRGBA(sh.rgb[0], sh.rgb[1], sh.rgb[2], a * sh.alpha)
  cr.moveTo(numX + numExt.width + 1, numY + 1 - 2)
  cr.showText(deg)
  cr.setSourceRGBA(r, g, b, a)
  cr.moveTo(numX + numExt.width, numY - 2)
  cr.showText(deg)
}

export default function mount({ port, config, backend }: AppletContext): void {
  const cpu = backend.cpu.cpuUtilization(config.timing.poll.cpu)
  const ram = backend.cpu.ramUtilization(config.timing.poll.ram)
  const temp = backend.cpu.cpuTemperature(config.timing.poll.temp)
  const sys = backend.system.systemTick()

  // Dock-hidden predicate: a ghosted dock must not keep the 60fps ring
  // redraw alive (the smoother stops its frame loop while hidden).
  const visible = (): boolean => !port.isHiddenState()

  // Re-kick deadband per ring smoother: track the last value that kicked; small
  // poll jitter below the threshold never restarts the frame loop.
  let lastCpu = cpu.peek()
  let lastRam = ram.peek()

  const cpuSmooth = createSmoother(
    () => cpu.peek(),
    port.icon,
    config,
    config.timing.poll.cpu,
    2.0,
    visible,
  )
  const ramSmooth = createSmoother(
    () => ram.peek(),
    port.icon,
    config,
    config.timing.poll.ram,
    2.0,
    visible,
  )
  // The temperature READOUT (the digits in the disc) walks its digits from the
  // old reading to the new one through the shared value tick; the two rings
  // above are RING values and the smoother eases them directly.
  const tempTick = createValueTick({
    source: temp,
    read: (v) => v ?? 0,
    widget: port.icon,
    config,
    deadband: 1.0,
    isVisible: visible,
  })
  onCleanup(() => tempTick.dispose())

  // Seed with defaults; an immediate async refresh at mount populates the real
  // values so no I/O blocks startup. Redrawn when the refresh lands.
  let profile: TlpProfile = "balanced"
  let autoMode = false
  let autoPollId: number | null = null

  function refreshInitial(): void {
    Promise.all([backend.powerProfile.readProfile(), readAutoMode(backend.powerProfile)]).then(
      ([p, am]) => {
        profile = p
        autoMode = am
        if (autoMode) startAutoPoll()
        port.icon.queue_draw()
      },
    )
  }

  function startAutoPoll() {
    if (autoPollId !== null) return
    autoPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, config.timing.poll.autoProfile, () => {
      if (!autoMode) {
        autoPollId = null
        return GLib.SOURCE_REMOVE
      }
      void Promise.all([readAcOnline(backend.fs), backend.powerProfile.readProfile()]).then(
        ([onAc, current]) => {
          if (!autoMode) return // may have switched off mid-await
          const target: TlpProfile = onAc ? "balanced" : "power-saver"
          if (current !== target) backend.powerProfile.writeProfile(target)
        },
      )
      return GLib.SOURCE_CONTINUE
    })
  }

  function stopAutoPoll() {
    if (autoPollId !== null) {
      GLib.source_remove(autoPollId)
      autoPollId = null
    }
  }

  const drawPerformanceIcon: DrawIcon = (
    cr,
    w,
    h,
    _value,
    _state,
    ringFill = 1,
    skipDisc = false,
    _textValue,
  ) => {
    const rf = clamp01(ringFill)
    const { cx, cy } = layoutBox(w, h)
    if (!skipDisc) {
      drawDisc(config, cr, cx, cy, Math.min(w, h) / 2)
    }
    if (rf > 0.001) {
      const thickness = config.appearance.ringThickness
      const radius = (Math.min(w, h) - thickness) / 2
      const cpuPct = cpuSmooth.peek()
      const ramPct = ramSmooth.peek()
      const cpuColour = ringColour(cpuPct, config)
      const ramRing = config.appearance.ringColours.ram
      const ramColour: [number, number, number, number] = [
        ramRing.rgb[0],
        ramRing.rgb[1],
        ramRing.rgb[2],
        ramRing.alpha,
      ]
      const rings: OverlapRing[] = [
        { value: cpuPct, colour: cpuColour },
        { value: ramPct, colour: ramColour },
      ]
      drawOverlapRings(cr, cx, cy, radius, thickness, rings, -Math.PI / 2, rf)
    }
    drawTempText(
      config,
      cr,
      w,
      h,
      tempTick.peek(),
      backend.system.gpuColour(sys.peek().gpuStatus),
      rf,
    )
  }

  onCleanup(
    cpu.subscribe(() => {
      if (!visible()) return
      const v = cpu.peek()
      if (Math.abs(v - lastCpu) > 2.0) {
        lastCpu = v
        cpuSmooth.kick()
      }
    }),
  )
  onCleanup(
    ram.subscribe(() => {
      if (!visible()) return
      const v = ram.peek()
      if (Math.abs(v - lastRam) > 2.0) {
        lastRam = v
        ramSmooth.kick()
      }
    }),
  )
  onCleanup(
    sys.subscribe(() => {
      if (visible()) port.icon.queue_draw()
    }),
  )

  const handle = createStepApplet(port, {
    config,
    steps: stepDefs(config),
    getStepColour: (i) => config.appearance.stepColours.performance[i],
    getInitialStep: () => (autoMode ? 0 : profileToStep(profile)),
    drawIcon: drawPerformanceIcon,
    onSelect: (step) => {
      if (step === 0) {
        autoMode = true
        writeAutoMode(backend.powerProfile, true)
        startAutoPoll()
        void readAcOnline(backend.fs).then((onAc) =>
          backend.powerProfile.writeProfile(onAc ? "balanced" : "power-saver"),
        )
      } else {
        autoMode = false
        writeAutoMode(backend.powerProfile, false)
        stopAutoPoll()
        profile = stepToProfile(step)
        backend.powerProfile.writeProfile(profile)
      }
    },
    logLabel: "performance",
  })

  // TLP profile drift watcher: when not in auto mode, watch for profile
  // changes and reflect them in the open panel. PRIMARY: the PowerProfiles
  // PropertiesChanged signal (instant, covers ours + external writes);
  // SAFETY NET: timing.poll.tlp (now 30s) backend.powerProfile.readProfile for missed signals.
  const driftCheck = (): void => {
    if (!autoMode) {
      void backend.powerProfile.readProfile().then((newProfile) => {
        if (autoMode) return
        if (newProfile !== profile) {
          profile = newProfile
          handle.externalChange(profileToStep(newProfile))
        }
      })
    }
  }
  onCleanup(backend.powerProfile.onProfileChanged(driftCheck))
  const profilePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, config.timing.poll.tlp, () => {
    driftCheck()
    return GLib.SOURCE_CONTINUE
  })
  onCleanup(() => {
    GLib.source_remove(profilePollId)
    stopAutoPoll()
  })

  refreshInitial()
}
