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
