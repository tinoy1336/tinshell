/**
 * common/applets/host/socket-server — the applets backend's SECOND listen
 * surface: the dock process, the same domain table, one unix socket in
 * addition to the request surface.
 *
 * Why in-process: the domains hold process-bound resources (the logind inhibit
 * fd, D-Bus subscriptions, the tablet helper child, the stores' single owner).
 * A second process would either duplicate them or need a bridge back into this
 * one, so the socket is a listener in the backend's own process and nothing
 * else.
 *
 * Why a socket at all: the pre-login greeter runs as the `greeter` user in its
 * own compositor. It has no session bus to reach the dock's D-Bus instance and
 * cannot read the session user's home, so the one transport that crosses that boundary
 * is a shared-group unix socket (created by setup.sh's root section — see
 * systemd/tmpfiles.d/tinshell-applets.conf).
 *
 * Traffic policy (a greeter client is a different user: file permissions alone
 * cannot say WHICH member it may call):
 *   - the `fs` domain is NEVER exposed — it reads and writes files AS THE
 *     SESSION USER, so a socket client with group access could read anything in
 *     that home;
 *   - store writes/leaks (`<store>.set`, `.dump`, `.path`) and every mutator
 *     (power actions, tablet/watchdog, wifi/bluetooth mutation, profile
 *     writes, workspace jumps) are OWNER-ONLY — the peer uid (SO_PEERCRED via
 *     `Gio.Socket.get_credentials`) must be the socket's own uid;
 *   - `brightness setScreenBrightness` is group-allowed on purpose: the login
 *     screen's brightness slider must keep working, and a backlight write
 *     grants no privilege beyond the backlight.
 *
 * Framing is common/applets/socket-protocol, the envelope is
 * common/applets/backend-protocol, and requests are dispatched through the
 * SAME `handleDomainRequest` the request surface uses — the two surfaces can
 * never disagree about what a member means.
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { APPLETS_NAMESPACE, replyError, replyOk } from "@common/applets/backend-protocol"
import {
  appletsSocketPath,
  helloValue,
  MAX_LINE_BYTES,
  parseSocketLine,
  SOCKET_PROTO,
  socketReplyLine,
  UNCORRELATED_ID,
} from "@common/applets/socket-protocol"
import { log } from "@common/log/logger"
import { handleDomainRequest, resolveMember } from "./transport"

/** The mode bits of a unix socket (S_IFSOCK) — the only file this server may
 *  replace at its path. */
const S_IFMT = 0o170000
const S_IFSOCK = 0o140000

/** The socket mode: group-writable so the `greeter` user can connect (the
 *  directory is setgid, so the file's group is already the shared one). */
const SOCKET_MODE = 0o660

/** Members only the socket's OWNER may call (see the header). */
const OWNER_ONLY_MEMBERS = new Set([
  "power executePowerAction",
  "power restoreInhibitState",
  "power-profile writeProfile",
  "mpris playPause",
  "mpris next",
  "mpris previous",
  "tablet startTabletWatchdog",
  "tablet setTabletOverride",
  "volume setVolume",
  "volume setMuted",
  "wifi setWifiEnabled",
  "wifi rescanWifi",
  "wifi connectWifi",
  "wifi forgetWifiNetwork",
  "wifi disconnectWifi",
  "bluetooth setBluetoothEnabled",
  "bluetooth startDiscovery",
  "bluetooth stopDiscovery",
  "bluetooth connectDevice",
  "bluetooth disconnectDevice",
  "bluetooth removeDevice",
  "bluetooth pairDevice",
  "bluetooth registerAgent",
  "bluetooth unregisterAgent",
  "workspaces jumpToWorkspace",
])

/** Group-allowed EXCEPTIONS to the store/mutator rule (see the header). */
const GROUP_ALLOWED_MEMBERS = new Set(["brightness setScreenBrightness"])

/** Store paths whose value/durability belong to the owner alone. */
const OWNER_ONLY_STORE_SUFFIXES = [".set", ".dump", ".path"]

/** Domains that never cross the socket (see the header). */
const NEVER_EXPOSED_DOMAINS = new Set(["fs"])

/** Concurrent connections served at once. A host opens ONE connection and
 *  polls every member over it, so 64 is far above real use; past the cap the
 *  connection is closed on accept instead of admitted (bounded fds/memory).
 *  A per-connection in-flight cap is unnecessary here: the read loop handles
 *  one line at a time (see pumpRead), so a connection never has more than one
 *  request outstanding — this connection bound is the one real bound. */
const MAX_CONNECTIONS = 64

