/**
 * common/applets/backend-socket-client — the applets backend over its unix
 * socket (common/applets/host/socket-server). This is the transport for a host
 * that CANNOT reach the backend over D-Bus: the pre-login greeter runs
 * as the `greeter` user, outside the session bus and outside the session user's home.
 *
 * It speaks common/applets/socket-protocol: one `<id>`-prefixed request line
 * carrying the SAME body the request surface uses, one `<id>`-prefixed envelope
 * line back. The id is what makes concurrent polls on one connection safe —
 * the applet members are polled on independent timers, and an uncorrelated
 * reply would be handed to the wrong member.
 *
 * Failure policy: the transport is ADDITIVE and never on a critical path. It
 * connects asynchronously, retries every `REPROBE_MS` while down, and answers
 * an `unreachable` envelope (never a hang, never a throw) when no connection is
 * up — the client proxy maps that to its documented placeholders and the host
 * hides what it cannot serve. `onStateChange` reports every up/down transition
 * so a host can gate its surfaces on a VERIFIED transport (the greeter shows
 * applet cells only once `hello` answered with a matching proto).
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { type Envelope, memberRequestTokens, parseEnvelope } from "@common/applets/backend-protocol"
import {
  appletsSocketPath,
  helloLine,
  MAX_LINE_BYTES,
  parseSocketReply,
  SOCKET_PROTO,
  socketRequestLine,
} from "@common/applets/socket-protocol"
import { log } from "@common/log/logger"
import type { BackendTransport } from "./backend-client"

/** A request waits this long for its reply (the same budget the request
 *  surface's client allows a slow OS call). */
const REQUEST_TIMEOUT_MS = 15_000

/** While no connection is up, retry at most this often. */
const REPROBE_MS = 10_000

/** A local unix socket connects immediately or not at all. */
const CONNECT_TIMEOUT_MS = 1000

/** Read chunk for the bounded reply reader. Smaller than MAX_LINE_BYTES, so an
 *  over-long reply line is cut off while it is still arriving. */
const READ_CHUNK_BYTES = 16 * 1024

const EMPTY_BYTES = new Uint8Array(0)
const decoder = new TextDecoder()

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

interface SocketTransportOptions {
  /** Defaults to the shared path (or `TINSHELL_APPLETS_SOCKET`). */
  path?: string
  /** Up/down transitions of a VERIFIED transport (a `hello` answered with the
   *  proto this client speaks). */
  onStateChange?: (up: boolean) => void
}

export interface SocketBackendTransport extends BackendTransport {
  /** True only between a matching `hello` reply and the next close/EOF. */
  isUp: () => boolean
  close: () => void
}

function unreachable(detail: string): Envelope {
  return { ok: false, error: { kind: "call-failed", message: detail } }
}

