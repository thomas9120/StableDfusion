"""GET /api/models — list model component files in models/.

Query ``?type=<purpose>`` filters by that purpose's file extensions using the
shared file_picker.PURPOSE_FILTERS heuristics (best-effort: SD weights share
extensions, so the filter is a hint, not a guarantee). Purpose-specific queries
prefer the matching component subfolder while still showing legacy root files.
Each entry carries name, relative path, size, and mtime (PLAN.md §13).
"""

import urllib.parse
from pathlib import Path

from backend.context import AppContext
from backend.http import Request, Response, sanitize_error
from backend.services import file_picker_service, model_storage_service

MODEL_EXTS = (".safetensors", ".ckpt", ".pth", ".pt", ".gguf", ".sft", ".bin")


def _norm_ext(value: str) -> str:
    """Normalize an extension to a dotless lowercase form for comparison."""
    return (value or "").lower().lstrip(".")


def _extensions_for_type(purpose: str) -> tuple[str, ...]:
    """Return the extensions advertised for a picker purpose, else all model exts."""
    purpose = model_storage_service.normalize_purpose(purpose)
    if purpose == "lora_model_dir":
        purpose = "lora"
    entry = file_picker_service.PURPOSE_FILTERS.get(purpose)
    if not entry:
        return MODEL_EXTS
    filetypes = entry[0]
    extensions: list[str] = []
    for _label, pattern_group in filetypes:
        for pattern in str(pattern_group or "").split():
            if pattern.startswith("*."):
                ext = pattern[2:].strip().lower()
                if ext and ext not in extensions:
                    extensions.append(ext)
    return tuple(extensions) or MODEL_EXTS


def list_models(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        query = urllib.parse.parse_qs(request.query or "")
        purpose = model_storage_service.normalize_purpose(query.get("type", [""])[0])
        exts = _extensions_for_type(purpose) if purpose else MODEL_EXTS
        allowed = {_norm_ext(e) for e in exts}

        files = []
        seen: set[Path] = set()
        for root in model_storage_service.roots_for_listing(ctx, purpose):
            if not root.exists():
                continue
            iterator = (
                root.rglob("*") if root != ctx.paths.models or not purpose else root.glob("*")
            )
            for path in sorted(iterator):
                if not path.is_file():
                    continue
                if path.name == ".gitkeep":
                    continue
                if _norm_ext(path.suffix) not in allowed:
                    continue
                resolved = path.resolve()
                if resolved in seen:
                    continue
                seen.add(resolved)
                stat = path.stat()
                files.append(
                    {
                        "name": path.name,
                        "relative": path.relative_to(ctx.paths.models).as_posix(),
                        "folder": path.parent.relative_to(ctx.paths.models).as_posix()
                        if path.parent != ctx.paths.models
                        else "",
                        "size": stat.st_size,
                        "mtime": int(stat.st_mtime),
                    }
                )
        response.json({"models": files})
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
