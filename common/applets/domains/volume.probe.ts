/**
 * volume.probe — the volume domain as the applets backend serves it: the domain
 * is in the transport table (the request namespace and the socket both reach
 * it), its member shorthands resolve, the state carries `available` so a
 * process with no default sink — or one whose sink WirePlumber has not bound
 * yet — is not read as a zero level, and a write whose argument failed to
 * decode does not move the sink.
 *
 * Run:
 *   ags bundle --gtk 4 common/applets/domains/volume.probe.ts /tmp/volume-probe.sh
 *   bash /tmp/volume-probe.sh     # exit 1 on any violated invariant
 */
import AstalWp from "gi://AstalWp"
import GLib from "gi://GLib"
import { domainMembers, handleDomainRequest, resolveMember } from "@common/applets/host/transport"
import { setMuted, setVolume, sinkReady, volumeState } from "./volume.ts"

/** How long the probe lets the event loop run before judging the settled state:
 *  WirePlumber enumerates the default sink within ~10 ms of a fresh process. */
const BIND_SETTLE_MS = 200

/** Drive the default main context for `ms`, so the domain's bind signal and any
 *  armed timeout are delivered. The probe owns no main loop: a loop would block
 *  the promise drain that the discovery round trip below needs (gjs drains its
 *  promise jobs when the module body ends). */
const settle = (ms: number): void => {
  const deadline = GLib.get_monotonic_time() + ms * 1000
  while (GLib.get_monotonic_time() < deadline) GLib.MainContext.default().iteration(false)
}

const failures: string[] = []
const check = (name: string, ok: boolean): void => {
  if (!ok) failures.push(name)
}

// ── Readiness gate (`sinkReady`) ──
// WirePlumber answers a phantom endpoint (no id, no channels) for the first few
// ms of a fresh process and a bound one whose volume parameter has not landed
// (id set, channels still empty) one instant later; both read `volume: 0,
// muted: true`. Neither is a reading, and a real sink the user muted at 0 is.

const endpoint = (props: Record<string, unknown>): any => props
check("a not-yet-bound endpoint is not ready", !sinkReady(endpoint({ id: 0, channels: [] })))
check(
  "a bound endpoint whose volume parameter has not landed is not ready",
  !sinkReady(endpoint({ id: 73, channels: [] })),
)
check(
  "a bound endpoint with its channel volumes is ready",
  sinkReady(endpoint({ id: 73, channels: [{}, {}] })),
)
check(
  "a real sink muted at 0 is ready (a reading, not a missing sink)",
  sinkReady(endpoint({ id: 73, channels: [{}, {}], volume: 0, mute: true })),
)
check(
  "a virtual sink with no device is ready (a null device is not a tell)",
  sinkReady(endpoint({ id: 40, channels: [{}], device: null })),
)
check("a negative id is not ready", !sinkReady(endpoint({ id: -1, channels: [{}] })))
check("a missing endpoint is not ready", !sinkReady(null) && !sinkReady(undefined))
check(
  "an endpoint whose id read throws is not ready",
  !sinkReady(
    Object.defineProperty({ channels: [{}] }, "id", {
      get() {
        throw new Error("endpoint gone")
      },
    }),
  ),
)

// ── The domain is SERVED (the request surface resolves its members) ──

const members = domainMembers("volume")
for (const m of ["volumeState", "setVolume", "setMuted"]) {
  check(`the transport table serves volume ${m}`, members.includes(m))
}
check(
  "the shorthand `state` resolves to volumeState",
  resolveMember("volume", "state").name === "volumeState",
)
check("an unknown member does not resolve", resolveMember("volume", "nope").name === "")

// ── The state contract ──
// Sampled at the probe's first possible turn: in a fresh process this is the
// PRE-SETTLE case, which must never be published as an available sink.

const state = volumeState(30000).peek()
const endpointNow = (): any => {
  try {
    return AstalWp.get_default()?.defaultSpeaker ?? null
  } catch (_e) {
    return null
  }
}
check(
  "an available state is always backed by a ready endpoint (never the phantom)",
  !state.available || sinkReady(endpointNow()),
)
check(
  "an unavailable state carries no sink level or mute (the placeholder shape)",
  state.available || (state.volume === 0 && state.muted === false),
)
if (state.available) {
  const level = Math.max(0, Math.min(100, Math.round((endpointNow()?.volume ?? Number.NaN) * 100)))
  check(
    `the first real reading matches the sink (${state.volume}% vs ${level}%)`,
    state.volume === level,
  )
}
check("the state reports availability", typeof state.available === "boolean")
check("the level is a 0..100 number", state.volume >= 0 && state.volume <= 100)
check("mute is a boolean", typeof state.muted === "boolean")
check(
  "the device class is one of the four kinds",
  ["bluetooth", "usb", "headset", "speaker"].includes(state.kind),
)

// ── An undecodable argument never moves the sink ──
// Both calls below are the shapes a request with a missing/bad base64 argument
// produces. They must be no-ops: the reading has to be identical afterwards.

const before = volumeState(30000).peek()
setVolume(Number.NaN)
setMuted(undefined as unknown as boolean)
const after = volumeState(30000).peek()
check(
  `an undecodable argument leaves the sink alone (level ${before.volume} → ${after.volume})`,
  before.volume === after.volume && before.muted === after.muted,
)

void (async () => {
  // Discovery goes through the REAL handler, so the request surface is proven
  // to serve the domain rather than merely to have a table entry.
  const reply = JSON.parse(await handleDomainRequest("volume", []))
  check("the request surface answers a volume discovery", reply.ok === true)
  check(
    "the discovery lists the members",
    JSON.stringify(reply.value?.members ?? []).includes("volumeState"),
  )

  // Let the main context hand the domain its bind signal: an endpoint ready by
  // now must have been published as a real reading. Readiness is sampled FIRST,
  // so a sink binding inside this block can only skip the assertion, never fail
  // it.
  settle(BIND_SETTLE_MS)
  const bound = sinkReady(endpointNow())
  const settled = volumeState(30000).peek()
  check("a ready sink is published as an available reading", !bound || settled.available)
  check("the settled reading is never the phantom shape", !settled.available || bound)
  if (settled.available) {
    const level = Math.max(
      0,
      Math.min(100, Math.round((endpointNow()?.volume ?? Number.NaN) * 100)),
    )
    check(
      `the published level tracks the sink (${settled.volume}% vs ${level}%)`,
      settled.volume === level,
    )
  }

  console.log()
  if (failures.length > 0) {
    console.log(`FAIL — ${failures.length} violated invariant(s):`)
    for (const f of failures) console.log(`  - ${f}`)
    imports.system.exit(1)
  }
  console.log(
    `OK — the volume domain is served (${members.length} members), the readiness gate rejects ` +
      `the pre-settle endpoint, and its state contract holds` +
      (settled.available
        ? ` — live sink at ${settled.volume}%`
        : " — no usable sink in this process"),
  )
  imports.system.exit(0)
})()
