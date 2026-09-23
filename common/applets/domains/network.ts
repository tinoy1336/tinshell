import { mkReactive, type Reactive } from "@common/applets/utils/reactive"
import { readFileAsync } from "./fs"

// ── Configurable constants ──
const POLL_INTERVAL_MS = 1500

/** Throughput-ring scaling: the adaptive ceiling never drops below `floor`,
 *  and the windowed max spans `windowSeconds` of samples. Both are the
 *  caller's (the wifi applet reads them from its host config). */
export interface NetScale {
  floor: number
  windowSeconds: number
}

// ── Types ──

export interface NetState {
  down: number // bits/sec download (0 when idle)
  up: number // bits/sec upload
  downRing: number // 0-100 for ring display
  upRing: number // 0-100
}

// ── reactive container ──

type NetReactive = Reactive<NetState>

let state: NetReactive | null = null

// ── Interface discovery ──

let iface: string | null = null

async function findIface(): Promise<string | null> {
  if (iface !== null) return iface
  // Read /proc/net/dev and pick the first non-lo interface with traffic.
  const dev = await readFileAsync("/proc/net/dev")
  if (!dev) return null
  for (const line of dev.split("\n")) {
    const m = line.trim().match(/^([a-z0-9]+):\s+(\d+)/)
    if (m && m[1] !== "lo") {
      iface = m[1]
      return iface
    }
  }
  return null
}

// ── Counter reading ──

// /proc/net/dev line format:
// iface: rx_bytes rx_packets ... tx_bytes tx_packets ...
// The first number after the colon is rx_bytes, the 9th is tx_bytes.
function parseCounters(line: string): [number, number] | null {
  const m = line
    .trim()
    .match(/^[a-z0-9]+:\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10)]
}

async function readCounters(name: string): Promise<[number, number] | null> {
  const dev = await readFileAsync("/proc/net/dev")
  if (!dev) return null
  for (const line of dev.split("\n")) {
    if (line.trim().startsWith(name + ":")) {
      return parseCounters(line)
    }
  }
  return null
}

// ── Windowed max ceiling ──

const downWindow: number[] = []
const upWindow: number[] = []

function windowSize(scale: NetScale): number {
  return Math.max(1, Math.round(scale.windowSeconds / (POLL_INTERVAL_MS / 1000)))
}
let prevRx = 0
let prevTx = 0
let prevTime = 0
let firstPoll = true

function resetCounters(rx: number, tx: number, now: number): void {
  prevRx = rx
  prevTx = tx
  prevTime = now
  firstPoll = false
}

function tick(rx: number, tx: number, now: number, scale: NetScale): NetState {
  const elapsed = (now - prevTime) / 1_000_000 // microseconds → seconds
  let downBps = 0
  let upBps = 0

  if (firstPoll || elapsed <= 0) {
    resetCounters(rx, tx, now)
    return { down: 0, up: 0, downRing: 0, upRing: 0 }
  }

  // Handle counter wraparound (unlikely for 64-bit counters but defensive).
  const rxDelta = rx >= prevRx ? rx - prevRx : 0
  const txDelta = tx >= prevTx ? tx - prevTx : 0
  downBps = Math.round((rxDelta * 8) / elapsed)
  upBps = Math.round((txDelta * 8) / elapsed)
  resetCounters(rx, tx, now)

  // Adaptive ceiling: windowed max of recent samples.
  // Rises instantly (new high), drops when the peak ages out of the window.
  downWindow.push(downBps)
  upWindow.push(upBps)
  const maxLen = windowSize(scale)
  while (downWindow.length > maxLen) downWindow.shift()
  while (upWindow.length > maxLen) upWindow.shift()

  const ceilingDown = Math.max(...downWindow, scale.floor)
  const ceilingUp = Math.max(...upWindow, scale.floor)

  const downRing = Math.min(100, Math.round((downBps / ceilingDown) * 100))
  const upRing = Math.min(100, Math.round((upBps / ceilingUp) * 100))

  return { down: downBps, up: upBps, downRing, upRing }
}

// ── Poll ──

async function poll(store: { set: (v: NetState) => void }, scale: NetScale): Promise<void> {
  const name = await findIface()
  if (!name) return
  const counters = await readCounters(name)
  if (!counters) return
  const now = Date.now() * 1000 // microseconds
  store.set(tick(counters[0], counters[1], now, scale))
}

// ── Public API ──

export function netState(scale: NetScale, shouldPoll?: () => boolean): NetReactive {
  if (!state) {
    const rs = mkReactive<NetState>({ down: 0, up: 0, downRing: 0, upRing: 0 })
    state = rs
    // First poll immediately to seed counters, then at the configured interval.
    void poll(rs, scale)
    setInterval(() => {
      // Skip the /proc reads (and thus the ring-smoother redraw bursts) while
      // the wifi applet is parked in overflow — the rate ring is invisible on
      // a hidden icon. The timer stays alive; the gate just cheapens the tick.
      if (shouldPoll?.() ?? true) void poll(rs, scale)
    }, POLL_INTERVAL_MS)
  }
  return state
}
