"""Output gallery routes. See PLAN.md §10 / §16.1.

- GET /api/images                  — list gallery entries (output/.gallery sidecars, newest first)
- GET /api/image/<name>            — serve a result image (path-traversal guarded)
- GET /api/image/<name>/thumbnail  — serve a thumbnail (full image; the gallery
                                      <img> scales it client-side — PLAN.md §16.1 option (b),
                                      Pillow is intentionally not a dependency)
"""

import json
import re
import sys
import urllib.parse

from backend.context import AppContext
from backend.http import Request, Response

# Filenames only — no path separators, no parent refs (path-traversal guard).
_NAME_RE = re.compile(r"^[A-Za-z0-9_.\-]+$")

_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".avi": "video/x-msvideo",
    ".webm": "video/webm",
}


def list_images(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        entries = []
        gallery_dir = ctx.paths.output_gallery
        if gallery_dir.exists():
            try:
                candidates = list(gallery_dir.glob("*.json"))
            except OSError as exc:
                response.error("Could not list images.", 500)
                print(f"[images] list failed: {exc}", file=sys.stderr, flush=True)
                return
            with_mtime = []
            for sidecar in candidates:
                try:
                    with_mtime.append((sidecar.stat().st_mtime, sidecar))
                except OSError:
                    continue
            with_mtime.sort(key=lambda item: item[0], reverse=True)
            for _, sidecar in with_mtime:
                try:
                    data = json.loads(sidecar.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if isinstance(data, dict):
                    entries.append(data)
    except OSError as exc:
        response.error("Could not list images.", 500)
        print(f"[images] list failed: {exc}", file=sys.stderr, flush=True)
        return
    response.json({"images": entries})


def _resolve_image(ctx: AppContext, name: str):
    """Resolve ``name`` to a file under output/, or None if unsafe/missing."""
    if not name or not _NAME_RE.match(name):
        return None
    if name in {".", ".."}:
        return None
    base = ctx.paths.output.resolve()
    try:
        path = (ctx.paths.output / name).resolve()
        path.relative_to(base)
    except (ValueError, OSError):
        return None
    return path if path.is_file() else None


def _content_type(path) -> str:
    return _CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")


def serve_image(request: Request, response: Response, ctx: AppContext) -> None:
    name = urllib.parse.unquote(request.params.get("name", ""))
    if name.endswith("/thumbnail"):
        name = name[: -len("/thumbnail")]
    image_path = _resolve_image(ctx, name)
    if image_path is None:
        response.error("Image not found.", 404)
        return
    headers = {"Cache-Control": "no-cache, must-revalidate"}
    try:
        response.file(image_path, content_type=_content_type(image_path), headers=headers)
    except OSError as exc:
        response.error("Could not read image.", 500)
        print(f"[images] read failed for {name}: {exc}", file=sys.stderr, flush=True)
