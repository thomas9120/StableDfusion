"""Generation routes — the core sd-cli one-shot workflow. See PLAN.md §10.

- POST /api/generate          → start a generation, returns {job_id}
- GET  /api/generate/status   → {state, step, total_steps, percent, ...}
- GET  /api/generate/preview  → current preview PNG bytes (cache-busted by mtime)
- POST /api/generate/cancel   → {canceled}
"""

from backend.context import AppContext
from backend.http import Request, Response
from backend.services import generate_service


def generate(request: Request, response: Response, ctx: AppContext) -> None:
    result = generate_service.run(ctx, request.body or {})
    if "error" in result:
        response.error(result["error"], 400)
        return
    response.json(result)


def get_status(request: Request, response: Response, ctx: AppContext) -> None:
    response.json(generate_service.status(ctx))


def get_preview(request: Request, response: Response, ctx: AppContext) -> None:
    snap = generate_service.status(ctx)
    job_id = snap.get("job_id", "")
    mode = snap.get("mode", "img_gen")
    preview_ext = generate_service.preview_ext_for_mode(mode)
    content_type = generate_service.preview_content_type_for_mode(mode)
    preview_path = ctx.paths.output_preview / f"{job_id}{preview_ext}"
    if not job_id or not preview_path.is_file():
        response.error("No preview available yet.", 404)
        return
    try:
        data = preview_path.read_bytes()
    except OSError as exc:
        response.error("Could not read preview.", 500)
        print(f"[generate/preview] {exc}", flush=True)
        return
    # Cache-busting handled client-side via mtime query param.
    response.bytes(
        data,
        content_type=content_type,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )


def cancel(request: Request, response: Response, ctx: AppContext) -> None:
    response.json({"canceled": generate_service.cancel(ctx)})
