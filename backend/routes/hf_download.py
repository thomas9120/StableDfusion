"""Hugging Face download routes. TODO(Phase 3).

- POST /api/hf/repo-files
- POST /api/hf/download
- GET  /api/hf/download-status
- POST /api/hf/download-cancel
"""

from backend.context import AppContext
from backend.http import Request, Response
from backend.services import hf_download_service


def list_repo_files(request: Request, response: Response, ctx: AppContext) -> None:
    body = request.body or {}
    repo_id = body.get("repo_id", "")
    if not hf_download_service.validate_hf_repo_id(repo_id):
        response.error("Invalid repo id", 400)
        return
    try:
        response.json(
            hf_download_service.get_repo_files(
                ctx, repo_id, body.get("revision", "main"), body.get("token")
            )
        )
    except NotImplementedError:
        response.error("HF listing not implemented yet (Phase 3)", 501)


def start_download(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        response.json(hf_download_service.start_download(ctx, request.body or {}))
    except NotImplementedError:
        response.error("HF download not implemented yet (Phase 3)", 501)


def get_download_status(request: Request, response: Response, ctx: AppContext) -> None:
    response.json(ctx.state.model_download.snapshot())


def cancel_download(request: Request, response: Response, ctx: AppContext) -> None:
    ctx.state.model_download_cancel.set()
    response.json({"canceled": True})
