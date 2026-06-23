"""HTTP primitives: Request/Response wrappers, CORS validation, error helpers.

Generic plumbing adapted from LLama-GUI. Contains no stable-diffusion-specific
logic so it can be reused and reasoned about independently.
"""

import json
import urllib.parse

from . import config

# Wildcard bind hosts where the request's own Host header must be trusted as an
# allowed origin (loopback still required for /api access).
WILDCARD_BIND_HOSTS = {"0.0.0.0", "::"}


def _loopback_host(host: str) -> bool:
    host = (host or "").strip().lower()
    return host in {"localhost", "127.0.0.1", "::1"} or host.startswith("127.")


def is_static_ui_path(path: str) -> bool:
    return path.startswith("/css/") or path.startswith("/js/") or path.startswith("/assets/")


def is_v1_proxy_path(path: str) -> bool:
    # sd-server compatibility API passthrough (Phase 5). Reserved up-front so
    # CORS preflight already knows to treat these paths as proxy-able.
    _V1_PREFIXES = ("/v1/", "/sdapi/", "/sdcpp/")
    return path == "/v1" or any(path.startswith(p) for p in _V1_PREFIXES)


def get_cors_methods(path: str) -> str:
    if is_v1_proxy_path(path):
        return "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    return "GET, POST, DELETE, OPTIONS"


def is_safe_request_origin(headers, allowed_origins) -> bool:
    """Allow loopback origins and any explicitly-allowed origin (LAN / tunnel).

    ``allowed_origins`` is a set of *full origin strings* (e.g.
    ``http://127.0.0.1:5250``, ``https://abc.trycloudflare.com``) as produced by
    ``get_allowed_request_origins``. The request's ``Origin`` header is itself a
    full origin, so we compare full-to-full first, then fall back to a loopback
    hostname check (which tolerates ``localhost`` vs ``127.0.0.1`` mismatches).
    """
    origin = headers.get("Origin", "")
    if not origin:
        return True
    if origin in allowed_origins:
        return True
    try:
        parsed = urllib.parse.urlparse(origin)
    except ValueError:
        return False
    return _loopback_host(parsed.hostname or "")


def get_allowed_request_origins(
    tunnel_url, gui_host, gui_port, request_host="", allow_request_host_origin=False
):
    origins: set[str] = set()
    for host in (gui_host, "127.0.0.1", "localhost"):
        origins.add(f"http://{host}:{gui_port}")
    if tunnel_url:
        try:
            origins.add(tunnel_url.rstrip("/"))
        except Exception:
            pass
    if allow_request_host_origin and request_host:
        origins.add(f"http://{request_host}")
    return origins


def get_access_control_origin(headers, allowed_origins):
    origin = headers.get("Origin", "")
    if origin and origin in allowed_origins:
        return origin
    return f"http://{config.GUI_HOST}:{config.GUI_PORT}"


def sanitize_error(exc, status: int = 500) -> str:
    """Return a client-safe error message.

    For 5xx errors the client receives a generic placeholder so filesystem
    paths, tracebacks, and host details never leak through the tunnel. For 4xx
    the original message is preserved (intentional validation responses). The
    raw exception is logged to stderr.
    """
    import sys as _sys

    detail = str(exc) if exc else "Unknown error"
    if status >= 500:
        print(f"[sanitize_error] {type(exc).__name__}: {detail}", file=_sys.stderr)
        return "Internal server error"
    return detail


def _parse_byte_range(range_header: str | None, size: int) -> tuple[int, int] | None:
    if not range_header or not range_header.startswith("bytes="):
        return None
    spec = range_header[len("bytes=") :].strip()
    if "," in spec or "-" not in spec:
        raise ValueError("Unsupported byte range.")
    first, last = spec.split("-", 1)
    if not first and not last:
        raise ValueError("Invalid byte range.")
    if first:
        start = int(first)
        end = int(last) if last else size - 1
    else:
        suffix_length = int(last)
        if suffix_length <= 0:
            raise ValueError("Invalid byte range.")
        start = max(size - suffix_length, 0)
        end = size - 1
    if start < 0 or end < start or start >= size:
        raise ValueError("Requested range not satisfiable.")
    return start, min(end, size - 1)


class Request:
    def __init__(self, method, path, query, headers, body, params):
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.body = body if body is not None else {}
        self.params = params


class Response:
    def __init__(self, handler):
        self.handler = handler

    def _base_headers(self, content_type, headers=None):
        self.handler.send_header("Content-Type", content_type)
        self.handler.send_header(
            "Access-Control-Allow-Origin", self.handler.get_access_control_origin()
        )
        for key, value in (headers or {}).items():
            self.handler.send_header(key, value)

    def json(self, data, status: int = 200):
        body = json.dumps(data).encode("utf-8")
        self.handler.send_response(status)
        self._base_headers("application/json; charset=utf-8")
        self.handler.send_header("Content-Length", str(len(body)))
        self.handler.end_headers()
        self.handler.wfile.write(body)

    def error(self, message: str, status: int = 500, code=None, extra=None):
        payload = {"error": message}
        if code:
            payload["code"] = code
        if extra:
            payload.update(extra)
        self.json(payload, status)

    def text(self, text: str, status: int = 200):
        body = text.encode("utf-8")
        self.handler.send_response(status)
        self._base_headers("text/plain; charset=utf-8")
        self.handler.send_header("Content-Length", str(len(body)))
        self.handler.end_headers()
        self.handler.wfile.write(body)

    def bytes(self, body: bytes, content_type: str = "application/octet-stream", headers=None):
        self.handler.send_response(200)
        self._base_headers(content_type, headers)
        self.handler.send_header("Content-Length", str(len(body)))
        self.handler.end_headers()
        self.handler.wfile.write(body)

    def file(self, path, content_type: str = "application/octet-stream", headers=None):
        """Stream a file from disk with HTTP Range support.

        Avoids reading the entire file into memory — only ``CHUNK`` bytes are
        buffered at a time. Honors the ``Range`` request header so browsers can
        seek large video outputs.
        """
        size = path.stat().st_size
        start = 0
        end = size - 1
        status = 200
        range_header = None
        headers_obj = getattr(self.handler, "headers", None)
        if headers_obj is not None:
            _get = getattr(headers_obj, "get", None)
            if callable(_get):
                range_header = _get("Range")
        if range_header and range_header.startswith("bytes="):
            try:
                start, end = _parse_byte_range(range_header, size)
            except ValueError:
                self.error("Requested range not satisfiable", 416)
                return
            status = 206
        length = end - start + 1
        self.handler.send_response(status)
        self.handler.send_header("Content-Type", content_type)
        self.handler.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.handler.send_header("Content-Length", str(length))
        self.handler.send_header(
            "Access-Control-Allow-Origin", self.handler.get_access_control_origin()
        )
        for key, value in (headers or {}).items():
            self.handler.send_header(key, value)
        self.handler.end_headers()
        # HEAD requests have no body; only stream for GET.
        command = getattr(self.handler, "command", "GET")
        if command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                self.handler.wfile.write(chunk)
                remaining -= len(chunk)

    def sse_headers(self, status: int = 200):
        self.handler.send_response(status)
        self._base_headers("text/event-stream")
        self.handler.send_header("Cache-Control", "no-cache")
        self.handler.send_header("Connection", "keep-alive")
        self.handler.end_headers()

    def sse(self, event: str, data):
        payload = f"event: {event}\ndata: {json.dumps(data)}\n\n"
        self.handler.wfile.write(payload.encode("utf-8"))
        self.handler.wfile.flush()
