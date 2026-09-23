/**
 * askpass <prompt-b64> — masked password prompt.
 *
 * The SUDO_ASKPASS bridge (~/.local/bin/sudo-approve-askpass) forwards sudo's
 * prompt string (argv[1]) base64-encoded. Returns the password on success or
 * `error: cancelled` when dismissed. The password flows window → registry →
 * CLI stdout → sudo; it never enters pi.
 */
import { register } from "@common/commands/registry"
import { b64decode, requireControl } from "./index"

register(["promptd", "askpass"], async (tokens, res) => {
  const ctrl = requireControl(res)
  if (!ctrl) return
  const prompt = tokens[0] ? b64decode(tokens[0]) : "Password:"
  const password = await ctrl.ask({
    mode: "masked",
    title: "sudo authentication",
    body: prompt,
  })
  res(password)
})
