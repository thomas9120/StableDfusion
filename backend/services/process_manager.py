"""Subprocess management for sd-cli and sd-server.

Adapted from LLama-GUI's process_manager.py. Shared by the one-shot generator
(services/generate.py) and the persistent sd-server (routes/server_mode.py).

TODO(Phase 1/2): port launch_process / stream_output / stop_process / env
builder (PATH + LD/DYLD_LIBRARY_PATH prepending ctx.paths.sdcpp_bin), Windows
CREATE_NEW_PROCESS_GROUP, output buffering.
"""

import os
import sys
from collections.abc import Iterable
from typing import Any

from .. import config
from ..context import AppContext


def is_process_running(ctx: AppContext) -> bool:
    with ctx.state.process_lock:
        return ctx.state.process is not None and ctx.state.process.poll() is None


def flatten_launch_args(args_list: Iterable[Any] | None) -> list[str]:
    flat: list[str] = []
    for entry in args_list or []:
        if isinstance(entry, list):
            flat.extend(str(v) for v in entry)
        else:
            flat.append(str(entry))
    return flat


def _build_process_env(ctx: AppContext) -> dict[str, str]:
    env = os.environ.copy()
    runtime_paths = [str(ctx.paths.sdcpp_bin)]
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


def launch_process(ctx: AppContext, tool: str, args_list: Iterable[Any] | None) -> dict[str, Any]:
    # TODO(Phase 1): validate runtime deps, Popen with stdout/stderr/stdin
    # pipes, spawn stream_output threads, set active_process_tool, return
    # {pid, command}. On Windows use CREATE_NEW_PROCESS_GROUP.
    raise NotImplementedError


def stream_output(ctx: AppContext, pipe, is_stderr: bool = False) -> None:
    try:
        for line in iter(pipe.readline, ""):
            if line:
                with ctx.state.output_buffer_lock:
                    ctx.state.output_buffer.append(line.rstrip("\n\r"))
                    if len(ctx.state.output_buffer) > config.PROCESS_OUTPUT_LIMIT:
                        del ctx.state.output_buffer[: config.PROCESS_OUTPUT_TRIM]
    except Exception:
        pass


def stop_process(ctx: AppContext) -> bool:
    # TODO(Phase 1): signal/terminate/kill mirroring LLama-GUI.
    raise NotImplementedError


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
