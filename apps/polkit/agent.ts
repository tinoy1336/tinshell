/**
 * polkit agent — the polkit AuthenticationAgent backed by promptd dialogs.
 *
 * polkitd (system bus) calls BeginAuthentication on every registered agent
 * when a polkit-protected action needs authorization (pkexec, GParted,
 * Flatpak install-time auth, …). This agent answers those calls by showing a
 * promptd `input` dialog (masked password) and running the polkit-127
 * authentication handshake.
 *
 * PROTOCOL — polkit 127 (verified against THIS machine + polkit 127 source):
 *  - Authority: org.freedesktop.PolicyKit1 /org/freedesktop/PolicyKit1/Authority
 *    on the system bus. RegisterAuthenticationAgent (sa{sv})ss, locale, path.
 *  - The agent exports org.freedesktop.PolicyKit1.AuthenticationAgent at an
 *    object path ON THE SAME SYSTEM-BUS CONNECTION used to register (polkitd
 *    records the caller's bus name + path; it cannot reach a session bus).
 *  - Subject kinds changed in 127: "unix-session" (details key "session-id"),
 *    NOT the old "session". unix-user identity: { uid: uint32 }.
 *  - **polkit 127 removed the agent→authority secret response.** The
 *    AuthenticationAgentResponse/2/3 methods now require a ROOT caller
 *    ("Only uid 0 may invoke this method") and carry no password. The PAM
 *    authentication happens in polkit-agent-helper-1, which runs as root via
 *    the socket-activated service /run/polkit/agent-helper.socket (the
 *    setuid helper is NOT installed on this machine — not setuid). The agent
 *    connects to the socket and runs the conversation:
 *        agent → helper: <user>\n <cookie>\n
 *        helper → agent: PAM_PROMPT_ECHO_OFF <prompt>\n   (on stdout/socket)
 *        agent → helper: <password>\n
 *        helper → agent: SUCCESS\n | FAILURE\n, then exits (as root it calls
 *        AuthenticationAgentResponse3(cookie, identity, subject) itself).
 *  - Cancellation = close the socket without a password: the helper's
 *    conversation fails and polkitd ends the auth session deterministically.
 *
 * NEVER log the password. Debug log goes to /tmp/tinshell-polkit-debug.log
 * (fileSink — launched from systemd, stdout is journaled not a terminal).
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
// shared infra via the @common/* alias
import { ignore, log } from "@common/log/logger"
import { run } from "@common/subprocess/run"

/** gjs provides TextEncoder as a global; the ES2023 lib doesn't declare it. */
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } }

const AUTHORITY_NAME = "org.freedesktop.PolicyKit1"
const AUTHORITY_PATH = "/org/freedesktop/PolicyKit1/Authority"
const AUTHORITY_IFACE = "org.freedesktop.PolicyKit1.Authority"
const AGENT_PATH = "/org/freedesktop/PolicyKit1/AuthenticationAgent"

/** The socket-activated PAM helper service (polkit 127, no setuid binary). */
const HELPER_SOCKET = "/run/polkit/agent-helper.socket"

/** The router (`tinshell-route`, shell-first), NOT `ags -i promptd`: in production
 *  promptd is a LAZY member of the SHELL instance and no `promptd` bus name
 *  exists, so a direct instance call answers `instance "promptd" is not
 *  runnning` and the dialog never opens (the notes save-as / files Ctrl+N
 *  rule). `tinshell-route` probes the live instances shell-first, reaches the same
 *  `input` dialog and forwards its reply on stdout. The ABSOLUTE path is
 *  deliberate — a non-interactive process has no ~/.local/bin on PATH. */
const ROUTER = GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin", "tinshell-route"])

/** How long the promptd password dialog may stay open before we fail fast. */
const PROMPT_TIMEOUT_MS = 120_000
/** How long the helper conversation may run before we abort it. */
const CONV_TIMEOUT_MS = 60_000

