/**
 * form <payload-b64> — multi-field form window.
 * Payload: { title, body?, fields: [{key, label, masked?}] }.
 * Returns JSON {key: value} or `error: cancelled` on dismiss.
 */
import { register } from "@common/commands/registry"
import { decodePayload, type FormRequest, requireControl } from "./index"

register(["promptd", "form"], async (tokens, res) => {
  const ctrl = requireControl(res)
  if (!ctrl) return
  const req = decodePayload<FormRequest>(res, tokens[0], "form")
  if (!req) return
  if (!req.title || !Array.isArray(req.fields) || req.fields.length === 0) {
    return res("error: payload needs a title and a non-empty fields array")
  }
  res(JSON.stringify(await ctrl.askForm(req)))
})
