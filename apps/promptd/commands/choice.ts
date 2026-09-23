/**
 * choice <payload-b64> — single-select list window.
 * Payload: { title, body?, options: string[] }. Returns the chosen option or
 * `error: cancelled` on dismiss.
 */
import { register } from "@common/commands/registry"
import { type ChoiceRequest, decodePayload, requireControl } from "./index"

register(["promptd", "choice"], async (tokens, res) => {
  const ctrl = requireControl(res)
  if (!ctrl) return
  const req = decodePayload<ChoiceRequest>(res, tokens[0], "choice")
  if (!req) return
  if (!req.title || !Array.isArray(req.options) || req.options.length === 0) {
    return res("error: payload needs a title and a non-empty options array")
  }
  res(await ctrl.askChoice(req))
})
