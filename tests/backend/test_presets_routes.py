"""Unit tests for Phase 4 preset CRUD."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.context import AppContext, AppPaths  # noqa: E402
from backend.routes import presets as preset_routes  # noqa: E402


class DummyRequest:
    def __init__(self, body=None, params=None):
        self.body = body or {}
        self.params = params or {}
        self.query = ""


class DummyResponse:
    def __init__(self):
        self.status = 200
        self.data = None

    def json(self, data, status: int = 200):
        self.status = status
        self.data = data

    def error(self, message: str, status: int = 500, code=None, extra=None):
        payload = {"error": message}
        if code:
            payload["code"] = code
        if extra:
            payload.update(extra)
        self.json(payload, status)


def _ctx(tmp_path: Path) -> AppContext:
    return AppContext(paths=AppPaths(presets=tmp_path))


def test_preset_save_list_export_delete_round_trip(tmp_path):
    ctx = _ctx(tmp_path)
    payload = {
        "name": "SDXL Draft",
        "description": "test preset",
        "bundle": "sdxl",
        "mode": "img_gen",
        "values": {"prompt": "a cat", "custom_args": "--seed 123"},
    }

    save_resp = DummyResponse()
    preset_routes.save_preset(DummyRequest(payload), save_resp, ctx)
    assert save_resp.status == 200
    assert save_resp.data["saved"] is True
    assert (tmp_path / "SDXL Draft.json").is_file()

    list_resp = DummyResponse()
    preset_routes.list_presets(DummyRequest(), list_resp, ctx)
    assert list_resp.status == 200
    assert len(list_resp.data["presets"]) == 1
    assert list_resp.data["presets"][0]["values"]["custom_args"] == "--seed 123"

    export_resp = DummyResponse()
    preset_routes.export_preset_shortcut(DummyRequest({"name": "SDXL Draft"}), export_resp, ctx)
    assert export_resp.status == 200
    assert export_resp.data["filename"] == "SDXL_Draft.sdgui-preset.json"
    assert export_resp.data["preset"]["bundle"] == "sdxl"

    delete_resp = DummyResponse()
    preset_routes.delete_preset(DummyRequest(params={"name": "SDXL%20Draft"}), delete_resp, ctx)
    assert delete_resp.status == 200
    assert delete_resp.data["deleted"] is True
    assert not (tmp_path / "SDXL Draft.json").exists()


def test_preset_rejects_path_traversal_name(tmp_path):
    ctx = _ctx(tmp_path)
    resp = DummyResponse()
    preset_routes.save_preset(
        DummyRequest(
            {
                "name": "../escape",
                "bundle": "sdxl",
                "mode": "img_gen",
                "values": {"prompt": "x"},
            }
        ),
        resp,
        ctx,
    )
    assert resp.status == 400
    assert not list(tmp_path.glob("*.json"))


def test_preset_rejects_bad_value_key(tmp_path):
    ctx = _ctx(tmp_path)
    resp = DummyResponse()
    preset_routes.save_preset(
        DummyRequest(
            {
                "name": "Bad Value",
                "bundle": "sdxl",
                "mode": "img_gen",
                "values": {"bad/key": "x"},
            }
        ),
        resp,
        ctx,
    )
    assert resp.status == 400
