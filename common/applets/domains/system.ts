import type { GpuColour } from "@common/applets/types"
import { createPoll } from "ags/time"
import { listDir, readFile, readFileAsync } from "./fs"

// ── GPU ──

function findGpuRuntimePath(): string | null {
  const pciRoot = "/sys/bus/pci/devices"
  for (const d of listDir(pciRoot)) {
    if (readFile(`${pciRoot}/${d}/vendor`) === "0x10de") {
      const p = `${pciRoot}/${d}/power/runtime_status`
      if (readFile(p)) return p
    }
  }
  return null
}

let gpuPath: string | null | undefined
function getGpuPath() {
  if (gpuPath === undefined) gpuPath = findGpuRuntimePath()
  return gpuPath
}

export function gpuColour(status: string | null): GpuColour {
  if (!status) return "none"
  if (status === "active") return "red"
  if (status === "suspended") return "green"
  return "yellow"
}

async function readGpuStatus(): Promise<string | null> {
  const p = getGpuPath()
  if (!p) return null
  const v = await readFileAsync(p)
  return v || null
}

// ── Uptime ──

/** Seconds since boot, or null when /proc/uptime did not read to a number.
 *  A PULLED member, not a poll: it is a timestamp, and the caller's own timer
 *  drives the cadence. It exists as a member because the socket surface never
 *  exposes the `fs` domain, so a different-user host (the greeter) has no other
 *  route to this value. */
export async function systemUptime(): Promise<number | null> {
  const raw = await readFileAsync("/proc/uptime")
  const seconds = parseFloat(raw.split(" ")[0])
  return Number.isFinite(seconds) ? seconds : null
}

// ── Synchronized poll ──

interface GpuTick {
  gpuStatus: string | null
}

let _tick: ReturnType<typeof createPoll<GpuTick>> | null = null
export function systemTick(intervalMs: number = 1000) {
  if (!_tick)
    _tick = createPoll<GpuTick>({ gpuStatus: null }, intervalMs, async () => {
      const gpuStatus = await readGpuStatus()
      return { gpuStatus }
    })
  return _tick
}
