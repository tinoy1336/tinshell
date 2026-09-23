import { createPoll } from "ags/time"
import { listDir, readFile, readFileAsync } from "./fs"

async function readCpuStats(): Promise<{ idle: number; total: number }> {
  const data = await readFileAsync("/proc/stat")
  const lines = data.split("\n")
  let totalIdle = 0
  let totalBusy = 0

  for (const line of lines) {
    if (!line.startsWith("cpu") || line.startsWith("cpu ")) continue
    const cols = line.trim().split(/\s+/)
    const user = parseInt(cols[1]) || 0
    const nice = parseInt(cols[2]) || 0
    const system = parseInt(cols[3]) || 0
    const idle = parseInt(cols[4]) || 0
    const iowait = parseInt(cols[5]) || 0
    const irq = parseInt(cols[6]) || 0
    const softirq = parseInt(cols[7]) || 0
    const steal = parseInt(cols[8]) || 0

    totalIdle += idle + iowait
    totalBusy += user + nice + system + irq + softirq + steal
  }

  const total = totalIdle + totalBusy
  return { idle: totalIdle, total }
}

function findCpuTemp(): string | null {
  const hwmonRoot = "/sys/class/hwmon"
  const dirs = listDir(hwmonRoot)

  for (const dir of dirs) {
    const namePath = `${hwmonRoot}/${dir}/name`
    const name = readFile(namePath)
    if (name === "k10temp" || name === "coretemp" || name === "cpu_thermal") {
      const hwmonFiles = listDir(`${hwmonRoot}/${dir}`)
      for (const f of hwmonFiles) {
        if (f.startsWith("temp") && f.endsWith("_input")) {
          return `${hwmonRoot}/${dir}/${f}`
        }
      }
    }
  }
  return null
}

let _cpuPoll: ReturnType<typeof createPoll<number>> | null = null
export function cpuUtilization(intervalMs: number = 3000) {
  if (!_cpuPoll) {
    // Seed prev synchronously once at mount so the first tick has a baseline;
    // subsequent ticks read async inside the poll fn (never block the loop).
    let prev = { idle: 0, total: 0 }
    _cpuPoll = createPoll(0, intervalMs, async () => {
      const curr = await readCpuStats()
      const idleDelta = curr.idle - prev.idle
      const totalDelta = curr.total - prev.total
      prev = curr
      if (totalDelta === 0) return 0
      return Math.round((1 - idleDelta / totalDelta) * 100)
    })
  }
  return _cpuPoll
}

let _tempPoll: ReturnType<typeof createPoll<number | null>> | null = null
export function cpuTemperature(intervalMs: number = 3000) {
  if (!_tempPoll) {
    const tempPath = findCpuTemp()
    _tempPoll = createPoll(null as number | null, intervalMs, async () => {
      if (!tempPath) return null
      const raw = await readFileAsync(tempPath)
      const val = parseInt(raw)
      return isNaN(val) ? null : val / 1000
    })
  }
  return _tempPoll
}

// ── RAM ──

async function readMemInfo(): Promise<{ total: number; available: number }> {
  const data = await readFileAsync("/proc/meminfo")
  let total = 0
  let available = 0
  for (const line of data.split("\n")) {
    if (line.startsWith("MemTotal:")) total = parseInt(line.match(/\d+/)![0]) || 0
    else if (line.startsWith("MemAvailable:")) available = parseInt(line.match(/\d+/)![0]) || 0
    if (total > 0 && available > 0) break
  }
  return { total, available }
}

let _ramPoll: ReturnType<typeof createPoll<number>> | null = null
export function ramUtilization(intervalMs: number = 5000) {
  if (!_ramPoll) {
    _ramPoll = createPoll(0, intervalMs, async () => {
      const { total, available } = await readMemInfo()
      if (total === 0) return 0
      return Math.round((1 - available / total) * 100)
    })
  }
  return _ramPoll
}
