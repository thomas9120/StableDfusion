"""Stable-D GUI backend: HTTP server, route registry, main().

Adapted from LLama-GUI's backend/app.py. Serves static ``ui/`` and dispatches
``/api/*`` routes. Most routes return 501 TODOs during the scaffold phase —
see PLAN.md for the phased implementation roadmap.

Note: intra-package imports are RELATIVE (``from .context import ...``) so
static analysis resolves them regardless of workspace root configuration.
"""

import http.server
import json
import platform
import socket
import ssl
import sys
import urllib.parse
from collections.abc import Mapping
from typing import Any

from . import config
from .context import DEFAULT_CONTEXT
from .http import (
    WILDCARD_BIND_HOSTS,
    Request,
    Response,
    get_access_control_origin,
    get_allowed_request_origins,
    get_cors_methods,
    is_safe_request_origin,
    is_static_ui_path,
    is_v1_proxy_path,
)
from .routes import file_picker as file_picker_routes
from .routes import generate as generate_routes
from .routes import git_update as git_update_routes
from .routes import hf_download as hf_download_routes
from .routes import images as images_routes
from .routes import install as install_routes
from .routes import lifecycle as lifecycle_routes
from .routes import models as models_routes
from .routes import presets as presets_routes
from .routes import server_mode as server_mode_routes
from .routes import status as status_routes
from .routes import tunnel as tunnel_routes
from .routing import Router

try:
    import certifi
except ImportError:
    certifi = None

APP_CONTEXT = DEFAULT_CONTEXT
STATE = APP_CONTEXT.state


def _normalize_arch(machine: str) -> str:
    value = (machine or "").strip().lower()
    mapping = {
        "amd64": "x64",
        "x86_64": "x64",
        "arm64": "arm64",
        "aarch64": "arm64",
        "armv8l": "arm64",
    }
    return mapping.get(value, value or "unknown")


CURRENT_ARCH = _normalize_arch(platform.machine())
CURRENT_PLATFORM = sys.platform
BINARY_SUFFIX = ".exe" if CURRENT_PLATFORM == "win32" else ""

SDCPP_TOOLS = ["sd-cli", "sd-server"]


def _create_ssl_context():
    cafile = certifi.where() if certifi else None
    if cafile:
        return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


def urlopen_with_ssl(request, timeout):
    import urllib.request

    return urllib.request.urlopen(request, timeout=timeout, context=_create_ssl_context())


def get_platform_label() -> str:
    if CURRENT_PLATFORM == "win32":
        return "Windows"
    if CURRENT_PLATFORM == "darwin":
        return "macOS"
    if CURRENT_PLATFORM.startswith("linux"):
        return "Linux"
    return CURRENT_PLATFORM


def get_tool_filename(tool: str) -> str:
    return f"{tool}{BINARY_SUFFIX}"


def find_tool_executable(tool: str):
    return config.SDCPP_BIN_DIR / get_tool_filename(tool)


def is_process_running() -> bool:
    proc = STATE.process
    return proc is not None and proc.poll() is None


def load_config() -> dict:
    if config.CONFIG_FILE.exists():
        try:
            return json.loads(config.CONFIG_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {"version": None, "backend": None, "tag": None}
    return {"version": None, "backend": None, "tag": None}


def save_config(cfg: Mapping[str, Any]) -> None:
    config.CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def configure_services(ctx=APP_CONTEXT) -> None:
    ctx.services.backend_specs = _build_backend_specs()
    ctx.services.binary_suffix = BINARY_SUFFIX
    ctx.services.current_arch = CURRENT_ARCH
    ctx.services.current_platform = CURRENT_PLATFORM
    ctx.services.find_tool_executable = find_tool_executable
    ctx.services.get_platform_label = get_platform_label
    ctx.services.get_tool_filename = get_tool_filename
    ctx.services.is_process_running = is_process_running
    ctx.services.sdcpp_tools = SDCPP_TOOLS
    ctx.services.load_config = load_config
    ctx.services.save_config = save_config
    ctx.services.ssl_context = _create_ssl_context()
    ctx.services.urlopen_with_ssl = urlopen_with_ssl


def _build_backend_specs() -> dict:
    from .services import sdcpp_manager

    return sdcpp_manager.build_backend_specs(CURRENT_PLATFORM, CURRENT_ARCH)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(config.UI_DIR), **kw)

    def log_message(self, format, *args):  # noqa: A002
        pass

    def end_headers(self):
        parsed = urllib.parse.urlparse(self.path)
        if is_static_ui_path(parsed.path):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            self.send_header("Access-Control-Allow-Origin", self.get_access_control_origin())
        super().end_headers()

    def get_allowed_request_origins(self):
        return get_allowed_request_origins(
            None,
            config.GUI_HOST,
            config.GUI_PORT,
            request_host=self.headers.get("Host", ""),
            allow_request_host_origin=config.GUI_HOST in WILDCARD_BIND_HOSTS,
        )

    def get_access_control_origin(self):
        return get_access_control_origin(self.headers, self.get_allowed_request_origins())

    def do_OPTIONS(self):
        parsed = urllib.parse.urlparse(self.path)
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", self.get_access_control_origin())
        self.send_header("Access-Control-Allow-Methods", get_cors_methods(parsed.path))
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        if length > 10 * 1024 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def dispatch(self, method, parsed, body=None):
        match = API_ROUTER.match(method, parsed.path)
        if match is None:
            self.send_error(404)
            return
        request = Request(
            method=method,
            path=parsed.path,
            query=parsed.query,
            headers=self.headers,
            body=body if body is not None else {},
            params=dict(match.params),
        )
        match.handler(request, Response(self), APP_CONTEXT)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            index = config.UI_DIR / "index.html"
            if index.exists():
                Response(self).bytes(index.read_bytes(), content_type="text/html; charset=utf-8")
                return
            self.send_error(404, "index.html not found")
            return
        if parsed.path.startswith("/api/"):
            if not is_safe_request_origin(self.headers, self.get_allowed_request_origins()):
                self.send_error(403)
                return
            self.dispatch("GET", parsed)
            return
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if is_v1_proxy_path(parsed.path):
            self.send_error(501, "sd-server proxy is Phase 5")
            return
        body = self.read_body()
        if body is None:
            self.send_error(400, "Invalid or malformed JSON body")
            return
        if not is_safe_request_origin(self.headers, self.get_allowed_request_origins()):
            self.send_error(403)
            return
        self.dispatch("POST", parsed, body)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if not is_safe_request_origin(self.headers, self.get_allowed_request_origins()):
            self.send_error(403)
            return
        self.dispatch("DELETE", parsed, self.read_body())


