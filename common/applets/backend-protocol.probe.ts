/**
 * backend-protocol.probe — the applets wire codec (common/applets/backend-protocol.ts).
 *
 * Both transports (the request surface and the unix socket) speak this codec,
 * and a break in it is silent in a specific way: an argument that does not
 * round-trip reaches a domain as the wrong value, and an envelope the parser
 * stops recognising is reported to the caller as "the transport answered
 * nothing" instead of as the refusal the backend sent. These checks pin the
 * codec's two halves against each other (encode → decode is the identity), the
 * envelope shapes, and the kinds the parser accepts — the five a caller
 * switches on.
 *
 * The module imports `gi://GLib` (base64), so the probe runs through the repo's
 * own bundler. It uses no promises, so nothing here depends on a running
 * application loop:
 *   ags bundle --gtk 4 common/applets/backend-protocol.probe.ts /tmp/backend-protocol-probe.sh
 *   timeout 60 bash /tmp/backend-protocol-probe.sh
 */
import GLib from "gi://GLib"
import {
  APPLETS_NAMESPACE,
  decodeArg,
  memberRequestTokens,
  parseEnvelope,
  replyError,
  replyOk,
  requestLine,
} from "./backend-protocol.ts"

/** base64 of a UTF-8 string — the codec's own input shape. */
const b64 = (text: string): string => GLib.base64_encode(new TextEncoder().encode(text))

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}
const throws = (name: string, fn: () => unknown): void => {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  checks.push([name, threw, true])
}

check("the namespace is the one every surface registers under", APPLETS_NAMESPACE, "applets")

// ── the argument codec: encode → decode is the identity ──
const values: [string, unknown][] = [
  ["a string", "hello"],
  ["a string with whitespace and quotes", 'a b\t"c"\nd'],
  ["an empty string", ""],
  ["a number", 42],
  ["zero", 0],
  ["a negative fraction", -0.5],
  ["a boolean false", false],
  ["null", null],
  ["an array", [1, "two", false]],
  ["a nested object", { a: { b: [1, { c: null }] } }],
  ["a non-ASCII string", "café — 📁"],
]
for (const [label, value] of values) {
  const token = memberRequestTokens("d", "m", [value])[1 + 1]
  check(`round-trips ${label}`, decodeArg(token), value ?? null)
  check(`${label} encodes as one whitespace-free token`, /\s/.test(token), false)
}

// ── the codec's refusals: a token that is not base64(JSON) throws ──
throws("a non-base64 token throws", () => decodeArg("!!!!"))
throws("an empty token throws", () => decodeArg(""))
throws("base64 of non-JSON throws", () => decodeArg(b64("not json")))
check("base64 of JSON null decodes to null", decodeArg(b64("null")), null)

// ── the request line ──
check(
  "member tokens are domain, member, encoded args",
  memberRequestTokens("battery", "state", [1])[0],
  "battery",
)
check(
  "the request line carries the namespace",
  requestLine(["battery", "state"]),
  "applets battery state",
)
check(
  "a request line's arguments stay one token each",
  requestLine(memberRequestTokens("wifi", "connect", ["a b", 2])).split(" ").length,
  5,
)

// ── the reply envelope ──
check("an ok reply carries the value", parseEnvelope(replyOk({ v: 1 })), {
  ok: true,
  value: { v: 1 },
})
check("an ok reply with undefined carries null", parseEnvelope(replyOk(undefined)), {
  ok: true,
  value: null,
})
check("an error reply carries kind and message", parseEnvelope(replyError("bad-arg", "nope")), {
  ok: false,
  error: { kind: "bad-arg", message: "nope" },
})
for (const kind of ["unknown-path", "bad-arg", "call-failed", "no-sample", "denied"] as const) {
  check(`the parser accepts a '${kind}' error`, parseEnvelope(replyError(kind, "m")), {
    ok: false,
    error: { kind, message: "m" },
  })
}

// ── what the parser must REFUSE (a non-backend answering) ──
check(
  "a missing kind is refused",
  parseEnvelope(JSON.stringify({ ok: false, error: { message: "m" } })),
  null,
)
check(
  "an unknown kind is refused",
  parseEnvelope(JSON.stringify({ ok: false, error: { kind: "teapot", message: "m" } })),
  null,
)
check("a non-envelope JSON object is refused", parseEnvelope(JSON.stringify({ value: 1 })), null)
check("a JSON array is refused", parseEnvelope("[1,2]"), null)
check("plain text is refused", parseEnvelope("error: no instance"), null)
check("an empty reply is refused", parseEnvelope("   "), null)
check(
  "a non-string error message is stringified, not dropped",
  parseEnvelope(JSON.stringify({ ok: false, error: { kind: "denied", message: 7 } })),
  { ok: false, error: { kind: "denied", message: "7" } },
)
check(
  "a missing error message reads as empty",
  parseEnvelope(JSON.stringify({ ok: false, error: { kind: "denied" } })),
  {
    ok: false,
    error: { kind: "denied", message: "" },
  },
)
check("surrounding whitespace is tolerated", parseEnvelope(`  ${replyOk(1)}  `), {
  ok: true,
  value: 1,
})
check("ok:true with no value reads as null", parseEnvelope(JSON.stringify({ ok: true })), {
  ok: true,
  value: null,
})

const failed = checks.filter(
  ([, actual, expected]) => JSON.stringify(actual) !== JSON.stringify(expected),
)
for (const [name, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`backend-protocol probe failed: ${failed.length} check(s)`)
