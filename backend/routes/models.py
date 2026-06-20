"""GET /api/models — list model component files in models/. Semi-functional.

TODO(Phase 2/3): filter by ``?type=<diffusion|vae|clip_l|...>`` using
file_picker.PURPOSE_FILTERS heuristics; recurse into subfolders.
"""

from backend.context import AppContext
from backend.http import Request, Response

MODEL_EXTS = (".safetensors", ".ckpt", ".pth", ".pt", ".gguf", ".sft", ".bin")


def list_models(request: Request, response: Response, ctx: AppContext) -> None:
    files = []
    if ctx.paths.models.exists():
        for path in sorted(ctx.paths.models.rglob("*")):
            if path.is_file() and path.suffix.lower() in MODEL_EXTS:
                files.append(
                    {
                        "name": path.name,
                        "relative": path.relative_to(ctx.paths.models).as_posix(),
                        "size": path.stat().st_size,
                    }
                )
    response.json({"models": files})
