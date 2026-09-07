"""Generation routes — the core sd-cli one-shot workflow. See PLAN.md §10.

- POST /api/generate          → start a generation, returns {job_id}
- GET  /api/generate/status   → {state, step, total_steps, percent, ...}
- GET  /api/generate/preview  → current preview PNG bytes (cache-busted by mtime)
- POST /api/generate/cancel   → {canceled}
"""

import re as _re

from backend.context import AppContext
from backend.http import Request, Response, sanitize_error
from backend.services import generate_service

_JOB_ID_RE = _re.compile(r"^[A-Za-z0-9_.-]{1,128}$")


def _valid_job_id(job_id: str) -> bool:
    return bool(job_id) and bool(_JOB_ID_RE.fullmatch(job_id)) and job_id not in {".", ".."}


def generate(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        result = generate_service.run(ctx, request.body or {})
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
        return
    if "error" in result:
        code = result.get("code", "")
        if code == "already_running":
            status = 409
        elif code == "invalid_request":
            status = 400
        else:
            # Backward compat: legacy string match for callers/tests that
            # construct the error dict without a code.
            status = 409 if result["error"] == "A generation is already running" else 400
        response.error(result["error"], status, code=code or None)
        return
    response.json(result)


def get_status(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        response.json(generate_service.status(ctx))
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)


def get_preview(request: Request, response: Response, ctx: AppContext) -> None:
    snap = generate_service.status(ctx)
    job_id = snap.get("job_id", "")
    mode = snap.get("mode", "img_gen")
    preview_ext = generate_service.preview_ext_for_mode(mode)
    content_type = generate_service.preview_content_type_for_mode(mode)
    if not job_id or not _valid_job_id(str(job_id)):
        response.error("No preview available yet.", 404)
        return
    preview_path = ctx.paths.output_preview / f"{job_id}{preview_ext}"
    try:
        response.file(
            preview_path,
            content_type=content_type,
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
        )
    except FileNotFoundError:
        response.error("No preview available yet.", 404)
    except OSError as exc:
        response.error(sanitize_error(exc, 500), 500)


def cancel(request: Request, response: Response, ctx: AppContext) -> None:
    response.json({"canceled": generate_service.cancel(ctx)})