// Introspection is the least error-prone way to get the exact method/arg
// types onto the bus. Signatures match polkit's eggdbus agent interface.
const agentXml = `
<node>
  <interface name="org.freedesktop.PolicyKit1.AuthenticationAgent">
    <method name="BeginAuthentication">
      <arg type="s" name="action_id" direction="in"/>
      <arg type="s" name="message" direction="in"/>
      <arg type="s" name="icon_name" direction="in"/>
      <arg type="a{ss}" name="details" direction="in"/>
      <arg type="s" name="cookie" direction="in"/>
      <arg type="a(sa{sv})" name="identities" direction="in"/>
    </method>
    <method name="CancelAuthentication">
      <arg type="s" name="cookie" direction="in"/>
    </method>
  </interface>
</node>`

/** One in-flight password prompt + its helper conversation. */
interface HelperConv {
  conn: Gio.SocketConnection
  out: Gio.OutputStream
  reader: Gio.DataInputStream
  cancellable: Gio.Cancellable
}

interface PromptState {
  cookie: string
  uid: number
  /** The held BeginAuthentication invocation — replied to exactly once, when
   *  the outcome is known (see replyToBegin). */
  invocation: Gio.DBusMethodInvocation | null
  /** The promptd dialog subprocess (`tinshell-route promptd "input …"`). */
  proc: Gio.Subprocess | null
  timeoutId: number | null
  helper: HelperConv | null
  /** True once we have committed to an outcome (late callbacks are no-ops). */
  finalDone: boolean
  /** True when the attempt ended without a password (cancel/timeout/promptd
   *  error) — reported to polkitd as a dismissal, not a failed password. */
  dismissed: boolean
}

let conn: Gio.DBusConnection | null = null
let registered = false
let sessionId = ""
let locale = "C"
/** Subject args (JS form, built at call time — gjs can't nest pre-built
 *  Variants in tuples). */
let subjectArgs: [string, Record<string, GLib.Variant>] | null = null
let current: PromptState | null = null

// ── Public surface (used by app.ts + commands.ts) ──

interface AgentState {
  registered: boolean
  sessionId: string
  locale: string
  hasBus: boolean
  activeCookie: string | null
}

export function agentState(): AgentState {
  return {
    registered,
    sessionId,
    locale,
    hasBus: conn !== null,
    activeCookie: current?.cookie ?? null,
  }
}

export async function startAgent(): Promise<void> {
  try {
    conn = Gio.bus_get_sync(Gio.BusType.SYSTEM, null)
  } catch (e) {
    log(`system bus failed: ${(e as Error).message} — agent disabled`)
    return
  }
  try {
    const iface = Gio.DBusNodeInfo.new_for_xml(agentXml).interfaces[0]
    // 5-arg form: method closure + nullable get/set property closures.
    conn.register_object(AGENT_PATH, iface, onMethodCall, null, null)
    log(`agent object exported at ${AGENT_PATH}`)
  } catch (e) {
    log(`register_object failed: ${(e as Error).message} — agent disabled`)
    return
  }

  sessionId = await resolveSessionId()
  if (!sessionId) {
    log("could not resolve a valid session id — agent NOT registered")
    return
  }
  // polkit 127 subject kind: unix-session, details key "session-id".
  subjectArgs = ["unix-session", { "session-id": new GLib.Variant("s", sessionId) }]
  locale = GLib.getenv("LANG") || "C"

  try {
    await registerAgent()
    log(`registered with polkitd (subject=unix-session:${sessionId}, locale=${locale})`)
  } catch (e) {
    log(`registration failed: ${(e as Error).message}`)
  }
}

