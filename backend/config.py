"""Shared backend configuration constants.

Mirrors the structure of LLama-GUI's backend/config.py but adapted for
stable-diffusion.cpp: new paths (sdcpp/ binaries, output/ gallery), new default
ports, and SD_GUI_* environment variables.

Keep this module free of optional third-party imports so the server can import
it during startup on a minimal Python environment.
"""

import math
import os
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]

# Downloaded stable-diffusion.cpp binaries live here.
SDCPP_DIR = ROOT_DIR / "sdcpp"
SDCPP_BIN_DIR = SDCPP_DIR / "bin"
SDCPP_INSTALLS_DIR = SDCPP_DIR / "installs"

# User model files (.safetensors / .ckpt / .gguf / .sft / .bin).
MODELS_DIR = ROOT_DIR / "models"

# Generated images/videos + preview + gallery sidecars.
OUTPUT_DIR = ROOT_DIR / "output"
OUTPUT_PREVIEW_DIR = OUTPUT_DIR / ".preview"
OUTPUT_GALLERY_DIR = OUTPUT_DIR / ".gallery"

# Saved generation preset JSON files.
PRESETS_DIR = ROOT_DIR / "presets"

CONFIG_FILE = ROOT_DIR / "config.json"
UI_DIR = ROOT_DIR / "ui"
APP_LOGO_FILE = ROOT_DIR / "assets" / "logo.png"
TOOLS_DIR = ROOT_DIR / "tools"
CLOUDFLARED_DIR = TOOLS_DIR / "cloudflared"

DEFAULT_GUI_HOST = "127.0.0.1"
DEFAULT_GUI_PORT = 5250  # distinct from LLama-GUI's 5240 so both can run together

# stable-diffusion.cpp's sd-server default port (upstream).
SD_SERVER_HOST = "127.0.0.1"
SD_SERVER_PORT = 1234

# Per-request timeout for the /v1 /sdapi /sdcpp proxy to sd-server. Generation
# requests block until the image is done — CPU txt2img on a large model can
# take well over 20 minutes, so the default is generous.
DEFAULT_SD_SERVER_PROXY_TIMEOUT = 1800.0  # seconds


# Upper bound for the sd-server proxy timeout (24h). Prevents an absurd
# SD_GUI_PROXY_TIMEOUT from pinning proxy connections effectively forever.
PROXY_TIMEOUT_MAX = 86400.0

# Max lengths: hostname limit per RFC 1035 (253), token cap as a DoS guard.
GUI_HOST_MAX_LEN = 253
GUI_TOKEN_MAX_LEN = 4096


def parse_proxy_timeout(value: object, default: float = DEFAULT_SD_SERVER_PROXY_TIMEOUT) -> float:
    try:
        timeout = float(str(value or "").strip())
    except (TypeError, ValueError):
        return default
    if not math.isfinite(timeout) or timeout <= 0:
        return default
    return min(timeout, PROXY_TIMEOUT_MAX)


def parse_gui_host(value: object, default: str = DEFAULT_GUI_HOST) -> str:
    host = str(value or "").strip()
    if not host or any(ord(ch) < 32 for ch in host) or "/" in host:
        return default
    if len(host) > GUI_HOST_MAX_LEN:
        return default
    if host == "*":
        return "0.0.0.0"
    if host.startswith("[") and host.endswith("]"):
        return host[1:-1]
    return host


def parse_gui_port(value: object, default: int = DEFAULT_GUI_PORT) -> int:
    try:
        port = int(str(value or "").strip())
    except (TypeError, ValueError):
        return default
    if port < 1 or port > 65535:
        return default
    return port


def parse_gui_allowed_hosts(value: object) -> tuple[str, ...]:
    hosts = []
    for raw_host in str(value or "").split(","):
        host = parse_gui_host(raw_host, default="")
        if host:
            host = host.lower()
        if host and host not in hosts:
            hosts.append(host)
    return tuple(hosts)


def parse_gui_token(value: object) -> str:
    """Optional shared secret for API/proxy auth. Empty = no token configured.

    Tokens longer than GUI_TOKEN_MAX_LEN (4096) are truncated with a stderr
    warning so over-long env values fail loudly instead of silently.
    """
    token = str(value or "").strip()
    if len(token) > GUI_TOKEN_MAX_LEN:
        print(
            "[warn] SD_GUI_TOKEN truncated to 4096 chars",
            file=sys.stderr,
            flush=True,
        )
        return token[:GUI_TOKEN_MAX_LEN]
    return token


def parse_env_bool(value: object, default: bool = False) -> bool:
    """Truthy: 1/true/yes/on. Falsy: 0/false/no/off. Empty/unknown → default."""
    if value is None:
        return default
    text = str(value).strip().lower()
    if not text:
        return default
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


GUI_HOST = parse_gui_host(os.environ.get("SD_GUI_HOST"), DEFAULT_GUI_HOST)
GUI_PORT = parse_gui_port(os.environ.get("SD_GUI_PORT"), DEFAULT_GUI_PORT)
GUI_ALLOWED_HOSTS = parse_gui_allowed_hosts(os.environ.get("SD_GUI_ALLOWED_HOSTS"))
GUI_TOKEN = parse_gui_token(os.environ.get("SD_GUI_TOKEN"))
GUI_ALLOW_INSECURE = parse_env_bool(os.environ.get("SD_GUI_ALLOW_INSECURE"), False)
SD_SERVER_PROXY_TIMEOUT = parse_proxy_timeout(os.environ.get("SD_GUI_PROXY_TIMEOUT"))

# GitHub releases for leejet/stable-diffusion.cpp are continuous builds
# (tags like master-709-92a3b73); asset names embed the commit short-hash, so
# assets are matched by suffix pattern in services/sdcpp_manager.py.
GITHUB_API = "https://api.github.com/repos/leejet/stable-diffusion.cpp/releases"
APP_REPO_URL = "https://github.com/thomas9120/StableDfusion.git"

PROCESS_OUTPUT_LIMIT = 5000
PROCESS_OUTPUT_TRIM = 1000
TUNNEL_LOG_LIMIT = 6000

RESTART_STARTUP_DELAY_SECONDS = 2.5
RESTART_PORT_WAIT_ATTEMPTS = 10
RESTART_PORT_WAIT_SECONDS = 0.5
