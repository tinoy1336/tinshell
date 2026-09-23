/**
 * confirm <payload-b64> — yes/no window.
 * Payload: { title, body? }. Returns `ok` on approve
 * or `error: cancelled` on dismiss.
 */
import { register } from "@common/commands/registry"
import { type ConfirmRequest, decodePayload, requireControl } from "./index"

register(["promptd", "confirm"], async (tokens, res) => {
  const ctrl = requireControl(res)
  if (!ctrl) return
  const req = decodePayload<ConfirmRequest>(res, tokens[0], "confirm")
  if (!req) return
  if (!req.title) return res("error: payload needs a title")
  await ctrl.askConfirm(req)
  res("ok")
})
