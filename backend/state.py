"""Thread-safe state containers for backend runtime state.

Mirrors LLama-GUI's backend/state.py. Adds SD-specific slots:
- ``generation``: current/last sd-cli one-shot generation job state.
- ``sd_server``: persistent sd-server process state (separate from the
  one-shot generator so both can coexist).
- ``gallery``: in-memory cache of recent gallery sidecars.
"""

import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from . import config


def default_download_progress() -> dict[str, Any]:
    return {"total": 0, "downloaded": 0, "status": "idle", "message": ""}


def default_model_download_state() -> dict[str, Any]:
    # HF model download: supports multi-file bundles (diffusion model + vae +
    # clip + t5xxl ...), unlike LLama-GUI's single model + single mmproj.
    return {
        "status": "idle",
        "message": "",
        "total": 0,
        "downloaded": 0,
        "current_file": "",
        "completed_files": [],
    }


def default_remote_tunnel_state() -> dict[str, Any]:
    return {
        "status": "idle",
        "url": "",
        "message": "Remote tunnel is not running.",
        "log": "",
    }


def default_generation_state() -> dict[str, Any]:
    # One sd-cli run. state in: idle | queued | running | done | error | canceled
    return {
        "state": "idle",
        "job_id": "",
        "mode": "",
        "step": 0,
        "total_steps": 0,
        "percent": 0,
        "message": "",
        "started_at": 0.0,
        "finished_at": 0.0,
        "preview_mtime": 0,
        "result_files": [],
        "seed": None,
        "error": "",
    }


def default_sd_server_state() -> dict[str, Any]:
    return {
        "status": "idle",  # idle | starting | running | error | stopping
        "pid": None,
        "host": config.SD_SERVER_HOST,
        "port": config.SD_SERVER_PORT,
        "target_url": f"http://{config.SD_SERVER_HOST}:{config.SD_SERVER_PORT}",
        "message": "sd-server is not running.",
        "command": "",
        "log": "",
    }


class AtomicDict:
    """Small lock-protected dict wrapper used for status snapshots.

    Mutating methods return a copied post-mutation snapshot so callers can use
    the new state without holding the internal lock.
    """

    def __init__(self, initial: Mapping[str, Any] | None = None) -> None:
        self._lock = threading.Lock()
        self._data = dict(initial or {})

    def update(self, **updates: Any) -> dict[str, Any]:
        with self._lock:
            self._data.update(updates)
            return dict(self._data)

    def replace(self, values: Mapping[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._data.clear()
            self._data.update(values)
            return dict(self._data)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._data)


@dataclass
class ServerState:
    # Generic process slot (used for raw sd-cli / scratch runs and shared with
    # the generation orchestrator). One job at a time, like LLama-GUI.
    process: Any = None
    process_lock: threading.Lock = field(default_factory=threading.Lock)
    output_buffer: list[str] = field(default_factory=list)
    output_buffer_lock: threading.Lock = field(default_factory=threading.Lock)
    stderr_buffer: list[str] = field(default_factory=list)
    stderr_buffer_lock: threading.Lock = field(default_factory=threading.Lock)
    active_process_tool: str | None = None

    # Install (stable-diffusion.cpp release) progress.
    download_progress: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_download_progress())
    )
    install_in_progress: bool = False
    install_lock: threading.Lock = field(default_factory=threading.Lock)

    # Hugging Face model/component downloads.
    model_download: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_model_download_state())
    )
    model_download_in_progress: bool = False
    model_download_lock: threading.Lock = field(default_factory=threading.Lock)
    model_download_cancel: threading.Event = field(default_factory=threading.Event)

    # Cloudflare tunnel.
    remote_tunnel_process: Any = None
    remote_tunnel: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_remote_tunnel_state())
    )
    remote_tunnel_lock: threading.Lock = field(default_factory=threading.Lock)
    # Dedicated lock for the tunnel log read-modify-write so the two stream
    # threads (stdout/stderr) can't lose append interleaves.
    remote_tunnel_log_lock: threading.Lock = field(default_factory=threading.Lock)

    # One-shot sd-cli generation job state (Phase 2).
    generation: AtomicDict = field(default_factory=lambda: AtomicDict(default_generation_state()))
    generation_lock: threading.Lock = field(default_factory=threading.Lock)
    generation_cancel: threading.Event = field(default_factory=threading.Event)

    # Preset JSON CRUD (Phase 4).
    preset_lock: threading.Lock = field(default_factory=threading.Lock)

    # Git auto-update (git pull + pip install) — guarded so two concurrent
    # update requests can't race on the working tree.
    app_update_lock: threading.Lock = field(default_factory=threading.Lock)
    app_update_in_progress: bool = False

    # Persistent sd-server process (Phase 5). Independent lock so a running
    # server does not block the one-shot generator.
    sd_server: AtomicDict = field(default_factory=lambda: AtomicDict(default_sd_server_state()))
    sd_server_process: Any = None
    sd_server_lock: threading.Lock = field(default_factory=threading.Lock)
    sd_server_log: list[str] = field(default_factory=list)
    sd_server_log_lock: threading.Lock = field(default_factory=threading.Lock)

    gui_server: Any = None
