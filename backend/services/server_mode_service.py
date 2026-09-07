"""Persistent sd-server lifecycle and API proxy support."""

import http.client
import re
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Iterable
from typing import Any

from .. import config
from ..context import AppContext
from ..http import InsecureBindError, insecure_bind_warning, require_secure_bind
from . import process_manager, sdcpp_manager

CURATED_SERVER_VALUE_FLAGS = {
    "--listen-ip",
    "--listen-port",
    "--serve-html-path",
    "--model",
    "-m",
    "--diffusion-model",
    "--vae",
    "--clip_l",
    "--clip_g",
    "--clip_vision",
    "--t5xxl",
    "--llm",
    "--llm_vision",
    "--taesd",
    "--control-net",
    "--embd-dir",
    "--lora-model-dir",
    "--width",
    "-W",
    "--height",
    "-H",
    "--steps",
    "--cfg-scale",
    "--sampling-method",
    "--scheduler",
    "--seed",
    "-s",
    "--threads",
    "-t",
    "--backend",
    "--params-backend",
    "--max-vram",
    "--type",
}

CURATED_SERVER_BOOL_FLAGS = {
    "--diffusion-fa",
    "--offload-to-cpu",
    "--mmap",
    "--vae-tiling",
    "--verbose",
    "-v",
    "--color",
}

SERVER_OWNED_FLAGS = {"--listen-ip", "--listen-port"}
MODEL_STARTUP_FLAGS = {"--model", "-m", "--diffusion-model"}
_TOKEN_RE = re.compile(r"^[^\x00-\x1f\x7f]*$")
_HOST_RE = re.compile(r"^[A-Za-z0-9_.:\-[\]]+$")
_POLL_INTERVAL = 0.5

# Bound proxy response reads so a malicious/hung sd-server can't force the GUI
# to buffer an unbounded payload (matches the /api proxy body allowance).
PROXY_RESPONSE_LIMIT = 500 * 1024 * 1024
PROXY_RESPONSE_CHUNK = 65536


def _target_url(host: str, port: int) -> str:
    display_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    if ":" in display_host and not display_host.startswith("["):
        display_host = f"[{display_host}]"
    return f"http://{display_host}:{port}"


def _validate_host(value: Any) -> str:
    host = str(value or config.SD_SERVER_HOST).strip()
    if not host or len(host) > 128 or not _HOST_RE.match(host) or "/" in host:
        raise ValueError("Invalid sd-server listen host.")
    return host


def _validate_port(value: Any) -> int:
    try:
        port = int(str(value or config.SD_SERVER_PORT).strip())
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid sd-server listen port.") from exc
    if port < 1 or port > 65535:
        raise ValueError("sd-server listen port must be between 1 and 65535.")
    return port


def _validate_token(token: str) -> str:
    if not isinstance(token, str) or not _TOKEN_RE.match(token):
        raise ValueError("Rejected unsafe sd-server argument.")
    if len(token) > 4096:
        raise ValueError("sd-server argument token is too long.")
    return token


def _flag_takes_value(flag: str) -> bool:
    return flag in CURATED_SERVER_VALUE_FLAGS


def _flatten_pairs(pairs: Iterable[Any] | None) -> list[str]:
    tokens: list[str] = []
    for pair in pairs or []:
        if not isinstance(pair, (list, tuple)) or not pair:
            raise ValueError("Server args must be structured [flag, value] pairs.")
        flag = _validate_token(str(pair[0]))
        if flag in SERVER_OWNED_FLAGS:
            continue
        if flag in CURATED_SERVER_BOOL_FLAGS:
            if len(pair) != 1:
                raise ValueError(f"{flag} does not accept a value.")
            tokens.append(flag)
            continue
        if not _flag_takes_value(flag):
            raise ValueError(f"Unsupported curated server flag: {flag}")
        if len(pair) < 2:
            raise ValueError(f"{flag} requires a value.")
        value = _validate_token(str(pair[1]))
        if value != "":
            tokens.extend([flag, value])
    return tokens


