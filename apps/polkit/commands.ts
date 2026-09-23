/**
 * polkit request namespace — registered at import time against the shared
 * registry (before createApp starts accepting requests). Address via
 * `ags -i polkit request "<path>"`.
 *
 * Commands live under the app-name prefix (["polkit", ...]) — the shared
 * registry is process-global in the shell instance, so every app prefixes.
 * Both modes address the same paths: `ags -i shell request "polkit …"`
 * (production) / `ags -i polkit request "polkit …"` (dev island).
 */
import { register } from "@common/commands/registry"
import { agentState, registerAgent, unregisterAgent } from "./agent"

register(["polkit", "status"], (_args, res) => {
  const s = agentState()
  if (!s.hasBus) {
    res("agent disabled (no system bus connection)")
    return
  }
  const active = s.activeCookie ? `, prompt open (cookie ${s.activeCookie})` : ""
  res(
    s.registered
      ? `agent registered (subject=unix-session:${s.sessionId}, locale=${s.locale}${active})`
      : `agent NOT registered (subject=unix-session:${s.sessionId}${active})`,
  )
})

register(["polkit", "register"], async (_args, res) => {
  try {
    const id = await registerAgent()
    res(`registered (subject=session:${id})`)
  } catch (e) {
    res(`error: ${(e as Error).message}`)
  }
})

register(["polkit", "unregister"], async (_args, res) => {
  try {
    await unregisterAgent()
    res("unregistered")
  } catch (e) {
    res(`error: ${(e as Error).message}`)
  }
})

register(["polkit", "debug", "ping"], (_args, res) => {
  res("pong")
})
