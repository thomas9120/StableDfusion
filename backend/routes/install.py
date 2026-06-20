"""Install / release management routes. PLAN.md §11.

Endpoints:
- GET  /api/releases
- GET  /api/download-progress
- POST /api/install
- POST /api/update
- POST /api/cleanup-sdcpp
"""

import threading

from backend.context import AppContext
from backend.http import Request, Response, sanitize_error
from backend.services import process_manager, sdcpp_manager

RELEASE_RESPONSE_LIMIT = 30


def get_releases(request: Request, response: Response, ctx: AppContext) -> None:
    # ?force=1 bypasses the short-term cache (manual refresh).
    force = "force" in (request.query or "")
    try:
        releases = sdcpp_manager.get_releases(ctx, force=force)
        result = []
        for r in releases[:RELEASE_RESPONSE_LIMIT]:
            result.append(
                {
                    "tag": r["tag_name"],
                    "name": r.get("name", r["tag_name"]),
                    "published": r["published_at"],
                    "assets": [a["name"] for a in r.get("assets", [])],
                }
            )
        response.json(result)
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)


def get_download_progress(request: Request, response: Response, ctx: AppContext) -> None:
    response.json(sdcpp_manager.get_download_progress_snapshot(ctx))


def start_install(request: Request, response: Response, ctx: AppContext) -> None:
    body = request.body or {}
    tag = body.get("tag")
    backend = body.get("backend")
    if not tag or not backend:
        response.error("tag and backend required", 400)
        return
    if backend not in ctx.services.backend_specs:
        response.error(f"Unsupported backend: {backend}", 400)
        return
    if process_manager.is_process_running(ctx):
        response.error("Stop running process first", 400)
        return
    with ctx.state.install_lock:
        if ctx.state.install_in_progress:
            response.error("Installation already in progress", 409)
            return
        ctx.state.install_in_progress = True

    def _install(tag_value, backend_value):
        try:
            sdcpp_manager.install_release(ctx, tag_value, backend_value, ctx.services.backend_specs)
        finally:
            with ctx.state.install_lock:
                ctx.state.install_in_progress = False

    threading.Thread(target=_install, args=(tag, backend), daemon=True).start()
    response.json({"status": "started"})


def start_update(request: Request, response: Response, ctx: AppContext) -> None:
    cfg = ctx.services.load_config()
    tag = cfg.get("tag")
    backend = cfg.get("backend")
    if not tag or not backend:
        response.error("Nothing installed to update", 400)
        return
    if backend not in ctx.services.backend_specs:
        response.error(f"Unsupported configured backend: {backend}", 400)
        return
    if process_manager.is_process_running(ctx):
        response.error("Stop running process first", 400)
        return
    with ctx.state.install_lock:
        if ctx.state.install_in_progress:
            response.error("Installation already in progress", 409)
            return
        ctx.state.install_in_progress = True
    try:
        releases = sdcpp_manager.get_releases(ctx)
        latest = releases[0]["tag_name"] if releases else None
        if latest and latest != tag:

            def _update(latest_tag, backend_name):
                try:
                    sdcpp_manager.install_release(
                        ctx, latest_tag, backend_name, ctx.services.backend_specs
                    )
                finally:
                    with ctx.state.install_lock:
                        ctx.state.install_in_progress = False

            threading.Thread(target=_update, args=(latest, backend), daemon=True).start()
            response.json({"status": "started", "from": tag, "to": latest})
        else:
            with ctx.state.install_lock:
                ctx.state.install_in_progress = False
            response.json({"status": "already_latest"})
    except Exception as exc:
        with ctx.state.install_lock:
            ctx.state.install_in_progress = False
        response.error(sanitize_error(exc, 500), 500)


def cleanup_sdcpp(request: Request, response: Response, ctx: AppContext) -> None:
    if process_manager.is_process_running(ctx):
        response.error("Stop running process first", 400)
        return
    try:
        response.json({"removed_files": sdcpp_manager.remove_sdcpp_files(ctx)})
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