def _tokenize_extra(extra_args: Any) -> list[str]:
    raw = str(extra_args or "").strip()
    if not raw:
        return []
    try:
        tokens = shlex.split(raw)
    except ValueError as exc:
        raise ValueError(f"Invalid extra server args: {exc}") from exc
    allowed_flags = CURATED_SERVER_VALUE_FLAGS | CURATED_SERVER_BOOL_FLAGS
    validated: list[str] = []
    i = 0
    while i < len(tokens):
        tok = _validate_token(tokens[i])
        if tok in SERVER_OWNED_FLAGS:
            # Owned flags always take a value — skip both.
            i += 2
            continue
        if not tok.startswith("-"):
            raise ValueError(f"Unexpected value without a flag in extra args: {tok}")
        if tok not in allowed_flags:
            raise ValueError(f"Unsupported server flag in extra args: {tok}")
        validated.append(tok)
        if tok in CURATED_SERVER_VALUE_FLAGS:
            if i + 1 >= len(tokens):
                raise ValueError(f"{tok} requires a value in extra args.")
            validated.append(_validate_token(tokens[i + 1]))
            i += 2
        else:
            # Bool flag — no value follows.
            i += 1
    return validated


def _has_startup_model(args: list[str]) -> bool:
    return any(tok in MODEL_STARTUP_FLAGS for tok in args)


def build_argv(request: dict[str, Any]) -> dict[str, Any]:
    """Build final sd-server argv from curated pairs + extra args."""
    host = _validate_host(request.get("host") or request.get("listen_ip"))
    port = _validate_port(request.get("port") or request.get("listen_port"))
    args = [
        "--listen-ip",
        host,
        "--listen-port",
        str(port),
        *_flatten_pairs(request.get("args")),
        *_tokenize_extra(request.get("extra_args")),
    ]
    if not _has_startup_model(args):
        raise ValueError("Choose a model or diffusion model before starting sd-server.")
    return {"host": host, "port": port, "target_url": _target_url(host, port), "args": args}


def _append_log(ctx: AppContext, line: str) -> None:
    if not line:
        return
    with ctx.state.sd_server_log_lock:
        ctx.state.sd_server_log.append(line.rstrip("\n\r"))
        if len(ctx.state.sd_server_log) > config.PROCESS_OUTPUT_LIMIT:
            del ctx.state.sd_server_log[: config.PROCESS_OUTPUT_TRIM]
        log = "\n".join(ctx.state.sd_server_log[-120:])
    ctx.state.sd_server.update(log=log)


def _stream_log(ctx: AppContext, pipe) -> None:
    try:
        for line in iter(pipe.readline, ""):
            _append_log(ctx, line)
    except Exception:
        pass


def _connect_host(host: str) -> str:
    # Wildcard listen hosts are unreachable as connect targets on many
    # platforms; probe/proxy via loopback instead.
    return "127.0.0.1" if host in {"0.0.0.0", "::", ""} else host


