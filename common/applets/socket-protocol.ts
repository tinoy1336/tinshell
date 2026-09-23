/**
 * common/applets/socket-protocol — the line grammar of the applets backend's
 * unix-socket surface. This is the transport a DIFFERENT-USER client needs:
 * the pre-login greeter runs as the `greeter` user in its own compositor and
 * cannot reach the user-session `applets` instance (different session bus,
 * foreign home), so the backend listens on a shared-group socket as well.
 *
 * One line per request, one line per reply, newline-delimited:
 *
 *   <id> hello <proto>                              (handshake, once per connection)
 *   <id> applets <domain> <member> [<b64arg>…]      (a request)
 *   <id> {"ok":true,"value":…}
 *   <id> {"ok":false,"error":{"kind":…,"message":…}}
 *
 * The request BODY after <id> is the SAME vocabulary the request surface
 * speaks (common/applets/backend-protocol): the namespace token, the domain,
 * the member and base64(JSON) argument tokens, and the reply body is the
 * unchanged Envelope. `<id>` is the ONE addition — a stream carries several
 * in-flight requests at once (the client polls every member on its own timer),
 * and unlike D-Bus nothing in the transport correlates them, so a reply without
 * an id would be attributed to whichever request settles next.
 *
 * `<id>` is an opaque client-chosen token echoed verbatim; `0` is reserved for
 * a reply the server could not correlate (a malformed line).
 *
 * The `*Line()` helpers return a COMPLETE frame — newline included — so a
 * writer can never forget the delimiter; the parse helpers take a line as read
 * (newline already stripped by the reader).
 */
import GLib from "gi://GLib"
import { requestLine } from "./backend-protocol"

/** The socket directory created by setup.sh's root section (tmpfiles.d). */
const APPLETS_SOCKET_DIR = "/run/tinshell"

/** The socket file name inside it. */
const APPLETS_SOCKET_FILE = "applets.sock"

/** The socket path. `TINSHELL_APPLETS_SOCKET` (absolute) overrides it — a dev
 *  harness can exercise the whole protocol without the root-installed dir. */
export function appletsSocketPath(): string {
  const override = GLib.getenv("TINSHELL_APPLETS_SOCKET")
  if (override) return override
  return GLib.build_filenamev([APPLETS_SOCKET_DIR, APPLETS_SOCKET_FILE])
}

/** The socket protocol version. A client that does not speak this exact
 *  version must degrade, never guess: the deployed greeter bundle and a live
 *  `applets` process can be different builds (the bundle is content-hashed and
 *  a rebuild does not restart a running instance). */
export const SOCKET_PROTO = 1

/** A malformed line cannot be correlated — its reply carries this id. */
export const UNCORRELATED_ID = "0"

/** The longest line either end accepts. A reply can carry a domain listing, so
 *  this is generous; anything larger is a protocol fault, not a payload. */
export const MAX_LINE_BYTES = 256 * 1024

/** The handshake verb. Not a domain name, so it can never collide with one. */
const HELLO_VERB = "hello"

/** The `tinshell-applets` bundle identity, when the launcher exports one. Absent in
 *  the universal-bundle path (no build id is exported yet) — the client then
 *  reports `build: null` rather than inventing one. */
function bundleId(): string | null {
  const id = GLib.getenv("TINSHELL_BUNDLE_ID")
  return id && id.length > 0 ? id : null
}

// ── Client → server ──

export function helloLine(id: string, proto: number = SOCKET_PROTO): string {
  return `${id} ${HELLO_VERB} ${proto}\n`
}

/** One request line: the id, then the request-surface line itself
 *  (`applets <domain> <member> <b64arg>…`) — the body is built by
 *  `requestLine`, so the two surfaces cannot drift. */
export function socketRequestLine(id: string, tokens: string[]): string {
  return `${id} ${requestLine(tokens)}\n`
}

type SocketLine =
  | { kind: "hello"; id: string; proto: number }
  | { kind: "request"; id: string; tokens: string[] }

/** Parse one client line. Null = malformed (the caller answers an
 *  uncorrelated `bad-arg`). The namespace/domain/member validation stays with
 *  the request surface — this function only splits the frame. */
export function parseSocketLine(line: string): SocketLine | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const tokens = trimmed.split(/\s+/)
  const id = tokens[0]
  if (!id || id.length > 64) return null
  const rest = tokens.slice(1)
  if (rest.length === 0) return null
  if (rest[0] === HELLO_VERB) {
    const proto = Number(rest[1])
    if (!Number.isInteger(proto) || proto <= 0) return null
    return { kind: "hello", id, proto }
  }
  return { kind: "request", id, tokens: rest }
}

// ── Server → client ──

/** One reply line: the echoed id, then the envelope JSON verbatim (the server
 *  composes it with replyOk/replyError — one envelope spelling). */
export function socketReplyLine(id: string, envelopeJson: string): string {
  return `${id} ${envelopeJson}\n`
}

/** The serving process's identity for the handshake. `getpid` is a gjs
 *  extension the girs typings do not carry, so a runtime without it reports 0 —
 *  the handshake's contract is `proto` (the client refuses a mismatch) and
 *  `build`, not the pid. */
function pid(): number {
  const getpid = (GLib as unknown as { getpid?: () => number }).getpid
  return typeof getpid === "function" ? getpid() : 0
}

/** The handshake reply body. `build` is null when the launcher exports no id. */
export function helloValue(): { proto: number; pid: number; user: string; build: string | null } {
  return {
    proto: SOCKET_PROTO,
    pid: pid(),
    user: GLib.get_user_name(),
    build: bundleId(),
  }
}

interface SocketReply {
  id: string
  envelopeJson: string
}

/** Parse one server line. Null = not our framing (garbage from a non-client,
 *  a truncated line, or a reply we cannot attribute). */
export function parseSocketReply(line: string): SocketReply | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const space = trimmed.indexOf(" ")
  if (space <= 0) return null
  const id = trimmed.slice(0, space)
  const envelopeJson = trimmed.slice(space + 1).trim()
  if (!id || !envelopeJson) return null
  return { id, envelopeJson }
}
