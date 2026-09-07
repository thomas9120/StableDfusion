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

MODELS_DEFAULT_LIMIT = 5000
MODELS_MAX_LIMIT = 20000


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
        try:
            limit = int((query.get("limit", [""])[0] or "").strip() or MODELS_DEFAULT_LIMIT)
        except (TypeError, ValueError):
            limit = MODELS_DEFAULT_LIMIT
        try:
            offset = int((query.get("offset", [""])[0] or "").strip() or 0)
        except (TypeError, ValueError):
            offset = 0
        limit = min(max(limit, 1), MODELS_MAX_LIMIT)
        offset = max(offset, 0)

        models_root = ctx.paths.models.resolve() if ctx.paths.models.exists() else ctx.paths.models
        files = []
        seen: set[Path] = set()
        for root in model_storage_service.roots_for_listing(ctx, purpose):
            if not root.exists():
                continue
            iterator = (
                root.rglob("*") if root != ctx.paths.models or not purpose else root.glob("*")
            )
            for path in sorted(iterator):
                try:
                    if not path.is_file():
                        continue
                except OSError:
                    continue
                if path.name == ".gitkeep":
                    continue
                if _norm_ext(path.suffix) not in allowed:
                    continue
                try:
                    resolved = path.resolve()
                except OSError:
                    continue
                # Skip symlinks pointing outside the models dir.
                try:
                    resolved.relative_to(models_root)
                except ValueError:
                    continue
                if resolved in seen:
                    continue
                seen.add(resolved)
                try:
                    stat = path.stat()
                except OSError:
                    continue
                try:
                    relative = path.relative_to(ctx.paths.models).as_posix()
                except ValueError:
                    continue
                files.append(
                    {
                        "name": path.name,
                        "relative": relative,
                        "folder": path.parent.relative_to(ctx.paths.models).as_posix()
                        if path.parent != ctx.paths.models
                        else "",
                        "size": stat.st_size,
                        "mtime": int(stat.st_mtime),
                    }
                )
        total = len(files)
        paged = files[offset : offset + limit]
        response.json({"models": paged, "total": total, "limit": limit, "offset": offset})
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