/** Replies queued on one connection before it is closed. A peer that stops
 *  reading fills the socket buffer and then this queue; without a bound that
 *  queue would be driven by the peer. */
const MAX_QUEUED_REPLIES = 64

/** Read chunk for the bounded line reader. Smaller than MAX_LINE_BYTES so an
 *  over-long line is cut off while it is still arriving, never buffered whole. */
const READ_CHUNK_BYTES = 16 * 1024

/** Input discarded from a connection whose final envelope is already queued,
 *  before the socket is closed. Draining matters: closing a unix socket that
 *  still has unread input resets the peer, and a reset can discard the envelope
 *  just written. Bounded, so an endless stream cannot keep the socket alive. */
const MAX_DRAIN_BYTES = 2 * MAX_LINE_BYTES

/** The longest a closing connection is held while draining. */
const DRAIN_GRACE_MS = 2000

/** A request may take this long before the surface answers for it. Longer than
 *  the client's own timeout, so the user-visible error is the client's. */
const REQUEST_TIMEOUT_MS = 20_000

/** A connection with no complete line for this long is closed. */
const IDLE_TIMEOUT_MS = 120_000

/** The idle sweeper cadence. */
const SWEEP_MS = 10_000

/** How many malformed lines one connection may send. */
const MAX_FAULTS = 5

type Policy = "allowed" | "owner" | "never"

/** Classify a resolved member for a socket peer. */
function policyFor(domain: string, member: string): Policy {
  if (NEVER_EXPOSED_DOMAINS.has(domain)) return "never"
  if (GROUP_ALLOWED_MEMBERS.has(`${domain} ${member}`)) return "allowed"
  if (OWNER_ONLY_STORE_SUFFIXES.some((suffix) => member.endsWith(suffix))) return "owner"
  if (OWNER_ONLY_MEMBERS.has(`${domain} ${member}`)) return "owner"
  return "allowed"
}

/** The peer's unix uid, or null when the kernel could not hand it over (the
 *  caller then treats the peer as a non-owner — fail closed). */
function peerUid(conn: Gio.SocketConnection): number | null {
  try {
    const creds = conn.get_socket()?.get_credentials() as unknown as {
      get_unix_user: () => number
    } | null
    if (!creds) return null
    // @girs types `get_unix_user` as `never` (its gir "throws" artifact); the
    // call returns the uid_t.
    const uid = creds.get_unix_user() as unknown as number
    return typeof uid === "number" && uid >= 0 ? uid : null
  } catch (e) {
    log(`[applets-socket] peer credentials unavailable: ${String(e)}`)
    return null
  }
}

// ── Connections ──

interface Conn {
  id: string
  /** One write in flight at a time — a stream allows exactly one outstanding
   *  async write; this queue holds the replies that follow it. */
  writing: boolean
  queue: string[]
  faults: number
  lastLineAt: number
  /** Complete lines read but not yet handled: the reader decodes chunks and
   *  the handler runs one line at a time (see pumpRead). */
  lines: string[]
  processing: boolean
  /** Bytes received without a terminating newline yet. Bounded by
   *  MAX_LINE_BYTES — the reader aborts while the line is still arriving. */
  pending: Uint8Array
  input: Gio.InputStream
  out: Gio.OutputStream
  conn: Gio.SocketConnection
  closed: boolean
  /** A final reply is queued: stop reading lines, drain, then close. */
  closing: boolean
  closeAfterWrite: string | null
  /** Close-attempt gate: drained input, and the grace timer while draining. */
  drainDone: boolean
  drained: number
  closeTimer: number | null
}

const conns = new Set<Conn>()
let selfUid: number | null = null
let nextConnId = 0

function nowMs(): number {
  return GLib.get_monotonic_time() / 1000
}

const EMPTY_BYTES = new Uint8Array(0)
const decoder = new TextDecoder()

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function closeConn(c: Conn, why: string): void {
  if (c.closed) return
  c.closed = true
  conns.delete(c)
  if (c.closeTimer !== null) {
    GLib.source_remove(c.closeTimer)
    c.closeTimer = null
  }
  c.pending = EMPTY_BYTES
  c.lines.length = 0
  c.queue.length = 0
  log(`[applets-socket] connection ${c.id} closed (${why})`)
  try {
    c.input.close(null)
  } catch {
    /* already gone */
  }
  try {
    c.conn.close(null)
  } catch {
    /* already gone */
  }
}