def _probe_listening(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((_connect_host(host), port), timeout=timeout):
            return True
    except OSError:
        return False


def _monitor(ctx: AppContext, proc, host: str, port: int) -> None:
    # While the process is alive but still "starting" (binaries loading the
    # model can take minutes), probe the listen port and only then promote the
    # status to "running" — so the UI and the /v1 proxy never claim a server
    # that isn't accepting connections yet.
    while proc.poll() is None:
        snap = ctx.state.sd_server.snapshot()
        if snap.get("status") == "starting" and _probe_listening(host, port):
            with ctx.state.sd_server_lock:
                if (
                    ctx.state.sd_server_process is proc
                    and ctx.state.sd_server.snapshot().get("status") == "starting"
                ):
                    ctx.state.sd_server.update(
                        status="running",
                        pid=proc.pid,
                        message=f"sd-server running at {_target_url(host, port)}",
                    )
        time.sleep(_POLL_INTERVAL)
    with ctx.state.sd_server_lock:
        if ctx.state.sd_server_process is proc:
            rc = proc.returncode
            ctx.state.sd_server_process = None
            ctx.state.sd_server.update(
                status="idle" if rc == 0 else "error",
                pid=None,
                host=host,
                port=port,
                target_url=_target_url(host, port),
                message="sd-server stopped." if rc == 0 else f"sd-server exited with code {rc}.",
            )


def _read_bounded(resp, limit: int) -> bytes:
    """Read at most ``limit`` bytes so a hung/malicious sd-server can't force
    unbounded buffering in the GUI process.

    Raises ValueError when more than ``limit`` bytes remain so callers can
    answer 502 instead of silently truncating the payload.
    """
    chunks: list[bytes] = []
    remaining = limit
    read = getattr(resp, "read", None)
    while remaining > 0:
        try:
            chunk = read(min(PROXY_RESPONSE_CHUNK, remaining))  # type: ignore[misc]
        except TypeError:
            # Test doubles / minimal file-likes may only support read() with no
            # size argument — fall back to a single unbounded read.
            chunk = read()  # type: ignore[misc]
            if chunk:
                chunks.append(chunk)
            break
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    if remaining <= 0:
        try:
            extra = read(1)  # type: ignore[misc]
        except TypeError:
            extra = None
        if extra:
            raise ValueError("sd-server response too large")
    return b"".join(chunks)


def _port_in_use_error(host: str, port: int) -> dict[str, Any]:
    connect = _connect_host(host)
    return {
        "error": (
            f"sd-server listen port {port} is already in use on {connect} "
            f"(something is already accepting TCP connections). "
            f"Stop the other process or choose a different port."
        ),
        "status": 409,
    }


def start(ctx: AppContext, request: dict[str, Any]) -> dict[str, Any]:
    try:
        prepared = build_argv(request)
    except ValueError as exc:
        return {"error": str(exc), "status": 400}

    host = prepared["host"]
    port = prepared["port"]

    # Non-loopback listen exposes sd-server directly (bypasses GUI proxy/token).
    # Mirror the GUI's require_secure_bind policy: refuse unless a token is set
    # or insecure mode was explicitly opted in. Security refusal (403), not a
    # warning-only path. API backward compatible except for this refusal.
    try:
        token = str(config.GUI_TOKEN or "")
        require_secure_bind(host, token, bool(config.GUI_ALLOW_INSECURE))
    except InsecureBindError as exc:
        return {"error": str(exc), "status": 403}
    warning = insecure_bind_warning(host, token, bool(config.GUI_ALLOW_INSECURE))
    if warning:
        print(warning, file=sys.stderr)
    else:
        listen_host = (host or "").strip().lower()
        if (
            listen_host
            and listen_host not in {"127.0.0.1", "localhost", "::1"}
            and not listen_host.startswith("127.")
        ):
            print(
                f"WARNING: sd-server listen host is {host!r} (non-loopback). "
                "Prefer 127.0.0.1 and reach the API via the GUI proxy with "
                "SD_GUI_TOKEN set if exposing the control plane.",
                file=sys.stderr,
            )

    # Fast pre-check under the lock: refuse if already running.
    with ctx.state.sd_server_lock:
        proc = ctx.state.sd_server_process
        if proc is not None and proc.poll() is None:
            return {"error": "sd-server is already running.", "status": 409}

    # Refuse to spawn if the target connect host:port is already accepting TCP
    # (another sd-server, leftover process, or unrelated service). Checked
    # outside the lock; re-checked under the lock immediately before Popen.
    if _probe_listening(host, port):
        return _port_in_use_error(host, port)

    # Expensive validation (otool -L on macOS) runs OUTSIDE the lock so status
    # polls / stop are not blocked.
    exe_path = ctx.services.find_tool_executable(ctx, "sd-server")
    if not exe_path.exists():
        return {
            "error": "sd-server not found. Install stable-diffusion.cpp first.",
            "status": 400,
        }

    runtime_health = sdcpp_manager.validate_runtime_dependencies(ctx, ["sd-server"])
    missing_runtime_files = runtime_health.get("missing_runtime_files") or []
    if missing_runtime_files:
        missing = ", ".join(str(name) for name in missing_runtime_files)
        return {
            "error": (
                "Missing stable-diffusion.cpp runtime libraries: "
                f"{missing}. Use Repair Install to reinstall binaries."
            ),
            "status": 400,
        }

    command = [str(exe_path), *prepared["args"]]
    env = process_manager._build_process_env(ctx)

    # Re-acquire the lock to spawn + record. Re-check in case another start won
    # the race during validation, or the port became busy.
    with ctx.state.sd_server_lock:
        proc = ctx.state.sd_server_process
        if proc is not None and proc.poll() is None:
            return {"error": "sd-server is already running.", "status": 409}
        if _probe_listening(host, port):
            return _port_in_use_error(host, port)

        with ctx.state.sd_server_log_lock:
            ctx.state.sd_server_log.clear()

        ctx.state.sd_server.update(
            status="starting",
            pid=None,
            host=host,
            port=port,
            target_url=prepared["target_url"],
            command=" ".join(command),
            message="Starting sd-server...",
            log="",
        )

        try:
            proc = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE,
                text=True,
                env=env,
                cwd=str(ctx.paths.root),
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
            )
        except Exception as exc:
            ctx.state.sd_server.update(
                status="error", pid=None, message="Failed to start sd-server."
            )
            return {"error": str(exc), "status": 500}

        ctx.state.sd_server_process = proc
        threading.Thread(target=_stream_log, args=(ctx, proc.stdout), daemon=True).start()
        threading.Thread(target=_stream_log, args=(ctx, proc.stderr), daemon=True).start()
        threading.Thread(
            target=_monitor,
            args=(ctx, proc, host, port),
            daemon=True,
            name=f"sd-server-{proc.pid}",
        ).start()
        # Stay in "starting" — the monitor thread promotes to "running" once
        # the listen port accepts TCP while ``sd_server_process is proc``
        # (model load can take minutes; the proxy 503s anything that isn't
        # "running"). This is not full process/socket ownership — only that
        # our tracked proc is still current and something accepts on the port.
        # No dedicated sd-server HTTP health endpoint is assumed.
        return ctx.state.sd_server.update(
            pid=proc.pid,
            message="sd-server starting (loading model)...",
        )


