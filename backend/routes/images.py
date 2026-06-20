"""Output gallery routes. TODO(Phase 2).

- GET /api/images                 — list gallery entries (from output/.gallery sidecars)
- GET /api/image/<name>           — serve a result image
- GET /api/image/<name>/thumbnail — serve a thumbnail (Phase 2 decision: see PLAN.md §16.1)
"""

from backend.context import AppContext
from backend.http import Request, Response


def list_images(request: Request, response: Response, ctx: AppContext) -> None:
    entries = []
    gallery_dir = ctx.paths.output_gallery
    if gallery_dir.exists():
        for sidecar in sorted(gallery_dir.glob("*.json"), reverse=True):
            try:
                entries.append(__import__("json").loads(sidecar.read_text(encoding="utf-8")))
            except Exception:
                continue
    response.json({"images": entries})


def serve_image(request: Request, response: Response, ctx: AppContext) -> None:
    # TODO(Phase 2): resolve <name> against ctx.paths.output with traversal guards.
    response.error("Image serving not implemented yet (Phase 2)", 501)


def serve_thumbnail(request: Request, response: Response, ctx: AppContext) -> None:
    response.error("Thumbnails not implemented yet (Phase 2)", 501)