/** Queue one reply line (id echoed, envelope verbatim). */
function send(c: Conn, id: string, envelopeJson: string): void {
  if (c.closed || c.closing) return
  c.queue.push(socketReplyLine(id, envelopeJson))
  // A peer that never reads fills the socket buffer and then this queue; past
  // the cap the connection is closed instead of letting the queue grow.
  if (c.queue.length > MAX_QUEUED_REPLIES) {
    closeConn(c, `reply queue over ${MAX_QUEUED_REPLIES} (peer not reading)`)
    return
  }
  pump(c)
}

/** Queue the ONE final reply of a connection and close it once that reply has
 *  been written — the contract is one envelope per line even on the paths that
 *  end the connection (an over-long line, too many faults). The pending input
 *  is drained first so the close cannot reset the envelope away. */
function sendAndClose(c: Conn, id: string, envelopeJson: string, why: string): void {
  if (c.closed || c.closing) return
  c.closing = true
  c.closeAfterWrite = why
  c.queue.push(socketReplyLine(id, envelopeJson))
  c.closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAIN_GRACE_MS, () => {
    c.closeTimer = null
    tryClose(c, true)
    return GLib.SOURCE_REMOVE
  })
  pump(c)
  drain(c)
}

/** Close a connection whose final envelope is queued, once that envelope has
 *  been written and (unless forced) the draining has ended. */
function tryClose(c: Conn, force: boolean): void {
  if (c.closed || c.closeAfterWrite === null) return
  if (!force) {
    if (!c.drainDone || c.writing || c.queue.length > 0) return
  }
  const why = c.closeAfterWrite
  if (c.closeTimer !== null) {
    GLib.source_remove(c.closeTimer)
    c.closeTimer = null
  }
  closeConn(c, why)
}

/** Discard the input still pending on a closing connection (bounded by
 *  MAX_DRAIN_BYTES, the offending line's newline, or the grace timer). */
function drain(c: Conn): void {
  if (c.closed) return
  c.input.read_bytes_async(READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, null, (_src, res) => {
    if (c.closed) return
    let chunk: Uint8Array | null = null
    try {
      const bytes = c.input.read_bytes_finish(res)
      chunk = bytes.get_size() > 0 ? (bytes.get_data() as Uint8Array) : null
    } catch {
      chunk = null
    }
    if (chunk === null) {
      c.drainDone = true
      tryClose(c, false)
      return
    }
    c.drained += chunk.length
    if (chunk.indexOf(0x0a) >= 0 || c.drained > MAX_DRAIN_BYTES) {
      c.drainDone = true
      tryClose(c, false)
      return
    }
    drain(c)
  })
}

function pump(c: Conn): void {
  if (c.closed || c.writing) return
  const line = c.queue.shift()
  if (line === undefined) return
  c.writing = true
  c.out.write_all_async(line, GLib.PRIORITY_DEFAULT, null, (_src, res) => {
    if (c.closed) return
    let failed: string | null = null
    try {
      c.out.write_all_finish(res)
    } catch (e) {
      failed = String(e)
    }
    c.writing = false
    if (failed !== null) {
      closeConn(c, `write failed: ${failed}`)
      return
    }
    if (c.closeAfterWrite !== null) {
      tryClose(c, false)
      if (c.closed) return
    }
    pump(c)
  })
}

function badLine(c: Conn, message: string): void {
  c.faults++
  if (c.faults > MAX_FAULTS) {
    sendAndClose(c, UNCORRELATED_ID, replyError("bad-arg", message), "too many malformed lines")
    return
  }
  send(c, UNCORRELATED_ID, replyError("bad-arg", message))
}

