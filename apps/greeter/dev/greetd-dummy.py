#!/usr/bin/env python3
"""greetd-dummy.py — a fake greetd IPC server for testing the greeter's login
flow without a real greetd/PAM (no lockout risk, no session teardown).

Mirrors greetd-ipc(7): 4-byte native-endian length prefix + JSON payload.
IMPORTANT (verified against AstalGreet's model.vala): the client opens a NEW
socket connection per request and closes it after the response, so the server
accepts one connection per request. It also sends an extra CancelSession
request (new connection) after any error response.

Behaviour mirrors greetd's real auth flow:
  create_session → auth_message(visible "Login:") → post_auth (username)
                → auth_message(secret "Password:") → post_auth (password)
                → password == "wrong" → error(auth_error)   [client: cancelled]
                → otherwise            → success             [client: authenticated]
start_session is logged, never executed.

Usage:
  python3 greetd-dummy.py > /tmp/greetd-dummy.log 2>&1 &
  GREETD_SOCK=/tmp/greetd-dummy.sock TINSHELL_GREETER_HARNESS=1 <greeter bundle>
"""
import json
import os
import socket
import struct

SOCK = os.environ.get("GREETD_DUMMY_SOCK", "/tmp/greetd-dummy.sock")
# The one "correct" password — anything else fails like a real login.
PW = "789"


def send(conn: socket.socket, obj: dict) -> None:
    payload = json.dumps(obj).encode()
    conn.sendall(struct.pack("<I", len(payload)) + payload)


def recv(conn: socket.socket) -> dict | None:
    head = conn.recv(4)
    if not head:
        return None
    (ln,) = struct.unpack("<I", head)
    body = b""
    while len(body) < ln:
        chunk = conn.recv(ln - len(body))
        if not chunk:
            return None
        body += chunk
    try:
        return json.loads(body)
    except (ValueError, TypeError):
        return None


def main() -> None:
    try:
        os.unlink(SOCK)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK)
    srv.listen(4)
    print(f"[dummy] listening on {SOCK}", flush=True)

    # Session state persists across the per-request connections.
    phase: str | None = None  # None | "visible" | "secret"
    username = ""

    while True:
        conn, _ = srv.accept()
        req = recv(conn)
        if req is None:
            conn.close()
            continue
        t = req.get("type")
        print(f"[dummy] request: {t} {req}", flush=True)
        if t == "create_session":
            username = req.get("username", "")
            phase = "visible"
            send(conn, {"type": "auth_message", "auth_message_type": "visible", "auth_message": "Login:"})
        elif t == "post_auth_message_response":
            if phase == "visible":
                username = req.get("response", "") or username
                phase = "secret"
                send(conn, {"type": "auth_message", "auth_message_type": "secret", "auth_message": "Password:"})
            elif phase == "secret":
                password = req.get("response", "")
                phase = None
                if password != PW:
                    send(
                        conn,
                        {
                            "type": "error",
                            "error_type": "auth_error",
                            "description": "password incorrect — try again",
                        },
                    )
                    print(f"[dummy] FAILED password={password!r}", flush=True)
                else:
                    send(conn, {"type": "success"})
                    print(f"[dummy] AUTH OK user={username!r}", flush=True)
            else:
                send(conn, {"type": "error", "error_type": "error", "description": "unexpected response"})
        elif t == "start_session":
            # Client expects one response; the app quits right after.
            send(conn, {"type": "success"})
            print(f"[dummy] start_session cmd={req.get('cmd')} env={req.get('env')}", flush=True)
        elif t == "cancel_session":
            # The client sends this on a fresh connection after an error;
            # its callback ignores the response body (only success/error/
            # auth_message parse cleanly).
            send(conn, {"type": "success"})
            print("[dummy] cancel_session", flush=True)
        else:
            print(f"[dummy] unhandled request: {t}", flush=True)
            send(conn, {"type": "error", "error_type": "error", "description": f"unhandled {t}"})
        conn.close()


if __name__ == "__main__":
    main()
