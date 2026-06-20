"""Focused tests for gallery image serving."""

import sys
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.context import AppContext, AppPaths  # noqa: E402
from backend.http import Request, Response  # noqa: E402
from backend.routes import images as images_route  # noqa: E402


class _Handler:
    def __init__(self):
        self.status = 0
        self.headers = []
        self.wfile = BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers.append((key, value))

    def end_headers(self):
        pass

    def get_access_control_origin(self):
        return "http://127.0.0.1:5250"


def _ctx(tmp_path: Path) -> AppContext:
    output = tmp_path / "output"
    return AppContext(paths=AppPaths(output=output, output_gallery=output / ".gallery"))


def _serve(ctx: AppContext, name: str) -> _Handler:
    handler = _Handler()
    request = Request("GET", f"/api/image/{name}", "", {}, {}, {"name": name})
    images_route.serve_image(request, Response(handler), ctx)
    return handler


def _header(handler: _Handler, name: str) -> str | None:
    for key, value in handler.headers:
        if key.lower() == name.lower():
            return value
    return None


def test_serve_image_returns_bytes_content_type_and_thumbnail_alias(tmp_path):
    ctx = _ctx(tmp_path)
    ctx.paths.output.mkdir(parents=True)
    payload = b"\x89PNG\r\n\x1a\nimage-bytes"
    (ctx.paths.output / "result.png").write_bytes(payload)

    direct = _serve(ctx, "result.png")
    thumb = _serve(ctx, "result.png/thumbnail")

    assert direct.status == 200
    assert direct.wfile.getvalue() == payload
    assert _header(direct, "Content-Type") == "image/png"
    assert _header(direct, "Cache-Control") == "no-cache, must-revalidate"
    assert thumb.status == 200
    assert thumb.wfile.getvalue() == payload


def test_serve_image_rejects_traversal_separators_and_missing_files(tmp_path):
    ctx = _ctx(tmp_path)
    ctx.paths.output.mkdir(parents=True)
    (ctx.paths.output / "safe.png").write_bytes(b"x")

    for name in ("../safe.png", "..\\safe.png", "nested/safe.png", ".", "..", "missing.png"):
        handler = _serve(ctx, name)
        assert handler.status == 404, name
        assert b"Image not found" in handler.wfile.getvalue()