def stop(ctx: AppContext) -> bool:
    """Stop sd-server. Blocking terminate/wait run outside sd_server_lock."""
    with ctx.state.sd_server_lock:
        proc = ctx.state.sd_server_process
        if not proc or proc.poll() is not None:
            ctx.state.sd_server_process = None
            ctx.state.sd_server.update(status="idle", pid=None, message="sd-server is not running.")
            return False
        ctx.state.sd_server.update(status="stopping", message="Stopping sd-server...")
    # terminate/wait OUTSIDE the lock so status polls / start aren't blocked.
    try:
        if sys.platform == "win32":
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    # Only clear if a new server hasn't been started in the meantime.
    with ctx.state.sd_server_lock:
        if ctx.state.sd_server_process is proc:
            ctx.state.sd_server_process = None
            ctx.state.sd_server.update(status="idle", pid=None, message="sd-server stopped.")
    return True


def status(ctx: AppContext) -> dict[str, Any]:
    snap = ctx.state.sd_server.snapshot()
    proc = ctx.state.sd_server_process
    if proc is not None and proc.poll() is None:
        if snap.get("status") not in {"running", "starting"}:
            # Drift recovery: process alive but state says otherwise. Promote
            # to "starting" — the monitor thread's port probe confirms
            # "running" so we never report a server that isn't listening.
            snap = ctx.state.sd_server.update(status="starting", pid=proc.pid)
    elif snap.get("status") in {"running", "starting", "stopping"}:
        snap = ctx.state.sd_server.update(
            status="idle", pid=None, message="sd-server is not running."
        )
    return snap


def proxy(
    ctx: AppContext,
    method: str,
    path: str,
    query: str,
    headers: dict[str, str],
    body: bytes,
) -> tuple[int, dict[str, str], bytes]:
    snap = status(ctx)
    if snap.get("status") == "starting":
        return (
            503,
            {"Content-Type": "application/json; charset=utf-8"},
            b'{"error":"sd-server is still starting (loading model). Try again shortly."}',
        )
    if snap.get("status") != "running":
        return (
            503,
            {"Content-Type": "application/json; charset=utf-8"},
            b'{"error":"sd-server is not running."}',
        )
    host = str(snap.get("host") or config.SD_SERVER_HOST)
    port = int(snap.get("port") or config.SD_SERVER_PORT)
    connect_host = _connect_host(host)
    target_path = path + (f"?{query}" if query else "")
    try:
        timeout = float(config.SD_SERVER_PROXY_TIMEOUT)
    except (TypeError, ValueError):
        timeout = config.DEFAULT_SD_SERVER_PROXY_TIMEOUT
    timeout = min(max(timeout, 1.0), config.PROXY_TIMEOUT_MAX)
    conn = http.client.HTTPConnection(connect_host, port, timeout=timeout)
    # Never forward GUI auth secrets to sd-server (loopback or otherwise).
    _deny = {
        "host",
        "content-length",
        "connection",
        "accept-encoding",
        "authorization",
        "x-sd-gui-token",
    }
    forward_headers = {key: value for key, value in headers.items() if key.lower() not in _deny}
    try:
        conn.request(method, target_path, body=body or None, headers=forward_headers)
        resp = conn.getresponse()
        try:
            payload = _read_bounded(resp, PROXY_RESPONSE_LIMIT)
        except ValueError as exc:
            print(f"[proxy] {exc}", file=sys.stderr, flush=True)
            return (
                502,
                {"Content-Type": "application/json; charset=utf-8"},
                b'{"error":"sd-server response too large"}',
            )
        response_headers = {
            key: value
            for key, value in resp.getheaders()
            if key.lower()
            not in {
                "transfer-encoding",
                "connection",
                "keep-alive",
                "proxy-authenticate",
                "proxy-authorization",
            }
        }
        return resp.status, response_headers, payload
    finally:
        conn.close()
