"""Hugging Face download routes (Phase 3).

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
    repo_id = (body.get("repo_id") or "").strip()
    revision = (body.get("revision") or "main").strip() or "main"
    token = (body.get("token") or "").strip() or None

    if not hf_download_service.validate_hf_repo_id(repo_id):
        response.error("Invalid repo id (expected 'owner/name').", 400)
        return
    if not hf_download_service.validate_hf_revision(revision):
        response.error("Invalid revision.", 400)
        return
    try:
        response.json(hf_download_service.get_repo_files(ctx, repo_id, revision, token))
    except hf_download_service.RepoListingError as exc:
        # 502: we reached HuggingFace but it rejected the request (not found,
        # unauthorized, rate-limited, etc.).
        response.error(f"Hugging Face: {exc}", 502)
    except Exception as exc:
        # Network/SSL/unexpected — surface a clean message, full trace to stderr.
        print(f"[hf/repo-files] {exc}", flush=True)
        response.error("Could not reach Hugging Face. Check your network and try again.", 502)


def start_download(request: Request, response: Response, ctx: AppContext) -> None:
    body = request.body or {}
    result = hf_download_service.start_download(ctx, body)
    if "error" in result:
        status = 409 if result["error"] == "A download is already in progress" else 400
        response.error(result["error"], status)
        return
    response.json(result)


def get_download_status(request: Request, response: Response, ctx: AppContext) -> None:
    response.json(hf_download_service.get_status(ctx))


def cancel_download(request: Request, response: Response, ctx: AppContext) -> None:
    canceled = hf_download_service.cancel(ctx)
    response.json({"canceled": canceled})
