/**
 * promptd command hub — types, the window control surface, and b64 helpers.
 *
 * The individual command modules (askpass/approve/input/confirm/choice/form/
 * config) register against the shared registry and call the control surface
 * injected from
 * app.ts (the window owner). Payloads arrive base64-encoded because the
 * request CLI tokenizer splits argv on whitespace.
 */
import GLib from "gi://GLib"
import { register } from "@common/commands/registry"

export interface PromptRequest {
  mode: "masked" | "text" | "number"
  title: string
  body?: string
  placeholder?: string
}

interface ApproveCommand {
  command: string
  justification?: string
}

export interface ApproveRequest {
  title?: string
  commands: ApproveCommand[]
  justification?: string
  /** Caller-probed sudo cache validity (its OWN slot — the one the commands
   *  run in). When present, promptd trusts it over its local probe. */
  cacheValid?: boolean
}

export type ApproveResult =
  | { decision: "approve"; passwordFile?: string }
  | { decision: "deny" }
  | { decision: "auth-failed"; error: string; attempts: number }

export interface ConfirmRequest {
  title: string
  body?: string
  /** Optional text placed beside the ✓ / ✗ glyphs (zenity/yad wrappers pass
   *  --ok-label / --cancel-label). Omitted = glyphs only. */
  okLabel?: string
  cancelLabel?: string
}

export interface ChoiceRequest {
  title: string
  body?: string
  options: string[]
}

export interface FormField {
  key: string
  label: string
  masked?: boolean
}

export interface FormRequest {
  title: string
  body?: string
  fields: FormField[]
}

export interface PromptControl {
  /** Masked/text/number input. Rejects with Error("cancelled") on dismiss. */
  ask(opts: PromptRequest): Promise<string>
  /** Approval + password window. Resolves with the decision. */
  approve(req: ApproveRequest): Promise<ApproveResult>
  /** Yes/no window. Resolves with "ok"; rejects on dismiss. */
  askConfirm(req: ConfirmRequest): Promise<"ok">
  /** Single-select list. Resolves with the chosen option; rejects on dismiss. */
  askChoice(req: ChoiceRequest): Promise<string>
  /** Multi-field form. Resolves with {key: value}; rejects on dismiss. */
  askForm(req: FormRequest): Promise<Record<string, string>>
  /** Dismiss the open prompt as cancelled (no-op when idle). */
  cancel(): void
}

let control: PromptControl | null = null

export function setControl(c: PromptControl | null): void {
  control = c
}

function getControl(): PromptControl | null {
  return control
}

export function b64decode(s: string): string {
  return new TextDecoder().decode(GLib.base64_decode(s))
}

/** Resolve the injected control surface, or respond with the not-ready error. */
export function requireControl(res: (response: string) => void): PromptControl | null {
  const ctrl = getControl()
  if (!ctrl) res("error: promptd control not ready")
  return ctrl
}

/** Decode + parse a base64 JSON payload, responding on a missing/bad payload. */
export function decodePayload<T>(
  res: (response: string) => void,
  token: string | undefined,
  usage: string,
): T | null {
  if (!token) {
    res(`error: usage: ${usage} <payload-b64>`)
    return null
  }
  try {
    return JSON.parse(b64decode(token)) as T
  } catch (e: any) {
    res(`error: bad payload: ${e?.message ?? e}`)
    return null
  }
}

// Health check for fallback logic (callers probe promptd availability).
register(["promptd", "ping"], (_t, res) => {
  res("pong")
})

// Debug/testing aid: dismiss the open prompt (window answers as cancelled).
register(["promptd", "close"], (_t, res) => {
  const ctrl = getControl()
  if (!ctrl) return res("error: promptd control not ready")
  ctrl.cancel()
  res("closed")
})

// Side-effect imports: register the request handlers against the shared
// registry at module load (before createApp starts accepting requests).
import "./askpass"
import "./approve"
import "./input"
import "./confirm"
import "./choice"
import "./form"
import "./config"