export async function registerAgent(): Promise<string> {
  if (!conn || !subjectArgs) throw new Error("system bus / subject not ready")
  // RegisterAuthenticationAgent (sa{sv})ss: subject, locale, object_path.
  // JS-array children (not pre-built Variants) — gjs tuple-nesting rule.
  const params = new GLib.Variant("((sa{sv})ss)", [subjectArgs, locale, AGENT_PATH])
  try {
    await callAuthority("RegisterAuthenticationAgent", params)
  } catch (e) {
    // Retry once — the session may have raced registration at startup.
    log(`register failed (${(e as Error).message}) — retrying once`)
    await callAuthority("RegisterAuthenticationAgent", params)
  }
  registered = true
  return sessionId
}

export async function unregisterAgent(): Promise<void> {
  if (!conn || !subjectArgs) return
  // UnregisterAuthenticationAgent (sa{sv})s: subject, object_path.
  const params = new GLib.Variant("((sa{sv})s)", [subjectArgs, AGENT_PATH])
  await callAuthority("UnregisterAuthenticationAgent", params)
  registered = false
}

// ── Authority calls ──

function callAuthority(method: string, params: GLib.Variant): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = conn
    if (!c) {
      reject(new Error("no system bus connection"))
      return
    }
    c.call(
      AUTHORITY_NAME,
      AUTHORITY_PATH,
      AUTHORITY_IFACE,
      method,
      params,
      null, // no reply type (void methods)
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_c: Gio.DBusConnection | null, res: Gio.AsyncResult) => {
        try {
          c.call_finish(res)
          resolve()
        } catch (e) {
          reject(e)
        }
      },
    )
  })
}

// ── D-Bus method dispatch (exported agent object) ──

function onMethodCall(
  _c: Gio.DBusConnection,
  _sender: string,
  _objectPath: string,
  _ifaceName: string,
  methodName: string,
  parameters: GLib.Variant,
  invocation: Gio.DBusMethodInvocation,
): void {
  if (methodName === "BeginAuthentication") {
    handleBegin(parameters, invocation)
  } else if (methodName === "CancelAuthentication") {
    const [cookie] = parameters.deep_unpack() as [string]
    handleCancel(cookie)
    invocation.return_value(null)
  } else {
    invocation.return_dbus_error(
      "org.freedesktop.DBus.Error.UnknownMethod",
      `Unknown method ${methodName}`,
    )
  }
}

/** The uid of a polkit identity's details. `deep_unpack()` leaves an `a{sv}`
 *  value as a `GLib.Variant` (variants are not unpacked recursively), so the
 *  `uid:u` arrives wrapped and must be unpacked before it can name a user. */
function identityUid(details: Record<string, unknown>): number {
  const raw = details.uid
  if (typeof raw === "number") return raw
  const v = raw as GLib.Variant | undefined
  return v && typeof v.unpack === "function" ? Number(v.unpack()) : 0
}

