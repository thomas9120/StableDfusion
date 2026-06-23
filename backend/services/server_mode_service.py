"""Persistent sd-server lifecycle and API proxy support."""

import http.client
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Iterable
from typing import Any

from .. import config
from ..context import AppContext
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


def _strip_owned(tokens: list[str]) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok in SERVER_OWNED_FLAGS:
            i += 2
            continue
        out.append(tok)
        i += 1
    return out


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


def _monitor(ctx: AppContext, proc, host: str, port: int) -> None:
    while proc.poll() is None:
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


def start(ctx: AppContext, request: dict[str, Any]) -> dict[str, Any]:
    try:
        prepared = build_argv(request)
    except ValueError as exc:
        return {"error": str(exc), "status": 400}

    # Fast pre-check under the lock: refuse if already running.
    with ctx.state.sd_server_lock:
        proc = ctx.state.sd_server_process
        if proc is not None and proc.poll() is None:
            return {"error": "sd-server is already running.", "status": 409}

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
    # the race during validation.
    with ctx.state.sd_server_lock:
        proc = ctx.state.sd_server_process
        if proc is not None and proc.poll() is None:
            return {"error": "sd-server is already running.", "status": 409}

        with ctx.state.sd_server_log_lock:
            ctx.state.sd_server_log.clear()

        ctx.state.sd_server.update(
            status="starting",
            pid=None,
            host=prepared["host"],
            port=prepared["port"],
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
            args=(ctx, proc, prepared["host"], prepared["port"]),
            daemon=True,
            name=f"sd-server-{proc.pid}",
        ).start()
        return ctx.state.sd_server.update(
            status="running",
            pid=proc.pid,
            message=f"sd-server running at {prepared['target_url']}",
        )


def stop(ctx: AppContext) -> bool:
    with ctx.state.sd_server_lock:
        proc = ctx.state.sd_server_process
        if not proc or proc.poll() is not None:
            ctx.state.sd_server_process = None
            ctx.state.sd_server.update(status="idle", pid=None, message="sd-server is not running.")
            return False
        ctx.state.sd_server.update(status="stopping", message="Stopping sd-server...")
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
        ctx.state.sd_server_process = None
        ctx.state.sd_server.update(status="idle", pid=None, message="sd-server stopped.")
        return True


def status(ctx: AppContext) -> dict[str, Any]:
    snap = ctx.state.sd_server.snapshot()
    proc = ctx.state.sd_server_process
    if proc is not None and proc.poll() is None:
        if snap.get("status") not in {"running", "starting"}:
            snap = ctx.state.sd_server.update(status="running", pid=proc.pid)
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
    if snap.get("status") != "running":
        return (
            503,
            {"Content-Type": "application/json; charset=utf-8"},
            b'{"error":"sd-server is not running."}',
        )
    host = str(snap.get("host") or config.SD_SERVER_HOST)
    port = int(snap.get("port") or config.SD_SERVER_PORT)
    # Normalize wildcard listen hosts to loopback for the outbound proxy
    # connection (connecting to 0.0.0.0/:: is unreliable on many platforms).
    connect_host = "127.0.0.1" if host in {"0.0.0.0", "::", ""} else host
    target_path = path + (f"?{query}" if query else "")
    conn = http.client.HTTPConnection(connect_host, port, timeout=120)
    forward_headers = {
        key: value
        for key, value in headers.items()
        if key.lower() not in {"host", "content-length", "connection", "accept-encoding"}
    }
    try:
        conn.request(method, target_path, body=body or None, headers=forward_headers)
        resp = conn.getresponse()
        payload = resp.read()
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
