/**
 * approve <payload-b64> — unified approval + password window.
 *
 * Payload: JSON { title?, commands: [{command, justification?}], justification? }.
 * Response: JSON { decision: "approve", passwordFile } — the password is
 * written to a 0600 temp file, only its path is returned, and the caller
 * (pi's sudo_approve tool) consumes it via a cat-askpass script — or
 * JSON { decision: "deny" } when dismissed.
 */
import { register } from "@common/commands/registry"
import { type ApproveRequest, decodePayload, requireControl } from "./index"

register(["promptd", "approve"], async (tokens, res) => {
  const ctrl = requireControl(res)
  if (!ctrl) return
  const req = decodePayload<ApproveRequest>(res, tokens[0], "approve")
  if (!req) return
  if (!Array.isArray(req.commands) || req.commands.length === 0) {
    return res("error: payload needs a non-empty commands array")
  }
  res(JSON.stringify(await ctrl.approve(req)))
})