function handleBegin(parameters: GLib.Variant, invocation: Gio.DBusMethodInvocation): void {
  const [actionId, message, iconName, , cookie, identities] = parameters.deep_unpack() as [
    string,
    string,
    string,
    Record<string, string>,
    string,
    [string, Record<string, unknown>][],
  ]

  // Concurrent BeginAuthentication (two pkexec): fail the OLD prompt fast —
  // promptd rejects a second window with `error: busy: another prompt is
  // open`, so the old one can never complete anyway.
  if (current && !current.finalDone) {
    log(`concurrent BeginAuthentication (cookie ${current.cookie}) — failing old prompt`)
    current.dismissed = true
    killPrompt(current)
    completeAuthentication(current, "") // empty password → PAM fails → session ends
  }

  // The invocation is HELD until the outcome is known: polkitd's challenge
  // callback fires on this reply, so an immediate one would end the session as
  // "FAILED to authenticate" before the user ever answers (the reference
  // agent library keeps the invocation pending for the same reason).

  // Password only: pick the unix-user identity.
  const match = identities.find(([kind]) => kind === "unix-user")
  if (!match) {
    log(
      `no unix-user identity in BeginAuthentication (kinds: ${identities.map(([k]) => k).join(",")})`,
    )
    // Nothing to auth — dismiss any dialog and let polkitd expire the session.
    dismissPromptd()
    invocation.return_dbus_error(
      "org.freedesktop.PolicyKit1.Error.Cancelled",
      "authentication cancelled: no unix-user identity",
    )
    return
  }
  const uid = identityUid(match[1])

  const title = iconName || "Authentication required"
  const payload = JSON.stringify({
    mode: "masked",
    title,
    body: message || actionId,
    placeholder: "Password",
  })
  const b64 = GLib.base64_encode(new TextEncoder().encode(payload))

  const st: PromptState = {
    cookie,
    uid,
    invocation,
    proc: null,
    timeoutId: null,
    helper: null,
    finalDone: false,
    dismissed: false,
  }
  current = st

  st.proc = promptdInput([`input ${b64}`], (stdout, exit) => {
    if (st.finalDone) return
    const out = stdout.trimEnd()
    // Any non-password outcome (cancel / other promptd error / timeout /
    // empty) → empty password → PAM fails → deterministic session end.
    if (exit === -2 || out.startsWith("error:") || out === "") {
      log(`promptd returned "${out || "(empty)"}" for cookie ${cookie} — failing auth`)
      st.dismissed = true
      completeAuthentication(st, "")
    } else {
      completeAuthentication(st, out)
    }
  })

  st.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROMPT_TIMEOUT_MS, () => {
    if (!st.finalDone) {
      log(`prompt timed out for cookie ${cookie} — failing auth`)
      st.dismissed = true
      killPrompt(st)
      completeAuthentication(st, "")
    }
    return GLib.SOURCE_REMOVE
  })
}

function handleCancel(cookie: string): void {
  const st = current
  if (!st || st.cookie !== cookie || st.finalDone) return
  log(`CancelAuthentication (cookie ${cookie})`)
  st.dismissed = true
  killPrompt(st)
  dismissPromptd()
  st.finalDone = true
  current = null
  replyToBegin(st, "cancelled")
}

/** Reply to the held BeginAuthentication invocation — exactly once. polkitd's
 *  challenge callback fires on this reply, so it is sent only when the outcome
 *  is known: the password reached the helper and the conversation ended ok,
 *  the attempt was dismissed (cancel/timeout/no identity), or PAM failed. */
function replyToBegin(st: PromptState, outcome: "ok" | "failed" | "cancelled"): void {
  const inv = st.invocation
  if (!inv) return
  st.invocation = null
  try {
    if (outcome === "ok") inv.return_value(null)
    else
      inv.return_dbus_error(
        outcome === "cancelled"
          ? "org.freedesktop.PolicyKit1.Error.Cancelled"
          : "org.freedesktop.PolicyKit1.Error.Failed",
        outcome === "cancelled" ? "authentication cancelled" : "authentication failed",
      )
  } catch (e) {
    ignore("polkit BeginAuthentication reply", e)
  }
}

// ── promptd dialog subprocess (local helper — needs the proc handle to kill) ──

/** Spawn `tinshell-route promptd <args…>` (the ROUTER — see its comment) and hand
 *  back the process, so a cancel / concurrent begin can force-exit the dialog
 *  call. The base64 payload is one argv token: the router joins its arguments
 *  with spaces into the request string, so no shell quoting is involved. */
function promptdInput(
  args: string[],
  onDone: (stdout: string, exit: number) => void,
): Gio.Subprocess {
  const proc = Gio.Subprocess.new(
    [ROUTER, "promptd", ...args],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
  )
  proc.communicate_utf8_async(null, null, (_p: Gio.Subprocess | null, res: Gio.AsyncResult) => {
    let stdout = ""
    try {
      const [, out] = proc.communicate_utf8_finish(res)
      stdout = out ?? ""
    } catch (e) {
      // force_exit (cancel/concurrent) lands here — onDone must be idempotent.
      log(`promptd communicate failed: ${(e as Error).message}`)
    }
    onDone(stdout, proc.get_exit_status())
  })
  return proc
}

