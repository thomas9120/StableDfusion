"""Tests for model component folder listing."""

import json
import sys
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.context import AppContext, AppPaths  # noqa: E402
from backend.http import Request, Response  # noqa: E402
from backend.routes import models as models_route  # noqa: E402


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
    return AppContext(paths=AppPaths(models=tmp_path / "models"))


def _list(ctx: AppContext, query: str) -> dict:
    handler = _Handler()
    request = Request("GET", "/api/models", query, {}, {}, {})
    models_route.list_models(request, Response(handler), ctx)
    assert handler.status == 200
    return json.loads(handler.wfile.getvalue().decode("utf-8"))


def test_purpose_listing_uses_component_folder_and_legacy_root(tmp_path):
    ctx = _ctx(tmp_path)
    (ctx.paths.models / "diffusion").mkdir(parents=True)
    (ctx.paths.models / "vae").mkdir()
    (ctx.paths.models / "diffusion" / "z-image.gguf").write_bytes(b"x")
    (ctx.paths.models / "vae" / "ae.safetensors").write_bytes(b"x")
    (ctx.paths.models / "legacy.safetensors").write_bytes(b"x")

    out = _list(ctx, "type=diffusion_model")
    rels = [m["relative"] for m in out["models"]]

    assert rels == ["diffusion/z-image.gguf", "legacy.safetensors"]


def test_text_encoder_listing_does_not_leak_diffusion_folder(tmp_path):
    ctx = _ctx(tmp_path)
    (ctx.paths.models / "diffusion").mkdir(parents=True)
    (ctx.paths.models / "text-encoders").mkdir()
    (ctx.paths.models / "diffusion" / "model.gguf").write_bytes(b"x")
    (ctx.paths.models / "text-encoders" / "qwen.gguf").write_bytes(b"x")

    out = _list(ctx, "type=llm")
    rels = [m["relative"] for m in out["models"]]

    assert rels == ["text-encoders/qwen.gguf"]
