import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services import server_mode_service  # noqa: E402


def test_build_argv_curated_flags_and_listener():
    result = server_mode_service.build_argv(
        {
            "host": "127.0.0.1",
            "port": 1234,
            "args": [
                ["--model", "models/sd15.gguf"],
                ["--width", "768"],
                ["--diffusion-fa"],
            ],
        }
    )

    assert result["target_url"] == "http://127.0.0.1:1234"
    assert result["args"][:4] == ["--listen-ip", "127.0.0.1", "--listen-port", "1234"]
    assert "--model" in result["args"]
    assert "models/sd15.gguf" in result["args"]
    assert "--diffusion-fa" in result["args"]


def test_build_argv_strips_listener_from_curated_pairs_and_extra_args():
    result = server_mode_service.build_argv(
        {
            "host": "0.0.0.0",
            "port": 8123,
            "args": [
                ["--listen-port", "9999"],
                ["--diffusion-model", "models/diffusion/model.gguf"],
                ["--steps", "12"],
            ],
            # --listen-ip is server-owned → stripped from extra args.
            # --verbose is a curated bool flag → passes through.
            "extra_args": "--listen-ip 1.2.3.4 --verbose",
        }
    )

    assert result["args"][:4] == ["--listen-ip", "0.0.0.0", "--listen-port", "8123"]
    assert "9999" not in result["args"]
    assert "1.2.3.4" not in result["args"]
    assert "--verbose" in result["args"]


def test_build_argv_rejects_non_curated_flag_in_extra_args():
    """M7 — _tokenize_extra must enforce the curated-flag allowlist."""
    try:
        server_mode_service.build_argv(
            {
                "args": [["--model", "models/sd15.gguf"]],
                "extra_args": "--cache-mode easycache",
            }
        )
    except ValueError as exc:
        assert "Unsupported server flag" in str(exc)
    else:
        raise AssertionError("non-curated extra flag was accepted")


def test_build_argv_rejects_unknown_curated_flag():
    result = None
    try:
        result = server_mode_service.build_argv({"args": [["--not-real", "x"]]})
    except ValueError as exc:
        assert "Unsupported curated server flag" in str(exc)
    assert result is None


def test_build_argv_rejects_bad_port():
    try:
        server_mode_service.build_argv({"port": 70000})
    except ValueError as exc:
        assert "port" in str(exc)
    else:
        raise AssertionError("bad port was accepted")


def test_build_argv_rejects_missing_startup_model():
    try:
        server_mode_service.build_argv({"args": [["--steps", "12"]]})
    except ValueError as exc:
        assert "model" in str(exc)
    else:
        raise AssertionError("missing model was accepted")


# ── startup readiness (port probe promotes "starting" → "running") ────────


def _ctx():
    from backend.context import AppContext

    return AppContext()


class _FakeAliveProc:
    pid = 4242
    returncode = None

    def poll(self):
        return None


def test_probe_listening_true_for_listening_socket():
    import socket as _socket

    server = _socket.socket()
    try:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        assert server_mode_service._probe_listening("127.0.0.1", port, timeout=1.0) is True
    finally:
        server.close()


def test_probe_listening_false_for_closed_port():
    import socket as _socket

    # Bind then close to get a port that is (very likely) not listening.
    probe = _socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    assert server_mode_service._probe_listening("127.0.0.1", port, timeout=0.5) is False


def test_monitor_promotes_starting_to_running_when_port_opens(monkeypatch):
    ctx = _ctx()
    proc = _FakeAliveProc()
    ctx.state.sd_server_process = proc
    ctx.state.sd_server.update(status="starting", pid=None, message="starting")

    monkeypatch.setattr(server_mode_service, "_probe_listening", lambda *a, **kw: True)

    observed = []

    def fake_sleep(_seconds):
        observed.append(ctx.state.sd_server.snapshot().get("status"))
        # End the monitor loop once the promotion has been observed.
        if "running" in observed:
            proc.poll = lambda: 0
            proc.returncode = 0

    monkeypatch.setattr(server_mode_service.time, "sleep", fake_sleep)
    server_mode_service._monitor(ctx, proc, "127.0.0.1", 1234)

    assert "running" in observed
    # Process "exited" with rc 0 at the end of the test → final state is idle.
    assert ctx.state.sd_server.snapshot().get("status") == "idle"


