/**
 * input <payload-b64> — generic prompt: { mode: masked|text|number, title,
 * body?, placeholder? }. Returns the entered text or `error: cancelled`.
 */
import { register } from "@common/commands/registry"
import { decodePayload, type PromptRequest, requireControl } from "./index"

register(["promptd", "input"], async (tokens, res) => {
  const ctrl = requireControl(res)
  if (!ctrl) return
  const req = decodePayload<PromptRequest>(res, tokens[0], "input")
  if (!req) return
  if (!req.title || !["masked", "text", "number"].includes(req.mode)) {
    return res("error: payload needs title and mode in [masked, text, number]")
  }
  res(await ctrl.ask(req))
})
