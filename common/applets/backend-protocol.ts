/**
 * common/applets/backend-protocol — the wire format of the applets backend's
 * request surface. Shared by the backend (common/applets/host, which serves it)
 * and the client proxy (common/applets/backend-client, which speaks it) — ONE
 * definition of the line syntax and the reply envelope, so the two ends cannot
 * drift.
 *
 * Request line (one line, ONE reply line back):
 *
 *   applets <domain> <member> [<arg>…]
 *   applets <domain> <store>.<accessor> [<arg>…]
 *
 * Reply envelope (always JSON, always one of the two shapes):
 *
 *   {"ok":true,"value":<json>}
 *   {"ok":false,"error":{"kind":"…","message":"…"}}
 *
 * Arguments are base64(JSON), one token each: the request surface splits the
 * request string on whitespace (common/app/request normalizeRequestArgv), so a
 * raw JSON argument breaks on any string containing a space or a quote —
 * base64 keeps every value a single whitespace-free token (the same convention
 * as `promptd askpass <b64>`).
 *
 * A failed OS call answers the STRUCTURED error envelope — never a bare null
 * and never a bare `error: …` string. The client parses exactly one shape, so
 * a degraded answer can only come from the transport layer, never from a
 * payload that happens to look empty.
 */
import GLib from "gi://GLib"

/** The request namespace the backend serves (and the app name the router
 *  resolves: the dock hosts it, so there is no instance of its own). */
export const APPLETS_NAMESPACE = "applets"

/** Why a request failed. `kind` is machine-readable; `message` is for humans.
 *  - `unknown-path`: the domain/member token names nothing in the table.
 *  - `bad-arg`: an argument token was not base64(JSON) (or the socket line
 *    itself was malformed).
 *  - `call-failed`: the domain function threw (or its promise rejected).
 *  - `no-sample`: a push member has not handed the backend a payload yet.
 *  - `denied`: the socket surface refused the member for this peer (the
 *    traffic policy — see common/applets/host/socket-server; the request
 *    surface answers it too, so one envelope parser stays enough). */
type TransportErrorKind = "unknown-path" | "bad-arg" | "call-failed" | "no-sample" | "denied"

export interface TransportError {
  kind: TransportErrorKind
  message: string
}

export type Envelope = { ok: true; value: unknown } | { ok: false; error: TransportError }

// ── Argument codec ──

/** Encode one argument as a single whitespace-free request token. */
function encodeArg(value: unknown): string {
  return GLib.base64_encode(new TextEncoder().encode(JSON.stringify(value ?? null)))
}

/** Decode one argument token. Throws on a token that is not base64(JSON) —
 *  the caller turns that into a `bad-arg` envelope. */
export function decodeArg(token: string): unknown {
  const bytes = GLib.base64_decode(token)
  if (!bytes || bytes.length === 0) throw new Error(`not base64: '${token}'`)
  const text = new TextDecoder().decode(bytes)
  return JSON.parse(text)
}

// ── Request line ──

/** The request tokens after the namespace: domain, member, encoded args. */
export function memberRequestTokens(domain: string, member: string, args: unknown[]): string[] {
  return [domain, member, ...args.map(encodeArg)]
}

/** The full request string, namespace included (for `ags -i <inst> request`). */
export function requestLine(tokens: string[]): string {
  return [APPLETS_NAMESPACE, ...tokens].join(" ")
}

// ── Reply envelope ──

export function replyOk(value: unknown): string {
  return JSON.stringify({ ok: true, value: value ?? null })
}

export function replyError(kind: TransportErrorKind, message: string): string {
  return JSON.stringify({ ok: false, error: { kind, message } satisfies TransportError })
}

/** Parse a reply. Null when the text is not one of our envelopes (an instance
 *  that is not the backend, an `ags` CLI error line, garbage). */
export function parseEnvelope(text: string): Envelope | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (obj.ok === true) return { ok: true, value: obj.value ?? null }
  if (obj.ok === false && obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>
    const kind = err.kind
    if (
      kind === "unknown-path" ||
      kind === "bad-arg" ||
      kind === "call-failed" ||
      kind === "no-sample" ||
      kind === "denied"
    ) {
      return { ok: false, error: { kind, message: String(err.message ?? "") } }
    }
  }
  return null
}
