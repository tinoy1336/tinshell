/**
 * socket-protocol.probe — the applets unix-socket framing
 * (common/applets/socket-protocol.ts).
 *
 * This is the only transport a DIFFERENT-USER client has (the pre-login
 * greeter), and its failure mode is silent: a frame that parses into the wrong
 * shape does not throw here, it answers the wrong request or answers one the
 * client cannot correlate. These checks pin the framing rules the two ends
 * depend on — the id bound that keeps a garbage line from becoming a request,
 * the handshake verb's validation, the reply split, and the constants a client
 * compares before it trusts the peer.
 *
 * The module imports `gi://GLib`, so the probe runs through the repo's own
 * bundler rather than under plain Node:
 *   ags bundle --gtk 4 common/applets/socket-protocol.probe.ts /tmp/socket-protocol-probe.sh
 *   bash /tmp/socket-protocol-probe.sh
 */
import GLib from "gi://GLib"
import {
  appletsSocketPath,
  helloLine,
  helloValue,
  MAX_LINE_BYTES,
  parseSocketLine,
  parseSocketReply,
  SOCKET_PROTO,
  socketReplyLine,
  socketRequestLine,
  UNCORRELATED_ID,
} from "./socket-protocol.ts"

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}

// ── the constants both ends compare before they trust each other ──
check("the protocol version is the one the client speaks", SOCKET_PROTO, 1)
check("a malformed line's reply carries the reserved id", UNCORRELATED_ID, "0")
check("the line bound is the documented one", MAX_LINE_BYTES, 256 * 1024)

// ── the handshake ──
check("a hello parses", parseSocketLine("7 hello 1"), { kind: "hello", id: "7", proto: 1 })
check("the id is echoed verbatim", parseSocketLine("abc-9 hello 1"), {
  kind: "hello",
  id: "abc-9",
  proto: 1,
})
check("a proto of 0 is refused", parseSocketLine("7 hello 0"), null)
check("a negative proto is refused", parseSocketLine("7 hello -1"), null)
check("a non-numeric proto is refused", parseSocketLine("7 hello abc"), null)
check("a missing proto is refused", parseSocketLine("7 hello"), null)
check("a fractional proto is refused", parseSocketLine("7 hello 1.5"), null)
check("a future proto still PARSES (the client refuses it)", parseSocketLine("7 hello 9"), {
  kind: "hello",
  id: "7",
  proto: 9,
})

// ── a request line ──
check("a request keeps its tokens", parseSocketLine("3 applets battery level"), {
  kind: "request",
  id: "3",
  tokens: ["applets", "battery", "level"],
})
check("extra whitespace is collapsed", parseSocketLine("  3   applets  battery   level  "), {
  kind: "request",
  id: "3",
  tokens: ["applets", "battery", "level"],
})
check("base64 arguments survive", parseSocketLine("4 applets promptd approve YWJj"), {
  kind: "request",
  id: "4",
  tokens: ["applets", "promptd", "approve", "YWJj"],
})
check("the hello verb is never a domain", parseSocketLine("5 hello 2"), {
  kind: "hello",
  id: "5",
  proto: 2,
})

// ── what must NOT become a request ──
check("an empty line is malformed", parseSocketLine(""), null)
check("a whitespace-only line is malformed", parseSocketLine("   "), null)
check("a bare id is malformed", parseSocketLine("3"), null)
check("an id past the bound is malformed", parseSocketLine(`${"i".repeat(65)} hello 1`), null)
check("an id at the bound is accepted", parseSocketLine(`${"i".repeat(64)} hello 1`), {
  kind: "hello",
  id: "i".repeat(64),
  proto: 1,
})

// ── a reply line ──
check("a reply splits into id and envelope", parseSocketReply('7 {"ok":true,"value":1}'), {
  id: "7",
  envelopeJson: '{"ok":true,"value":1}',
})
check(
  "a reply's envelope keeps its own spaces",
  parseSocketReply('7 {"ok":false,"error":{"kind":"bad-arg","message":"x y"}}'),
  {
    id: "7",
    envelopeJson: '{"ok":false,"error":{"kind":"bad-arg","message":"x y"}}',
  },
)
check("an id with no envelope is malformed", parseSocketReply("7"), null)
check("an id with an empty envelope is malformed", parseSocketReply("7   "), null)
check("an envelope with no id is malformed", parseSocketReply('{"ok":true}'), null)
check("an empty reply line is malformed", parseSocketReply(""), null)

// ── the writers: a frame always ends in the delimiter ──
check("a hello frame is one line", helloLine("1", 2), "1 hello 2\n")
check("a hello frame defaults to the protocol version", helloLine("1"), `1 hello ${SOCKET_PROTO}\n`)
check(
  "a request frame carries the request surface's body",
  socketRequestLine("3", ["battery", "level"]),
  "3 applets battery level\n",
)
check(
  "a reply frame carries the envelope verbatim",
  socketReplyLine("3", '{"ok":true,"value":1}'),
  '3 {"ok":true,"value":1}\n',
)

// ── the socket path: the override a dev harness uses, else the installed dir ──
GLib.setenv("TINSHELL_APPLETS_SOCKET", "/tmp/override.sock", true)
check("the path override wins", appletsSocketPath(), "/tmp/override.sock")
GLib.unsetenv("TINSHELL_APPLETS_SOCKET")
check(
  "without an override the path is the installed one",
  appletsSocketPath(),
  "/run/tinshell/applets.sock",
)

// ── the handshake body ──
const value = helloValue()
check("the handshake reports the protocol version", value.proto, SOCKET_PROTO)
check("the handshake reports a user", typeof value.user === "string" && value.user.length > 0, true)
check(
  "the handshake reports no invented build id",
  value.build,
  GLib.getenv("TINSHELL_BUNDLE_ID") ?? null,
)
GLib.setenv("TINSHELL_BUNDLE_ID", "abc123", true)
check("an exported build id is reported", helloValue().build, "abc123")
GLib.unsetenv("TINSHELL_BUNDLE_ID")
check("a blank build id is reported as absent", helloValue().build, null)

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
if (failed.length > 0) throw new Error(`socket-protocol probe failed: ${failed.length} check(s)`)