/** Dismiss whatever promptd window is open (fire-and-forget). */
function dismissPromptd(): void {
  try {
    Gio.Subprocess.new([ROUTER, "promptd", "close"], Gio.SubprocessFlags.STDERR_SILENCE)
  } catch (e) {
    log(`promptd close failed: ${(e as Error).message}`)
  }
}

/** Stop the dialog subprocess + helper conversation + timers. Does NOT
 *  commit an outcome — caller decides. */
function killPrompt(st: PromptState): void {
  if (st.timeoutId !== null) {
    GLib.source_remove(st.timeoutId)
    st.timeoutId = null
  }
  if (st.proc) {
    try {
      st.proc.force_exit()
    } catch (e) {
      // The helper already exited.
      ignore("polkit helper force-exit", e)
    }
    st.proc = null
  }
  closeHelper(st)
}

function closeHelper(st: PromptState): void {
  const h = st.helper
  if (!h) return
  st.helper = null
  try {
    h.cancellable.cancel()
  } catch (e) {
    ignore("polkit helper cancel", e)
  }
  try {
    h.conn.close(null)
  } catch (e) {
    ignore("polkit helper connection close", e)
  }
}

// ── polkit-127 helper conversation (the actual authentication) ──

/**
 * Run the PAM conversation against the socket-activated polkit-agent-helper:
 * write user + cookie, answer the PAM_PROMPT_ECHO_OFF with the password, and
 * observe SUCCESS/FAILURE. polkitd is notified by the helper itself (root
 * AuthenticationAgentResponse3) — the agent never calls a response method.
 * An empty password fails PAM deterministically (the cancel/timeout path).
 */
function completeAuthentication(st: PromptState, password: string): void {
  if (st.finalDone) return
  st.finalDone = true // committed — late promptd callbacks become no-ops
  if (current === st) current = null

  resolveUsername(st.uid)
    .then((user) => {
      if (!user) {
        log(`cannot resolve username for uid ${st.uid} — auth failed`)
        replyToBegin(st, "failed")
        return
      }
      startHelperConversation(st, user, password)
    })
    .catch((e: Error) => {
      log(`username resolution failed: ${e.message}`)
      replyToBegin(st, "failed")
    })
}

function resolveUsername(uid: number): Promise<string> {
  return run(["id", "-un", String(uid)], { timeoutMs: 5000 }).then((r) => r.stdout.trim())
}

function startHelperConversation(st: PromptState, user: string, password: string): void {
  if (st.helper) return
  let conn_: Gio.SocketConnection
  try {
    const client = new Gio.SocketClient()
    conn_ = client.connect(
      new Gio.UnixSocketAddress({ path: HELPER_SOCKET }),
      null,
    ) as Gio.SocketConnection
  } catch (e) {
    // No setuid helper on this machine — nothing else to fall back to.
    log(`helper socket connect failed: ${(e as Error).message} — auth failed`)
    replyToBegin(st, "failed")
    return
  }
  const h: HelperConv = {
    conn: conn_,
    out: conn_.output_stream as Gio.OutputStream,
    reader: new Gio.DataInputStream({ base_stream: conn_.input_stream }),
    cancellable: new Gio.Cancellable(),
  }
  st.helper = h

  try {
    const enc = new TextEncoder()
    h.out.write_all(enc.encode(`${user}\n`), null)
    h.out.write_all(enc.encode(`${st.cookie}\n`), null)
  } catch (e) {
    log(`helper write failed: ${(e as Error).message} — auth failed`)
    closeHelper(st)
    replyToBegin(st, "failed")
    return
  }

  // Bound the conversation (a hung PAM module must not wedge pkexec forever).
  const convTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONV_TIMEOUT_MS, () => {
    log(`helper conversation timed out (cookie ${st.cookie})`)
    closeHelper(st)
    replyToBegin(st, st.dismissed ? "cancelled" : "failed")
    return GLib.SOURCE_REMOVE
  })

  const finish = (ok: boolean): void => {
    GLib.source_remove(convTimeout)
    log(`helper conversation done (cookie ${st.cookie}, ${ok ? "SUCCESS" : "FAILURE"})`)
    closeHelper(st)
    replyToBegin(st, ok ? "ok" : st.dismissed ? "cancelled" : "failed")
  }

  pumpHelper(st, password, finish)
}