/** Answer one parsed line. Every path answers exactly one envelope. */
async function handleLine(c: Conn, line: string, uid: number | null): Promise<void> {
  c.lastLineAt = nowMs()
  if (new TextEncoder().encode(line).length > MAX_LINE_BYTES) {
    sendAndClose(
      c,
      UNCORRELATED_ID,
      replyError("bad-arg", `line exceeds ${MAX_LINE_BYTES} bytes`),
      "line too long",
    )
    return
  }
  const parsed = parseSocketLine(line)
  if (!parsed) {
    badLine(c, `expected '<id> ${APPLETS_NAMESPACE} <domain> <member> [<b64arg>…]'`)
    return
  }
  if (parsed.kind === "hello") {
    if (parsed.proto !== SOCKET_PROTO) {
      send(
        c,
        parsed.id,
        replyError(
          "call-failed",
          `socket proto ${parsed.proto} is not supported by this backend (speaks ${SOCKET_PROTO})`,
        ),
      )
      return
    }
    send(c, parsed.id, replyOk(helloValue()))
    return
  }

  const [namespace, domain, ...memberTokens] = parsed.tokens
  if (namespace !== APPLETS_NAMESPACE || !domain || memberTokens.length === 0) {
    send(
      c,
      parsed.id,
      replyError("unknown-path", `expected '${APPLETS_NAMESPACE} <domain> <member>'`),
    )
    return
  }

  // Classify by the RESOLVED member, so a shorthand token (`battery state`)
  // cannot slip past a policy that names the long form. A token that does not
  // resolve is DENIED here (fail closed) instead of being handed on: both
  // surfaces resolve with the same `resolveMember`, and denying at the socket
  // boundary means a future divergence between the two resolutions cannot
  // silently bypass the policy for a spelling one of them can resolve.
  const { name, ambiguous } = resolveMember(domain, memberTokens[0])
  if (!name) {
    const hint = ambiguous.length
      ? `ambiguous '${memberTokens[0]}' — candidates: ${ambiguous.join(", ")}`
      : `'${domain} ${memberTokens[0]}' names no member`
    send(c, parsed.id, replyError("unknown-path", hint))
    return
  }
  const policy = policyFor(domain, name)
  if (policy === "never") {
    send(c, parsed.id, replyError("denied", `'${domain}' is not served over the socket`))
    return
  }
  if (policy === "owner" && (uid === null || uid !== selfUid)) {
    send(
      c,
      parsed.id,
      replyError("denied", `'${domain} ${name}' is owner-only (peer uid ${uid ?? "unknown"})`),
    )
    return
  }

  let answered = false
  const answer = (envelopeJson: string): void => {
    if (answered || c.closed) return
    answered = true
    send(c, parsed.id, envelopeJson)
  }
  const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_MS, () => {
    answer(
      replyError("call-failed", `'${domain} ${name}' did not answer in ${REQUEST_TIMEOUT_MS}ms`),
    )
    return GLib.SOURCE_REMOVE
  })
  try {
    const envelopeJson = await handleDomainRequest(domain, memberTokens)
    GLib.source_remove(timeout)
    answer(envelopeJson)
  } catch (e) {
    GLib.source_remove(timeout)
    answer(replyError("call-failed", `${domain}: ${String(e)}`))
  }
}

/** Handle the next complete line if one is queued, otherwise read more bytes.
 *  Exactly one line is handled at a time (handleLine awaits the domain), so a
 *  connection never has two requests in flight and the read side does not run
 *  ahead of the handler — the pressure on `lines` stays bounded by the chunk. */
function pumpRead(c: Conn, uid: number | null): void {
  if (c.closed || c.closing) return
  if (c.lines.length > 0) {
    if (c.processing) return
    const line = c.lines.shift() as string
    c.processing = true
    void handleLine(c, line, uid).then(
      () => {
        c.processing = false
        pumpRead(c, uid)
      },
      () => {
        c.processing = false
        pumpRead(c, uid)
      },
    )
    return
  }
  readChunk(c, uid)
}

/** Read one chunk and split out complete lines. The accumulated bytes of a
 *  line that has not been terminated are bounded by MAX_LINE_BYTES: a line that
 *  crosses the bound is answered with one uncorrelated envelope and the
 *  connection closed while it is still arriving, so a partial line can never be
 *  buffered whole (and a partial line that stays under the bound is bounded by
 *  it until the idle sweep reaps the connection). */
function readChunk(c: Conn, uid: number | null): void {
  if (c.closed || c.closing) return
  c.input.read_bytes_async(READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, null, (_src, res) => {
    if (c.closed || c.closing) return
    let chunk: Uint8Array | null = null
    try {
      const bytes = c.input.read_bytes_finish(res)
      chunk = bytes.get_size() > 0 ? (bytes.get_data() as Uint8Array) : null
    } catch (e) {
      closeConn(c, `read failed: ${String(e)}`)
      return
    }
    if (chunk === null) {
      closeConn(c, "peer closed")
      return
    }
    const buf = c.pending.length === 0 ? chunk : concatBytes(c.pending, chunk)
    let start = 0
    for (;;) {
      const nl = buf.indexOf(0x0a, start)
      if (nl < 0) break
      const lineBytes = buf.subarray(start, nl)
      start = nl + 1
      if (lineBytes.length > MAX_LINE_BYTES) {
        sendAndClose(
          c,
          UNCORRELATED_ID,
          replyError("bad-arg", `line exceeds ${MAX_LINE_BYTES} bytes`),
          "line too long",
        )
        return
      }
      c.lines.push(decoder.decode(lineBytes))
    }
    const rest = buf.subarray(start)
    if (rest.length > MAX_LINE_BYTES) {
      sendAndClose(
        c,
        UNCORRELATED_ID,
        replyError("bad-arg", `line exceeds ${MAX_LINE_BYTES} bytes`),
        "line too long",
      )
      return
    }
    c.pending = rest.length > 0 ? rest.slice() : EMPTY_BYTES
    pumpRead(c, uid)
  })
}