API_ROUTER = (
    Router()
    .add("GET", "/api/status", status_routes.get_status)
    .add("GET", "/api/releases", install_routes.get_releases)
    .add("GET", "/api/download-progress", install_routes.get_download_progress)
    .add("GET", "/api/models", models_routes.list_models)
    .add("GET", "/api/images", images_routes.list_images)
    .add("GET", "/api/generate/status", generate_routes.get_status)
    .add("GET", "/api/hf/download-status", hf_download_routes.get_download_status)
    .add("GET", "/api/sd-server/status", server_mode_routes.get_status)
    .add("GET", "/api/remote-tunnel/status", tunnel_routes.get_status)
    .add("GET", "/api/app-update-status", git_update_routes.get_status)
    .add("GET", "/api/presets", presets_routes.list_presets)
    .add("POST", "/api/install", install_routes.start_install)
    .add("POST", "/api/update", install_routes.start_update)
    .add("POST", "/api/cleanup-sdcpp", install_routes.cleanup_sdcpp)
    .add("POST", "/api/generate", generate_routes.generate)
    .add("POST", "/api/generate/cancel", generate_routes.cancel)
    .add("POST", "/api/hf/repo-files", hf_download_routes.list_repo_files)
    .add("POST", "/api/hf/download", hf_download_routes.start_download)
    .add("POST", "/api/hf/download-cancel", hf_download_routes.cancel_download)
    .add("POST", "/api/sd-server/start", server_mode_routes.start)
    .add("POST", "/api/sd-server/stop", server_mode_routes.stop)
    .add("POST", "/api/remote-tunnel/start", tunnel_routes.start)
    .add("POST", "/api/remote-tunnel/stop", tunnel_routes.stop)
    .add("POST", "/api/app-update", git_update_routes.start_update)
    .add("POST", "/api/shutdown", lifecycle_routes.post_shutdown)
    .add("POST", "/api/restart", lifecycle_routes.post_restart)
    .add("POST", "/api/open-folder", lifecycle_routes.post_open_folder)
    .add("POST", "/api/select-file", file_picker_routes.select_file)
    .add("POST", "/api/presets", presets_routes.save_preset)
    .add("POST", "/api/presets/shortcut", presets_routes.export_preset_shortcut)
    .add_prefix("GET", "/api/image/", images_routes.serve_image, "name")
    .add_prefix("DELETE", "/api/presets/", presets_routes.delete_preset, "name")
)


def main() -> None:
    port = config.GUI_PORT
    for d in (
        config.MODELS_DIR,
        config.PRESETS_DIR,
        config.SDCPP_BIN_DIR,
        config.OUTPUT_DIR,
        config.OUTPUT_PREVIEW_DIR,
        config.OUTPUT_GALLERY_DIR,
    ):
        d.mkdir(parents=True, exist_ok=True)

    server_class = http.server.ThreadingHTTPServer
    if ":" in config.GUI_HOST:
        server_class = type(
            "ThreadingHTTPServerIPv6",
            (http.server.ThreadingHTTPServer,),
            {"address_family": socket.AF_INET6},
        )
    try:
        STATE.gui_server = server_class((config.GUI_HOST, port), Handler)
    except OSError as exc:
        print(f"ERROR: Could not start server on port {port}: {exc}")
        sys.exit(1)

    print(f"Stable-D GUI running at http://{config.GUI_HOST}:{port}")
    print("Press Ctrl+C to stop the server.")
    try:
        STATE.gui_server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        STATE.gui_server.server_close()


configure_services(APP_CONTEXT)
