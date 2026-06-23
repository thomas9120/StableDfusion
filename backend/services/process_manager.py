"""Subprocess management for sd-cli and sd-server.

Adapted from LLama-GUI's process_manager.py. Shared by the one-shot generator
(services/generate_service.py) and the persistent sd-server
(routes/server_mode.py). Also used by lifecycle to stop a running process on
shutdown/restart.
"""

import os
import signal
import subprocess
import sys
import threading
from collections.abc import Iterable
from typing import Any

from .. import config
from ..context import AppContext


def is_process_running(ctx: AppContext) -> bool:
    with ctx.state.process_lock:
        return ctx.state.process is not None and ctx.state.process.poll() is None


def get_output_snapshot(ctx: AppContext) -> dict[str, Any]:
    with ctx.state.output_buffer_lock:
        lines = list(ctx.state.output_buffer)
    with ctx.state.stderr_buffer_lock:
        stderr_lines = list(ctx.state.stderr_buffer)
    return {"output": lines, "stderr": stderr_lines, "running": is_process_running(ctx)}


def flatten_launch_args(args_list: Iterable[Any] | None) -> list[str]:
    flat: list[str] = []
    for entry in args_list or []:
        if isinstance(entry, list):
            flat.extend(str(v) for v in entry)
        else:
            flat.append(str(entry))
    return flat


def _build_process_env(ctx: AppContext) -> dict[str, str]:
    """Prepend active stable-diffusion.cpp bin to PATH/library paths."""
    from . import sdcpp_manager

    env = os.environ.copy()
    runtime_paths = [str(sdcpp_manager.get_active_runtime_bin(ctx))]
    existing = env.get("PATH", "")
    env["PATH"] = os.pathsep.join(runtime_paths + ([existing] if existing else []))
    platform_name = ctx.services.current_platform or sys.platform
    if platform_name.startswith("linux"):
        existing_ld = env.get("LD_LIBRARY_PATH", "")
        env["LD_LIBRARY_PATH"] = os.pathsep.join(
            runtime_paths + ([existing_ld] if existing_ld else [])
        )
    elif platform_name == "darwin":
        existing_dyld = env.get("DYLD_LIBRARY_PATH", "")
        env["DYLD_LIBRARY_PATH"] = os.pathsep.join(
            runtime_paths + ([existing_dyld] if existing_dyld else [])
        )
    return env


def stream_output(ctx: AppContext, pipe, is_stderr: bool = False) -> None:
    try:
        for line in iter(pipe.readline, ""):
            if line:
                if is_stderr:
                    with ctx.state.stderr_buffer_lock:
                        ctx.state.stderr_buffer.append(line.rstrip("\n\r"))
                        if len(ctx.state.stderr_buffer) > config.PROCESS_OUTPUT_LIMIT:
                            del ctx.state.stderr_buffer[: config.PROCESS_OUTPUT_TRIM]
                else:
                    with ctx.state.output_buffer_lock:
                        ctx.state.output_buffer.append(line.rstrip("\n\r"))
                        if len(ctx.state.output_buffer) > config.PROCESS_OUTPUT_LIMIT:
                            del ctx.state.output_buffer[: config.PROCESS_OUTPUT_TRIM]
    except Exception:
        pass


def launch_process(ctx: AppContext, tool: str, args_list: Iterable[Any] | None) -> dict[str, Any]:
    """Spawn ``tool`` (sd-cli / sd-server) with args. One process at a time.

    Returns ``{pid, command}`` on success or ``{error}`` on failure. Streams
    stdout/stderr into the shared output buffer via background threads. On
    Windows the process gets its own process group so it can be stopped with
    CTRL_BREAK_EVENT.

    The expensive validation (``validate_runtime_dependencies`` runs ``otool -L``
    on macOS) happens OUTSIDE ``process_lock`` so the status poller / stop_process
    are not blocked. The lock is only held for the "already running" check and
    the ``Popen`` + state assignment (both fast).
    """
    from . import sdcpp_manager

    # Fast pre-check under the lock: refuse if a process is already running.
    with ctx.state.process_lock:
        if ctx.state.process and ctx.state.process.poll() is None:
            return {"error": "A process is already running"}

    allowed_tools = ctx.services.sdcpp_tools or ()
    if tool not in allowed_tools:
        return {"error": f"Unknown tool: {tool!r}"}

    exe_name = ctx.services.get_tool_filename(tool)
    exe_path = ctx.services.find_tool_executable(ctx, tool)
    if not exe_path.exists():
        return {"error": f"{exe_name} not found. Install stable-diffusion.cpp first."}

    runtime_health = sdcpp_manager.validate_runtime_dependencies(ctx, [tool])
    missing_runtime_files = runtime_health.get("missing_runtime_files") or []
    if missing_runtime_files:
        missing = ", ".join(str(name) for name in missing_runtime_files)
        plural = "libraries" if len(missing_runtime_files) != 1 else "library"
        return {
            "error": (
                f"Missing stable-diffusion.cpp runtime {plural}: {missing}. "
                "Use Repair Install to reinstall binaries."
            )
        }

    args = [str(exe_path), *flatten_launch_args(args_list)]
    env = _build_process_env(ctx)

    # Re-acquire the lock to spawn + record the process. Re-check "already
    # running" in case another launch won the race during validation.
    with ctx.state.process_lock:
        if ctx.state.process and ctx.state.process.poll() is None:
            return {"error": "A process is already running"}

        with ctx.state.output_buffer_lock:
            ctx.state.output_buffer.clear()
        with ctx.state.stderr_buffer_lock:
            ctx.state.stderr_buffer.clear()

        try:
            ctx.state.process = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE,
                text=True,
                env=env,
                cwd=str(ctx.paths.root),
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
            )
            threading.Thread(
                target=stream_output, args=(ctx, ctx.state.process.stdout), daemon=True
            ).start()
            threading.Thread(
                target=stream_output, args=(ctx, ctx.state.process.stderr, True), daemon=True
            ).start()
            ctx.state.active_process_tool = tool
            return {"pid": ctx.state.process.pid, "command": " ".join(args)}
        except Exception as exc:
            return {"error": str(exc)}


def stop_process(ctx: AppContext) -> bool:
    """Terminate the running process gracefully, then force-kill if needed.

    The blocking ``terminate``/``wait`` run OUTSIDE ``process_lock`` so the
    status poller and ``is_process_running`` are not blocked for up to 5s.
    """
    with ctx.state.process_lock:
        proc = ctx.state.process
        if not proc or proc.poll() is not None:
            ctx.state.active_process_tool = None
            return False
    # terminate/wait OUTSIDE the lock so status polls aren't blocked.
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
    # Only clear if a new process hasn't been started in the meantime.
    with ctx.state.process_lock:
        if ctx.state.process is proc:
            ctx.state.process = None
        ctx.state.active_process_tool = None
    return True


def send_input(ctx: AppContext, text: str) -> bool:
    with ctx.state.process_lock:
        proc = ctx.state.process
        if proc and proc.poll() is None and proc.stdin:
            try:
                proc.stdin.write(text + "\n")
                proc.stdin.flush()
                return True
            except Exception:
                return False
    return False


def remove_sdcpp_files(ctx: AppContext) -> int:
    """Delegate to sdcpp_manager (kept here for symmetry with LLama-GUI)."""
    from . import sdcpp_manager

    return sdcpp_manager.remove_sdcpp_files(ctx)