def test_proxy_503s_with_starting_message_while_loading():
    ctx = _ctx()
    ctx.state.sd_server_process = _FakeAliveProc()
    ctx.state.sd_server.update(status="starting", pid=4242)

    code, headers, payload = server_mode_service.proxy(ctx, "GET", "/v1/models", "", {}, b"")
    assert code == 503
    assert b"still starting" in payload


def test_proxy_strips_gui_auth_headers(monkeypatch):
    """GUI Authorization / x-sd-gui-token must never reach sd-server."""
    ctx = _ctx()
    ctx.state.sd_server_process = _FakeAliveProc()
    ctx.state.sd_server.update(
        status="running",
        pid=4242,
        host="127.0.0.1",
        port=8765,
    )

    captured = {}

    class FakeResp:
        status = 200

        def read(self):
            return b'{"ok":true}'

        def getheaders(self):
            return [("Content-Type", "application/json")]

    class FakeConn:
        def __init__(self, host, port, timeout=None):
            captured["host"] = host
            captured["port"] = port

        def request(self, method, path, body=None, headers=None):
            captured["method"] = method
            captured["path"] = path
            captured["headers"] = dict(headers or {})

        def getresponse(self):
            return FakeResp()

        def close(self):
            pass

    monkeypatch.setattr(server_mode_service.http.client, "HTTPConnection", FakeConn)

    inbound = {
        "Host": "gui.example",
        "Content-Length": "0",
        "Connection": "keep-alive",
        "Accept-Encoding": "gzip",
        "Authorization": "Bearer gui-secret",
        "X-SD-GUI-Token": "gui-token-value",
        "Content-Type": "application/json",
        "X-Request-Id": "keep-me",
    }
    code, _headers, payload = server_mode_service.proxy(ctx, "GET", "/v1/models", "", inbound, b"")
    assert code == 200
    assert payload == b'{"ok":true}'
    out = {k.lower(): v for k, v in captured["headers"].items()}
    assert "authorization" not in out
    assert "x-sd-gui-token" not in out
    assert "host" not in out
    assert "content-length" not in out
    assert "connection" not in out
    assert "accept-encoding" not in out
    assert out.get("content-type") == "application/json"
    assert out.get("x-request-id") == "keep-me"


def test_connect_host_maps_wildcard_to_loopback():
    assert server_mode_service._connect_host("0.0.0.0") == "127.0.0.1"
    assert server_mode_service._connect_host("::") == "127.0.0.1"
    assert server_mode_service._connect_host("") == "127.0.0.1"
    assert server_mode_service._connect_host("127.0.0.1") == "127.0.0.1"
    assert server_mode_service._connect_host("192.168.1.10") == "192.168.1.10"


def test_start_refuses_when_port_already_in_use(monkeypatch):
    """Busy-port guard: do not spawn if connect host:port already accepts TCP."""
    ctx = _ctx()
    monkeypatch.setattr(server_mode_service, "_probe_listening", lambda *a, **kw: True)

    spawned = []

    def boom(*_a, **_kw):
        spawned.append(True)
        raise AssertionError("Popen must not run when port is busy")

    monkeypatch.setattr(server_mode_service.subprocess, "Popen", boom)

    result = server_mode_service.start(
        ctx,
        {
            "host": "127.0.0.1",
            "port": 1234,
            "args": [["--model", "models/sd15.gguf"]],
        },
    )

    assert result.get("status") == 409
    assert "already in use" in result.get("error", "").lower()
    assert not spawned
    assert ctx.state.sd_server_process is None
    assert ctx.state.sd_server.snapshot().get("status") not in {"running", "starting"}
