import GLib from "gi://GLib"
import type { TlpProfile } from "@common/applets/types"
import { mkReactive, type Reactive } from "@common/applets/utils/reactive"
import { runCb } from "@common/subprocess/run"
import { onProfileChanged, readProfile } from "./power-profile"

let cached: TlpProfile = "balanced"
let inflight = false

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
 *  → instant on every ActiveProfile set (ours + external). SAFETY NET:
 *  `intervalMs` (timing.poll.tlp, now 30s) via tlp-stat -s — covers a dead
 *  or absent daemon (the DBus Get fails → readProfile resolves "balanced";
 *  tlp-stat still tells the truth). */
export function tlpProfile(intervalMs: number = 30000): Reactive<TlpProfile> {
  if (!_tlpState) {
    _tlpState = mkReactive(cached)
    const apply = (p: TlpProfile): void => {
      if (p === _tlpLast) return
      _tlpLast = p
      cached = p
      _tlpState?.set(p)
    }
    // Primary: daemon signal → DBus read → instant set.
    onProfileChanged(() => {
      void readProfile().then(apply)
    })
    // Initial read: the signal only fires on CHANGE, so without this the
    // state sits on the "balanced" seed until the first safety-net tick
    // (30s). readProfile is one DBus Get — cheaper than tlp-stat.
    void readProfile().then(apply)
    // Safety net: tlp-stat -s subprocess, dedup via apply().
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
      refreshAsync(apply)
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
