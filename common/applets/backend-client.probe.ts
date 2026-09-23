/**
 * backend-client.probe — the memo/latch contract of `createAppletBackendClient`.
 *
 * A colour member answers `"none"` (a white glyph) until its fetch lands, and
 * no member stays stuck on that placeholder once the backend has answered the
 * same arguments. Two defects are asserted here — both reachable with a stub
 * transport, no restart and no lock:
 *   (a) CONSTRUCTION: a member reached through `syncMember(…)(args)` builds its
 *       memo/inflight ONCE — a fresh memo per call answers the placeholder on
 *       every call and issues one request per call (no dedup, no latch).
 *   (b) LATCH: a fetch that never settles holds its inflight key, so the member
 *       cannot retry until the deadline releases it.
 * A hoisted member (`power isInhibitActive`) is the control: it must dedup from
 * the first call, exactly like a correctly constructed colour member.
 *
 * Run: ags run --gtk 4 common/applets/backend-client.probe.ts
 */
import GLib from "gi://GLib"
import { createAppletBackendClient } from "@common/applets/backend-client"
import type { Envelope } from "@common/applets/backend-protocol"

const results: string[] = []
let failed = false

function check(label: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failed = true
}

const counts = new Map<string, number>()
const ANSWERS: Record<string, unknown> = {
  "system gpuColour": "yellow",
  "tlp tlpProfileColour": "yellow",
  "battery batteryColour": "yellow",
  "power isInhibitActive": true,
}

/** A stub backend: optionally never settles (the stuck-fetch shape). */
function stubTransport(opts: { stall?: boolean } = {}): {
  invoke: (domain: string, member: string, args: unknown[]) => Promise<Envelope>
} {
  return {
    invoke: (domain, member) => {
      const label = `${domain} ${member}`
      counts.set(label, (counts.get(label) ?? 0) + 1)
      if (opts.stall) return new Promise<Envelope>(() => {})
      return new Promise<Envelope>((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
          resolve({ ok: true, value: ANSWERS[label] ?? null } as Envelope)
          return GLib.SOURCE_REMOVE
        })
      })
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve()
      return GLib.SOURCE_REMOVE
    })
  })
}

async function main(): Promise<void> {
  // ── (a) construction: a per-call member can never latch its answer ──
  const backend = createAppletBackendClient({ transport: stubTransport() })
  const first = [
    backend.system.gpuColour("suspended"),
    backend.system.gpuColour("suspended"),
    backend.system.gpuColour("suspended"),
  ]
  const callsBeforeAnswer = counts.get("system gpuColour") ?? 0
  check(
    "gpuColour dedups to ONE request for the same args",
    callsBeforeAnswer === 1,
    `issued ${callsBeforeAnswer} request(s)`,
  )
  check(
    "every call before the answer is the placeholder",
    first.every((v) => v === "none"),
    JSON.stringify(first),
  )

  // ── control: a hoisted member (correct construction) ──
  const ctl1 = backend.power.isInhibitActive()
  const ctl2 = backend.power.isInhibitActive()
  const ctlCalls = counts.get("power isInhibitActive") ?? 0
  check("hoisted member dedups too", ctlCalls === 1, `issued ${ctlCalls} request(s)`)
  check("hoisted member placeholder before the answer", ctl1 === false && ctl2 === false)

  await sleep(200)

  // ── the answer must LATCH for every caller after it lands. The stub answers
  // "yellow" everywhere: distinct from all three placeholders, so a placeholder
  // can never masquerade as a latched answer. ──
  const missRound = [
    backend.system.gpuColour("suspended"), // asked above → already answered
    backend.tlp.tlpProfileColour("power-saver"), // first ask
    backend.battery.batteryColour(50, { batteryLow: 15, batteryWarn: 30 }), // first ask
  ]
  await sleep(200)
  const hitRound = [
    backend.system.gpuColour("suspended"),
    backend.tlp.tlpProfileColour("power-saver"),
    backend.battery.batteryColour(50, { batteryLow: 15, batteryWarn: 30 }),
  ]
  check(
    "a first ask (fetch outstanding) answers the placeholder",
    missRound[1] === "none" && missRound[2] === "green",
    JSON.stringify(missRound),
  )
  check(
    "gpuColour latches the backend answer",
    hitRound[0] === "yellow",
    `got ${JSON.stringify(hitRound[0])}`,
  )
  check(
    "tlpProfileColour latches the backend answer",
    hitRound[1] === "yellow",
    `got ${JSON.stringify(hitRound[1])}`,
  )
  check(
    "batteryColour latches the backend answer",
    hitRound[2] === "yellow",
    `got ${JSON.stringify(hitRound[2])}`,
  )
  check("hoisted member latches the backend answer", backend.power.isInhibitActive() === true)

  // ── (b) latch: a stalled fetch must be released so the next tick retries ──
  const stalled = createAppletBackendClient({ transport: stubTransport({ stall: true }) })
  const base = counts.get("power isInhibitActive") ?? 0
  stalled.power.isInhibitActive()
  await sleep(3000)
  const duringStall = (counts.get("power isInhibitActive") ?? 0) - base
  check(
    "a stalled fetch is deduped while outstanding",
    duringStall === 1,
    `${duringStall} request(s) during the 3s stall`,
  )
  const released = await (async () => {
    for (let i = 0; i < 42; i++) {
      await sleep(1000)
      if ((counts.get("power isInhibitActive") ?? 0) - base > 1) return i + 4
    }
    return 0
  })()
  check(
    "a stalled fetch is released (deadline) so the member can retry",
    released > 0,
    released ? `retried after ~${released}s` : "still latched after 45s",
  )
}

const loop = GLib.MainLoop.new(null, false)
void (async () => {
  await main()
})()
  .catch((e) => {
    failed = true
    results.push(`FAIL probe crashed: ${String(e)}`)
  })
  .finally(() => {
    console.log(results.join("\n"))
    console.log(failed ? "[probe] RESULT: FAIL" : "[probe] RESULT: PASS")
    loop.quit()
  })
loop.run()
imports.system.exit(failed ? 1 : 0)