/** Read helper lines; answer PAM_PROMPT_ECHO_OFF with the password. */
function pumpHelper(st: PromptState, password: string, finish: (ok: boolean) => void): void {
  const h = st.helper
  if (!h) return
  h.reader.read_line_async(
    GLib.PRIORITY_DEFAULT,
    h.cancellable,
    (_s: Gio.DataInputStream | null, res: Gio.AsyncResult) => {
      if (!st.helper) return // closed (cancel/timeout) — no further action
      let line: Uint8Array | null = null
      try {
        line = h.reader.read_line_finish(res)[0]
      } catch (e) {
        // cancelled — conversation aborted (close/timeout cancelled the read)
        ignore("polkit helper read cancelled", e)
        return
      }
      if (!line) {
        // EOF without SUCCESS → helper died (e.g. PAM failure) → session failed.
        finish(false)
        return
      }
      const text = new TextDecoder().decode(line).replace(/\n$/, "")
      if (text.startsWith("PAM_PROMPT_ECHO_OFF")) {
        try {
          h.out.write_all(new TextEncoder().encode(`${password}\n`), null)
        } catch {
          finish(false)
          return
        }
        pumpHelper(st, password, finish)
      } else if (text.startsWith("SUCCESS")) {
        finish(true)
      } else if (text.startsWith("FAILURE")) {
        finish(false)
      } else {
        // PAM_PROMPT_ECHO_ON / PAM_ERROR_MSG / PAM_TEXT_INFO — informational.
        pumpHelper(st, password, finish)
      }
    },
  )
}

// ── Session resolution ──

/**
 * Resolve the polkit subject session id — the session polkitd will derive for
 * THIS process, because RegisterAuthenticationAgent rejects a subject naming
 * any other session ("Passed session and the session the caller is in
 * differs"). polkitd's own session monitor derives it from the caller's
 * pidfd/cgroup (sd_pid_get_session) and, when the process has no session
 * scope, from the caller's uid → the user's ACTIVE graphical session
 * (sd_uid_get_display). A systemd user service — and the shell launched from
 * one — lives in user@.service, so the display fallback is the one that
 * answers.
 *
 *  1. `loginctl show-session self` = our pid's session (the instance runs
 *     inside a session scope: a run.sh debug launch, or the shell started
 *     from the graphical session).
 *  2. `loginctl show-user <user> -p Display` = the user's display session —
 *     the same source polkitd's uid fallback reads (hyprpolkitagent resolves
 *     its own session this way for exactly this reason).
 *
 * A bare `loginctl list-sessions` first row is NOT a session of ours: it is
 * the lingering user manager's `manager` session — never name it.
 */
async function resolveSessionId(): Promise<string> {
  const own = await loginctl(["show-session", "self", "-p", "Id", "--value"])
  if (own) return own
  return await loginctl(["show-user", GLib.get_user_name(), "-p", "Display", "--value"])
}

/** Run a loginctl query and return its single-word answer ("" on failure). */
async function loginctl(args: string[]): Promise<string> {
  try {
    const r = await run(["loginctl", ...args], { timeoutMs: 5000 })
    const out = r.stdout.trim()
    if (r.exit !== 0) return ""
    return /^[A-Za-z0-9._-]+$/.test(out) ? out : ""
  } catch (e) {
    log(`loginctl ${args.slice(0, 2).join(" ")} failed: ${(e as Error).message}`)
    return ""
  }
}