function accept(conn: Gio.SocketConnection): boolean {
  if (conns.size >= MAX_CONNECTIONS) {
    log(`[applets-socket] refused a connection: ${MAX_CONNECTIONS} already open`)
    try {
      conn.close(null)
    } catch {
      /* already gone */
    }
    return true
  }
  const uid = peerUid(conn)
  const c: Conn = {
    id: `#${++nextConnId}`,
    writing: false,
    queue: [],
    faults: 0,
    lastLineAt: nowMs(),
    lines: [],
    processing: false,
    pending: EMPTY_BYTES,
    input: conn.get_input_stream(),
    out: conn.get_output_stream(),
    conn,
    closed: false,
    closing: false,
    closeAfterWrite: null,
    drainDone: false,
    drained: 0,
    closeTimer: null,
  }
  conns.add(c)
  log(
    `[applets-socket] client ${c.id} connected (uid ${uid ?? "unknown"}` +
      `${uid !== null && uid === selfUid ? ", owner" : ""})`,
  )
  pumpRead(c, uid)
  return true
}

// ── Lifecycle ──

interface AppletsSocket {
  path: string
  /** False when the socket could not be served (dir missing, path taken, not
   *  permitted) — the dock then runs exactly as before, socketless. */
  bound: boolean
  close: () => void
}

/** Remove a stale socket left by a killed process. False when the path exists
 *  and is NOT a socket — never replace an unrelated file. */
function clearStale(path: string): boolean {
  if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return true
  try {
    const info = Gio.File.new_for_path(path).query_info(
      Gio.FILE_ATTRIBUTE_UNIX_MODE,
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      null,
    )
    const mode = info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE)
    if ((mode & S_IFMT) !== S_IFSOCK) {
      log(`[applets-socket] ${path} exists and is not a socket — not touching it`)
      return false
    }
    GLib.unlink(path)
    return true
  } catch (e) {
    log(`[applets-socket] could not inspect ${path}: ${String(e)}`)
    return false
  }
}

const UNBOUND = (path: string): AppletsSocket => ({ path, bound: false, close: () => {} })

/** Bind the applets socket. Never throws: a failure is logged and the dock
 *  keeps serving the request surface (a socket client degrades instead). */
export function startAppletsSocket(): AppletsSocket {
  const path = appletsSocketPath()
  if (!clearStale(path)) return UNBOUND(path)

  const service = new Gio.SocketService()
  service.connect("incoming", (_s, conn) => accept(conn))
  try {
    const [ok] = service.add_address(
      new Gio.UnixSocketAddress({ path }),
      Gio.SocketType.STREAM,
      Gio.SocketProtocol.DEFAULT,
      null,
    )
    if (!ok) {
      log(`[applets-socket] bind failed for ${path}`)
      return UNBOUND(path)
    }
    // Group access: the directory is setgid (setup.sh), so the file already
    // carries the shared group and only the mode needs widening. The file's own
    // uid is also this process's uid — the owner check compares against it.
    try {
      const file = Gio.File.new_for_path(path)
      const info = file.query_info(Gio.FILE_ATTRIBUTE_UNIX_UID, Gio.FileQueryInfoFlags.NONE, null)
      selfUid = info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_UID)
      file.set_attribute_uint32(
        Gio.FILE_ATTRIBUTE_UNIX_MODE,
        SOCKET_MODE,
        Gio.FileQueryInfoFlags.NONE,
        null,
      )
    } catch (e) {
      log(`[applets-socket] could not set the socket mode/owner on ${path}: ${String(e)}`)
    }
    service.start()
  } catch (e) {
    log(`[applets-socket] listen failed for ${path}: ${String(e)}`)
    return UNBOUND(path)
  }

  const sweep = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SWEEP_MS, () => {
    const cutoff = nowMs() - IDLE_TIMEOUT_MS
    for (const c of [...conns]) {
      if (c.lastLineAt < cutoff) closeConn(c, "idle")
    }
    return GLib.SOURCE_CONTINUE
  })

  log(
    `[applets-socket] listening ${path} (proto ${SOCKET_PROTO}, owner uid ${selfUid ?? "unknown"})`,
  )

  return {
    path,
    bound: true,
    close: () => {
      GLib.source_remove(sweep)
      for (const c of [...conns]) closeConn(c, "server closing")
      try {
        service.stop()
      } catch {
        /* already stopped */
      }
      try {
        GLib.unlink(path)
      } catch {
        /* gone */
      }
    },
  }
}
