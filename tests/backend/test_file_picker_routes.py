"""Tests for the native file/directory picker routes.

The native dialogs are monkeypatched so no GUI actually opens. Covers the
``POST /api/select-directory`` route added for the video ``control_video``
frame-folder picker, plus the service-level shape/default-dir behavior.
"""

import sys
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.context import AppContext, AppPaths  # noqa: E402
from backend.http import Request, Response  # noqa: E402
from backend.routes import file_picker as file_picker_routes  # noqa: E402
from backend.services import file_picker_service  # noqa: E402


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
    return AppContext(paths=AppPaths(root=tmp_path, output=tmp_path / "output"))


def _post_select_directory(ctx: AppContext, monkeypatch, picked: str) -> _Handler:
    monkeypatch.setattr(
        file_picker_routes.file_picker_service,
        "select_directory",
        lambda _ctx, title=None: {"selected": bool(picked), "path": picked},
    )
    handler = _Handler()
    request = Request(
        "POST",
        "/api/select-directory",
        "",
        {},
        {"title": "Select control video frames"},
        {},
    )
    file_picker_routes.select_directory(request, Response(handler), ctx)
    return handler


def test_select_directory_route_returns_picked_path(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    handler = _post_select_directory(ctx, monkeypatch, str(tmp_path / "frames"))

    assert handler.status == 200
    import json

    payload = json.loads(handler.wfile.getvalue())
    assert payload["selected"] is True
    assert payload["path"].endswith("frames")


def test_select_directory_route_cancel_returns_not_selected(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    handler = _post_select_directory(ctx, monkeypatch, "")

    assert handler.status == 200
    import json

    payload = json.loads(handler.wfile.getvalue())
    assert payload["selected"] is False
    assert payload["path"] == ""


def test_select_directory_defaults_to_root_and_mirrors_dialog(tmp_path, monkeypatch):
    # The control-video folder lives in user space, so the dialog should be
    # seeded with the project root (not a model-purpose dir) and the returned
    # shape mirrors select_file: {"selected": bool, "path": str}.
    ctx = _ctx(tmp_path)
    seen = {}

    def fake_dialog(title="Select Folder", initial_dir=None):
        seen["title"] = title
        seen["initial_dir"] = initial_dir
        return str(tmp_path / "picked")

    monkeypatch.setattr(file_picker_service, "select_directory_in_native_dialog", fake_dialog)

    result = file_picker_service.select_directory(ctx, "Select control video frames")

    assert seen["title"] == "Select control video frames"
    assert Path(seen["initial_dir"]) == tmp_path  # ctx.paths.root
    assert result == {"selected": True, "path": str(tmp_path / "picked")}
