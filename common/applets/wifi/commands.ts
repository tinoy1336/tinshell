/**
 * Wifi applet commands — the `dock debug wifi` probe.
 *
 * Registered by the host's applet manifest, so the request path is the dock's
 * (`dock debug wifi`); the probe itself reaches the OS only through the
 * backend seam.
 */
import GLib from "gi://GLib"
import type { AppletBackend } from "@common/applets/backend"
import type { Handler } from "@common/commands/registry"
import { logTo } from "@common/log/logger"

/** Build the `dock debug wifi` probe against the host's OS domains. */
export function wifiDebugCommand(backend: AppletBackend): Handler {
  return (_args, res) => {
    void (async () => {
      const t0 = GLib.get_monotonic_time()
      let t1 = t0
      let t2 = t0
      let t3 = t0
      const step = (label: string, t: number): void =>
        logTo(
          "/tmp/wifi-debug.log",
          `${new Date().toISOString()} ${label} ${Math.round((t - t0) / 1000)}ms`,
        )
      logTo("/tmp/wifi-debug.log", `${new Date().toISOString()} START`)
      const status = await backend.wifi.wifiStatus()
      t1 = GLib.get_monotonic_time()
      step("status", t1)
      const nets = await backend.wifi.scanWifiNetworks()
      t2 = GLib.get_monotonic_time()
      step("scan", t2)
      const saved = await backend.wifi.savedSsidList()
      t3 = GLib.get_monotonic_time()
      step("savedList", t3)
      const inUse =
        nets
          .filter((n) => n.inUse)
          .map((n) => `${n.ssid}@${n.signal}`)
          .join(",") || "none"
      const ms = (a: number, b: number) => Math.round((b - a) / 1000)
      res(
        `enabled=${status.enabled} connected=${status.connected} signal=${status.signal} conn=${status.connectivity} inUse=${inUse} nets=${nets.length} saved=${saved.length} | status=${ms(t0, t1)}ms scan=${ms(t1, t2)}ms savedList=${ms(t2, t3)}ms total=${ms(t0, t3)}ms`,
      )
    })()
  }
}
