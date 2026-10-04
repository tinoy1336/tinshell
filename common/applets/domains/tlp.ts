import GLib from "gi://GLib"
import type { TlpProfile } from "@common/applets/types"
import { mkReactive, type Reactive } from "@common/applets/utils/reactive"
import { runCb } from "@common/subprocess/run"
import { onProfileChanged, readProfile } from "./power-profile"

let cached: TlpProfile = "balanced"
let inflight = false

/** Whether the LAST primary read named a profile. `false` means the daemon did
 *  not answer, which is the only case the `tlp-stat` fallback exists for. */
let primaryAnswered = false

/** tlp-stat fallback refresh. Used ONLY by the safety net — the primary
 *  source is the PowerProfiles PropertiesChanged signal (see below), which
 *  feeds readProfile() (a DBus Get, cheaper and more authoritative than a
 *  tlp-stat subprocess). */
function refreshAsync(onDone?: (p: TlpProfile) => void): void {
  if (inflight) return
  inflight = true

  runCb("tlp-stat -s", (text) => {
    if (text.includes("performance")) cached = "performance"
    else if (text.includes("power-saver") || text.includes("powersave")) cached = "power-saver"
    else if (text.includes("balanced")) cached = "balanced"
    else {
      const modeMatch = text.match(/Mode:\s*(.+)/)
      if (modeMatch) {
        const mode = modeMatch[1].trim().toLowerCase()
        if (mode.includes("performance")) cached = "performance"
        else if (mode.includes("power")) cached = "power-saver"
        else if (mode.includes("balanced") || mode.includes("default")) cached = "balanced"
      }
    }
    inflight = false
    onDone?.(cached)
  })
}

// ── reactive state ──
// mkReactive instead of ags createPoll: createPoll exposes no setter and its
// timer is subscriber-gated — the DBus signal must inject between safety-net
// ticks.
let _tlpState: ReturnType<typeof mkReactive<TlpProfile>> | null = null
let _tlpLast: TlpProfile = "balanced"

/** TLP/power-profile state. PRIMARY: PowerProfiles PropertiesChanged (DBus)
 *  → instant on every ActiveProfile set (ours + external). FALLBACK: while that
 *  read reports `unknown` (the daemon is absent or not answering — readProfile
 *  no longer hides it behind "balanced"), each `intervalMs` (timing.poll.tlp)
 *  tick runs `tlp-stat -s`, which reads TLP's own state from disk and still
 *  tells the truth. On a healthy daemon the fallback never runs: it starts ~53
 *  programs to re-learn a value the signal already delivered. */
export function tlpProfile(intervalMs: number = 30000): Reactive<TlpProfile> {
  if (!_tlpState) {
    _tlpState = mkReactive(cached)
    const apply = (p: TlpProfile): void => {
      if (p === "unknown") return
      if (p === _tlpLast) return
      _tlpLast = p
      cached = p
      _tlpState?.set(p)
    }
    /** The primary read, and the signal that triggers it. Its RESULT arms the
     *  fallback below — the fallback is never armed by the timer alone. */
    const primary = (): void => {
      void readProfile().then((p) => {
        primaryAnswered = p !== "unknown"
        apply(p)
      })
    }
    onProfileChanged(primary)
    // The signal fires only on CHANGE, so one read at mount seeds the state
    // (otherwise it sits on the `balanced` seed until the first tick).
    primary()
    // Fallback: `tlp-stat -s` starts ~53 programs, so it runs only while the
    // primary source is not answering.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
      if (!primaryAnswered) refreshAsync(apply)
      return GLib.SOURCE_CONTINUE
    })
  }
  return _tlpState
}

export function tlpProfileColour(profile: TlpProfile): string {
  switch (profile) {
    case "performance":
      return "red"
    case "power-saver":
      return "green"
    default:
      return "none"
  }
}
