"""Application context objects shared by backend modules.

Adapted from LLama-GUI's context.py with stable-diffusion.cpp paths.
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import config
from .state import ServerState


@dataclass(frozen=True)
class AppPaths:
    root: Path = config.ROOT_DIR
    sdcpp: Path = config.SDCPP_DIR
    sdcpp_bin: Path = config.SDCPP_BIN_DIR
    sdcpp_installs: Path = config.SDCPP_INSTALLS_DIR
    models: Path = config.MODELS_DIR
    output: Path = config.OUTPUT_DIR
    output_preview: Path = config.OUTPUT_PREVIEW_DIR
    output_gallery: Path = config.OUTPUT_GALLERY_DIR
    presets: Path = config.PRESETS_DIR
    config_file: Path = config.CONFIG_FILE
    ui: Path = config.UI_DIR
    app_logo: Path = config.APP_LOGO_FILE
    tools: Path = config.TOOLS_DIR
    cloudflared: Path = config.CLOUDFLARED_DIR


@dataclass(frozen=True)
class ServerConfig:
    gui_host: str = config.GUI_HOST
    gui_port: int = config.GUI_PORT
    sd_server_host: str = config.SD_SERVER_HOST
    sd_server_port: int = config.SD_SERVER_PORT
    github_api: str = config.GITHUB_API
    app_repo_url: str = config.APP_REPO_URL


def _missing_service(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("Backend service has not been configured yet.")


@dataclass
class BackendServices:
    backend_specs: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    binary_suffix: str = ""
    current_arch: str = "unknown"
    current_platform: str = "unknown"
    find_tool_executable: Callable[..., Any] = _missing_service
    get_platform_label: Callable[[], str] = _missing_service
    get_tool_filename: Callable[[str], str] = _missing_service
    is_process_running: Callable[[], bool] = _missing_service
    sdcpp_tools: Sequence[str] = field(default_factory=tuple)
    load_config: Callable[[], Mapping[str, Any]] = _missing_service
    save_config: Callable[[Mapping[str, Any]], None] = _missing_service
    ssl_context: Any = None
    urlopen_with_ssl: Callable[..., Any] = _missing_service


@dataclass
class AppContext:
    paths: AppPaths = field(default_factory=AppPaths)
    config: ServerConfig = field(default_factory=ServerConfig)
    state: ServerState = field(default_factory=ServerState)
    services: BackendServices = field(default_factory=BackendServices)


DEFAULT_CONTEXT = AppContext()