export function createSocketBackendTransport(
  opts: SocketTransportOptions = {},
): SocketBackendTransport {
  const path = opts.path ?? appletsSocketPath()

  let conn: Gio.SocketConnection | null = null
  let input: Gio.InputStream | null = null
  let out: Gio.OutputStream | null = null
  /** Bytes of a reply line received so far — bounded by MAX_LINE_BYTES. */
  let replyPending: Uint8Array = EMPTY_BYTES
  let connecting = false
  let closed = false
  let up = false
  let nextId = 1
  let queue: string[] = []
  let writing = false
  let retry: number | null = null
  /** No connect attempt before this (monotonic ms): every member poll asks for
   *  a connection, and without a window a dead backend would be dialed once per
   *  poll — the bounded spawn rate the request-surface client also keeps. */
  let nextProbeAt = 0
  /** id → settle callback. One entry per in-flight request. */
  const pending = new Map<string, (env: Envelope) => void>()

  function nowMs(): number {
    return GLib.get_monotonic_time() / 1000
  }

  function setState(next: boolean, why: string): void {
    if (up === next) return
    up = next
    log(`[applets-socket-client] ${next ? "up" : "down"} (${why})`)
    opts.onStateChange?.(next)
  }

  function failAll(why: string): void {
    const waiting = [...pending.values()]
    pending.clear()
    for (const settle of waiting) settle(unreachable(`applets socket unavailable (${why})`))
  }

  function stopConnection(why: string, requestRetry: boolean): void {
    const old = conn
    conn = null
    input = null
    out = null
    replyPending = EMPTY_BYTES
    writing = false
    queue = []
    setState(false, why)
    // Close the socket rather than dropping the reference: otherwise the fd is
    // only reclaimed when the GC finalizes the connection, so a server that
    // accepts and then closes could accumulate descriptors.
    try {
      old?.close(null)
    } catch {
      /* already gone */
    }
    failAll(why)
    // A lost connection arms the same retry as a failed one: the next connect
    // re-binds to a backend that may have been restarted (a stale socket file
    // answers ECONNREFUSED, which the connect reports as a failure).
    if (requestRetry) {
      nextProbeAt = nowMs() + REPROBE_MS
      armRetry()
    }
  }

  function armRetry(): void {
    if (closed || retry !== null) return
    const wait = Math.max(1, Math.round(nextProbeAt - nowMs()))
    retry = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
      retry = null
      connect()
      return GLib.SOURCE_REMOVE
    })
  }

  function pump(): void {
    if (writing || !out) return
    const line = queue.shift()
    if (line === undefined) return
    writing = true
    out.write_all_async(line, GLib.PRIORITY_DEFAULT, null, (_src, res) => {
      writing = false
      try {
        out?.write_all_finish(res)
      } catch (e) {
        stopConnection(`write failed: ${String(e)}`, true)
        return
      }
      pump()
    })
  }

  /** Queue one complete frame (the id is already in the line). */
  function send(line: string): void {
    queue.push(line)
    pump()
  }

  /** Deliver one reply line to the request waiting for its id; a line whose id
   *  is not pending (stale, unsolicited or undecodable) is ignored. */
  function dispatchReply(line: string): void {
    const reply = parseSocketReply(line)
    if (!reply) return
    const settle = pending.get(reply.id)
    if (!settle) return
    pending.delete(reply.id)
    // The envelope vocabulary is shared with the request surface — ONE parser,
    // so a degraded answer can only come from the transport.
    settle(
      parseEnvelope(reply.envelopeJson) ??
        unreachable(`undecodable socket reply: ${reply.envelopeJson.slice(0, 120)}`),
    )
  }

  /** Read one chunk and split out complete reply lines. The bytes of an
   *  unterminated line are bounded by MAX_LINE_BYTES (the same bound the server
   *  applies to requests), so a buggy or hostile server cannot grow the client's
   *  line buffer without limit; crossing the bound drops the connection and
   *  fails every pending request. */
  function readNext(): void {
    const stream = input
    const active = conn
    if (!stream || !active) return
    stream.read_bytes_async(READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, null, (_src, res) => {
      if (conn !== active) return
      let chunk: Uint8Array | null = null
      try {
        const bytes = stream.read_bytes_finish(res)
        chunk = bytes.get_size() > 0 ? (bytes.get_data() as Uint8Array) : null
      } catch (e) {
        stopConnection(`read failed: ${String(e)}`, true)
        return
      }
      if (chunk === null) {
        stopConnection("peer closed", true)
        return
      }
      const buf = replyPending.length === 0 ? chunk : concatBytes(replyPending, chunk)
      let start = 0
      for (;;) {
        const nl = buf.indexOf(0x0a, start)
        if (nl < 0) break
        const lineBytes = buf.subarray(start, nl)
        start = nl + 1
        if (lineBytes.length > MAX_LINE_BYTES) {
          stopConnection(`reply line exceeds ${MAX_LINE_BYTES} bytes`, true)
          return
        }
        dispatchReply(decoder.decode(lineBytes))
      }
      const rest = buf.subarray(start)
      if (rest.length > MAX_LINE_BYTES) {
        stopConnection(`reply line exceeds ${MAX_LINE_BYTES} bytes`, true)
        return
      }
      replyPending = rest.length > 0 ? rest.slice() : EMPTY_BYTES
      readNext()
    })
  }

  function connect(): void {
    if (closed || connecting || conn !== null) return
    if (nowMs() < nextProbeAt) return
    // Claim the window at ATTEMPT time: every request that arrives while this
    // attempt (or the pause after a failure) is in flight is a no-op.
    nextProbeAt = nowMs() + REPROBE_MS
    connecting = true
    const client = new Gio.SocketClient()
    client.set_timeout(CONNECT_TIMEOUT_MS)
    client.connect_async(new Gio.UnixSocketAddress({ path }), null, (src, res) => {
      connecting = false
      if (closed) return
      let connection: Gio.SocketConnection
      try {
        connection = (src as Gio.SocketClient).connect_finish(res) as Gio.SocketConnection
      } catch (e) {
        log(`[applets-socket-client] connect ${path} failed: ${String(e)}`)
        armRetry()
        return
      }
      conn = connection
      input = connection.get_input_stream()
      out = connection.get_output_stream()
      replyPending = EMPTY_BYTES
      queue = []
      writing = false
      const id = `hello-${nextId++}`
      const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_MS, () => {
        pending.delete(id)
        stopConnection("handshake timed out", true)
        return GLib.SOURCE_REMOVE
      })
      pending.set(id, (env) => {
        GLib.source_remove(timeout)
        if (!env.ok) {
          log(`[applets-socket-client] handshake refused: ${env.error.kind}: ${env.error.message}`)
          stopConnection("handshake refused", true)
          return
        }
        const value = env.value as { proto?: unknown } | null
        if (value?.proto !== SOCKET_PROTO) {
          log(
            `[applets-socket-client] proto mismatch: backend speaks ${String(value?.proto)} (this client speaks ${SOCKET_PROTO}) — degrading`,
          )
          stopConnection("proto mismatch", true)
          return
        }
        setState(true, `hello ok (${path})`)
      })
      readNext()
      send(helloLine(id))
    })
  }

  connect()

  return {
    isUp: () => up,
    invoke: (domain: string, member: string, args: unknown[]): Promise<Envelope> => {
      if (closed) return Promise.resolve(unreachable("transport closed"))
      if (conn === null) {
        // No connection: start one for the next poll and answer now — the
        // caller's placeholder path, never a hang.
        connect()
        return Promise.resolve(unreachable(`no connection to ${path}`))
      }
      const id = `${nextId++}`
      return new Promise<Envelope>((resolve) => {
        const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_MS, () => {
          pending.delete(id)
          resolve(unreachable(`'${domain} ${member}' did not answer in ${REQUEST_TIMEOUT_MS}ms`))
          return GLib.SOURCE_REMOVE
        })
        pending.set(id, (env) => {
          GLib.source_remove(timeout)
          resolve(env)
        })
        send(socketRequestLine(id, memberRequestTokens(domain, member, args)))
      })
    },
    close: () => {
      closed = true
      if (retry !== null) {
        GLib.source_remove(retry)
        retry = null
      }
      for (const settle of [...pending.values()]) settle(unreachable("transport closed"))
      pending.clear()
      setState(false, "closed")
      try {
        conn?.close(null)
      } catch {
        /* already gone */
      }
      conn = null
      input = null
      out = null
    },
  }
}
