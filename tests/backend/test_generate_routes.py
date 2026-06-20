"""Focused route tests for generation preview delivery."""

import sys
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.context import AppContext, AppPaths  # noqa: E402
from backend.http import Request, Response  # noqa: E402
from backend.routes import generate as generate_route  # noqa: E402


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
    return AppContext(paths=AppPaths(output=output, output_preview=output / ".preview"))


def _preview(ctx: AppContext, monkeypatch, status_payload: dict) -> _Handler:
    monkeypatch.setattr(generate_route.generate_service, "status", lambda _ctx: status_payload)
    handler = _Handler()
    request = Request("GET", "/api/generate/preview", "", {}, {}, {})
    generate_route.get_preview(request, Response(handler), ctx)
    return handler


def _header(handler: _Handler, name: str) -> str | None:
    for key, value in handler.headers:
        if key.lower() == name.lower():
            return value
    return None


def test_get_preview_returns_404_before_job_or_file_exists(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)

    no_job = _preview(ctx, monkeypatch, {"state": "idle"})
    missing_file = _preview(ctx, monkeypatch, {"state": "running", "job_id": "job1"})

    assert no_job.status == 404
    assert missing_file.status == 404
    assert b"No preview available yet" in no_job.wfile.getvalue()
    assert b"No preview available yet" in missing_file.wfile.getvalue()


def test_get_preview_serves_png_with_no_cache_headers(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    ctx.paths.output_preview.mkdir(parents=True)
    payload = b"\x89PNG\r\n\x1a\npreview-bytes"
    (ctx.paths.output_preview / "job1.png").write_bytes(payload)

    handler = _preview(ctx, monkeypatch, {"state": "running", "job_id": "job1"})

    assert handler.status == 200
    assert handler.wfile.getvalue() == payload
    assert _header(handler, "Content-Type") == "image/png"
    assert _header(handler, "Cache-Control") == "no-store, no-cache, must-revalidate"


def test_get_preview_serves_webm_for_vid_gen(tmp_path, monkeypatch):
    # Phase 6: video previews are multi-frame .webm files; the route must pick
    # the .webm file (by mode) and serve it as video/webm, not image/png.
    ctx = _ctx(tmp_path)
    ctx.paths.output_preview.mkdir(parents=True)
    payload = b"\x1a\x45\xdf\xa3webm-bytes"
    (ctx.paths.output_preview / "job1.webm").write_bytes(payload)

    handler = _preview(
        ctx,
        monkeypatch,
        {"state": "running", "job_id": "job1", "mode": "vid_gen"},
    )

    assert handler.status == 200
    assert handler.wfile.getvalue() == payload
    assert _header(handler, "Content-Type") == "video/webm"
