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


def test_vae_listing_uses_component_folder(tmp_path):
    ctx = _ctx(tmp_path)
    (ctx.paths.models / "vae").mkdir(parents=True)
    (ctx.paths.models / "text-encoders").mkdir()
    (ctx.paths.models / "vae" / "ae.safetensors").write_bytes(b"x")
    (ctx.paths.models / "text-encoders" / "qwen.gguf").write_bytes(b"x")

    out = _list(ctx, "type=vae")
    rels = [m["relative"] for m in out["models"]]

    assert rels == ["vae/ae.safetensors"]


def test_lora_model_dir_alias_lists_loras_folder(tmp_path):
    ctx = _ctx(tmp_path)
    (ctx.paths.models / "loras").mkdir(parents=True)
    (ctx.paths.models / "vae").mkdir()
    (ctx.paths.models / "loras" / "style.safetensors").write_bytes(b"x")
    (ctx.paths.models / "vae" / "ae.safetensors").write_bytes(b"x")

    out = _list(ctx, "type=lora-model-dir")
    rels = [m["relative"] for m in out["models"]]

    assert rels == ["loras/style.safetensors"]


def test_upscaler_listing_uses_upscalers_folder_and_esrgan_alias(tmp_path):
    ctx = _ctx(tmp_path)
    (ctx.paths.models / "upscalers").mkdir(parents=True)
    (ctx.paths.models / "diffusion").mkdir()
    (ctx.paths.models / "upscalers" / "RealESRGAN_x4plus.pth").write_bytes(b"x")
    (ctx.paths.models / "diffusion" / "model.gguf").write_bytes(b"x")

    out = _list(ctx, "type=upscaler")
    alias_out = _list(ctx, "type=esrgan")

    assert [m["relative"] for m in out["models"]] == ["upscalers/RealESRGAN_x4plus.pth"]
    assert [m["relative"] for m in alias_out["models"]] == ["upscalers/RealESRGAN_x4plus.pth"]


def _seed_numbered(ctx, count: int) -> None:
    (ctx.paths.models / "diffusion").mkdir(parents=True, exist_ok=True)
    for i in range(count):
        (ctx.paths.models / "diffusion" / f"m{i:02d}.gguf").write_bytes(b"x")


def test_limit_zero_returns_capped_default_not_unbounded(tmp_path):
    ctx = _ctx(tmp_path)
    _seed_numbered(ctx, 3)
    out = _list(ctx, "limit=0")
    assert out["limit"] == 1
    assert out["total"] == 3
    assert len(out["models"]) == 1


def test_limit_offset_pagination_and_total_echo(tmp_path):
    ctx = _ctx(tmp_path)
    _seed_numbered(ctx, 4)
    out = _list(ctx, "limit=1&offset=1")
    assert out["total"] == 4
    assert out["limit"] == 1
    assert out["offset"] == 1
    assert len(out["models"]) == 1
    full = _list(ctx, "")
    assert out["models"][0]["relative"] == full["models"][1]["relative"]


def test_symlink_outside_models_dir_is_skipped(tmp_path):
    import os

    ctx = _ctx(tmp_path)
    (ctx.paths.models / "diffusion").mkdir(parents=True)
    (ctx.paths.models / "diffusion" / "real.gguf").write_bytes(b"x")
    outside = tmp_path / "outside.gguf"
    outside.write_bytes(b"x")
    link = ctx.paths.models / "diffusion" / "evil.gguf"
    try:
        os.symlink(str(outside), str(link))
    except (OSError, NotImplementedError):
        return
    out = _list(ctx, "")
    rels = [m["relative"] for m in out["models"]]
    assert "diffusion/evil.gguf" not in rels
    assert "diffusion/real.gguf" in rels


def test_huge_limit_is_capped_at_max(tmp_path):
    ctx = _ctx(tmp_path)
    _seed_numbered(ctx, 3)
    out = _list(ctx, "limit=999999")
    assert out["limit"] == 20000
    assert out["total"] == 3
    assert len(out["models"]) == 3
