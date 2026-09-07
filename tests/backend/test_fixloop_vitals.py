"""Vital coverage for fix-loop F5: branch validation, subdir inference,
sd-server 403, install 409, and error-code echo on generate/HF routes."""

import json
import sys
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402

from backend.context import AppContext, AppPaths  # noqa: E402
from backend.http import Request, Response  # noqa: E402
from backend.routes import generate as generate_route  # noqa: E402
from backend.routes import hf_download as hf_download_route  # noqa: E402
from backend.routes import install as install_routes  # noqa: E402
from backend.services import (  # noqa: E402
    git_update_service,
    model_storage_service,
    server_mode_service,
)


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
    return AppContext(
        paths=AppPaths(
            models=tmp_path / "models",
            output=tmp_path / "output",
            output_gallery=tmp_path / "output" / ".gallery",
            output_preview=tmp_path / "output" / ".preview",
        )
    )


def _body(handler: _Handler) -> dict:
    return json.loads(handler.wfile.getvalue().decode("utf-8"))


# ── validate_branch_name accept/reject ────────────────────────────────


def test_validate_branch_name_accepts_canonical():
    assert git_update_service.validate_branch_name("main") == "main"
    assert git_update_service.validate_branch_name("feature/foo-1.2") == "feature/foo-1.2"


def test_validate_branch_name_rejects_option_and_traversal():
    for bad in ("", "-main", ".hidden", "a..b", "a b", "a;rm", "a" * 256):
        with pytest.raises(ValueError):
            git_update_service.validate_branch_name(bad)


# ── infer_subdir enclipper→diffusion, clip-vit→text-encoders ──────────


def test_infer_subdir_enclipper_stays_diffusion():
    assert model_storage_service.infer_subdir_for_filename("enclipper.gguf") == "diffusion"


def test_infer_subdir_hyphenated_clip_dir_routes_to_text_encoders():
    assert (
        model_storage_service.infer_subdir_for_filename("clip-vit/model.safetensors")
        == "text-encoders"
    )


# ── sd-server start 403 on non-loopback without token/insecure ────────


def test_sd_server_start_403_on_non_loopback_without_token(tmp_path, monkeypatch):
    from backend import config as config_module

    ctx = _ctx(tmp_path)
    monkeypatch.setattr(config_module, "GUI_TOKEN", "")
    monkeypatch.setattr(config_module, "GUI_ALLOW_INSECURE", False)
    result = server_mode_service.start(
        ctx,
        {"host": "0.0.0.0", "port": 1234, "args": [["--model", "m.gguf"]]},
    )
    assert result.get("status") == 403


# ── install 409 when generation running ───────────────────────────────


def test_install_409_when_generation_running(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    ctx.state.generation.update(state="running")
    try:
        monkeypatch.setattr(install_routes.process_manager, "is_process_running", lambda _c: False)
        handler = _Handler()
        request = Request("POST", "/api/install", "", {}, {"tag": "t1", "backend": "cpu"}, {})
        ctx.services.backend_specs = {"cpu": {}}
        install_routes.start_install(request, Response(handler), ctx)
        assert handler.status == 409
        assert b"Stop the running generation first" in handler.wfile.getvalue()
    finally:
        ctx.state.generation.update(state="idle")


# ── HF / generate code echo ───────────────────────────────────────────


def test_generate_route_echoes_code(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    monkeypatch.setattr(
        generate_route.generate_service,
        "run",
        lambda _c, _b: {"error": "A generation is already running", "code": "already_running"},
    )
    handler = _Handler()
    generate_route.generate(
        Request("POST", "/api/generate", "", {}, {}, {}), Response(handler), ctx
    )
    assert handler.status == 409
    assert _body(handler).get("code") == "already_running"


def test_hf_download_route_echoes_code(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    monkeypatch.setattr(
        hf_download_route.hf_download_service,
        "start_download",
        lambda _c, _b: {"error": "bad", "code": "invalid_request"},
    )
    handler = _Handler()
    hf_download_route.start_download(
        Request("POST", "/api/hf/download", "", {}, {}, {}), Response(handler), ctx
    )
    assert handler.status == 400
    assert _body(handler).get("code") == "invalid_request"
