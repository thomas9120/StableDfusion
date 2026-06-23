"""Install / release management routes. PLAN.md §11.

Endpoints:
- GET  /api/releases
- GET  /api/download-progress
- POST /api/install
- POST /api/update
- POST /api/cleanup-sdcpp
- POST /api/sdcpp/active
- POST /api/sdcpp/repair
- POST /api/sdcpp/update
- POST /api/sdcpp/remove
"""

import threading

from backend.context import AppContext
from backend.http import Request, Response, sanitize_error
from backend.services import process_manager, sdcpp_manager

RELEASE_RESPONSE_LIMIT = 30


def _runtime_process_running(ctx: AppContext) -> bool:
    if process_manager.is_process_running(ctx):
        return True
    proc = ctx.state.sd_server_process
    return proc is not None and proc.poll() is None


def _runtime_payload(request: Request, response: Response, ctx: AppContext):
    body = request.body or {}
    tag = body.get("tag")
    backend = body.get("backend")
    if not tag or not backend:
        response.error("tag and backend required", 400)
        return None
    tag, backend = str(tag), str(backend)
    # Validate before any use: tag is later interpolated into a GitHub API URL
    # and used to build filesystem paths. Strict regex prevents URL/path
    # injection (H5) and path traversal.
    if not sdcpp_manager.INSTALL_ID_RE.fullmatch(tag) or not sdcpp_manager.INSTALL_ID_RE.fullmatch(
        backend
    ):
        response.error("Invalid tag or backend.", 400)
        return None
    if backend not in ctx.services.backend_specs:
        response.error(f"Unsupported backend: {backend}", 400)
        return None
    return tag, backend


def _begin_install_operation(response: Response, ctx: AppContext) -> bool:
    if _runtime_process_running(ctx):
        response.error("Stop running process first", 400)
        return False
    with ctx.state.install_lock:
        if ctx.state.install_in_progress:
            response.error("Installation already in progress", 409)
            return False
        ctx.state.install_in_progress = True
        return True


def _finish_install_operation(ctx: AppContext) -> None:
    with ctx.state.install_lock:
        ctx.state.install_in_progress = False


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
    payload = _runtime_payload(request, response, ctx)
    if payload is None:
        return
    tag, backend = payload
    if not _begin_install_operation(response, ctx):
        return

    def _install(tag_value, backend_value):
        try:
            sdcpp_manager.install_release(ctx, tag_value, backend_value, ctx.services.backend_specs)
        finally:
            _finish_install_operation(ctx)

    threading.Thread(target=_install, args=(tag, backend), daemon=True).start()
    response.json({"status": "started"})


def start_update(request: Request, response: Response, ctx: AppContext) -> None:
    cfg = sdcpp_manager.normalize_install_config(ctx.services.load_config())
    tag = cfg.get("tag")
    backend = cfg.get("backend")
    if not tag or not backend:
        response.error("Nothing installed to update", 400)
        return
    if backend not in ctx.services.backend_specs:
        response.error(f"Unsupported configured backend: {backend}", 400)
        return
    start_runtime_update(tag, backend, response, ctx)


def set_active_runtime(request: Request, response: Response, ctx: AppContext) -> None:
    payload = _runtime_payload(request, response, ctx)
    if payload is None:
        return
    if _runtime_process_running(ctx):
        response.error("Stop running process first", 400)
        return
    tag, backend = payload
    # Guard install state: refuse while an install/repair/update is running and
    # hold install_lock across the mutation so it cannot race a concurrent
    # install thread writing config.json or extracting into sdcpp/.
    with ctx.state.install_lock:
        if ctx.state.install_in_progress:
            response.error("Installation already in progress", 409)
            return
        try:
            result = sdcpp_manager.set_active_runtime(ctx, tag, backend)
        except ValueError as exc:
            response.error(str(exc), 400)
            return
        except Exception as exc:
            response.error(sanitize_error(exc, 500), 500)
            return
    response.json({"active_install": result})


def repair_runtime(request: Request, response: Response, ctx: AppContext) -> None:
    payload = _runtime_payload(request, response, ctx)
    if payload is None:
        return
    tag, backend = payload
    if not _begin_install_operation(response, ctx):
        return
    set_active = sdcpp_manager.is_active_runtime(ctx, tag, backend)

    def _repair(tag_value, backend_value, should_activate):
        try:
            sdcpp_manager.install_release(
                ctx,
                tag_value,
                backend_value,
                ctx.services.backend_specs,
                set_active=should_activate,
            )
        finally:
            _finish_install_operation(ctx)

    threading.Thread(target=_repair, args=(tag, backend, set_active), daemon=True).start()
    response.json({"status": "started", "tag": tag, "backend": backend})


def start_runtime_update(tag: str, backend: str, response: Response, ctx: AppContext) -> None:
    if not _begin_install_operation(response, ctx):
        return

    def _update(tag_value, backend_value):
        try:
            sdcpp_manager.update_runtime(ctx, tag_value, backend_value, ctx.services.backend_specs)
        finally:
            _finish_install_operation(ctx)

    threading.Thread(target=_update, args=(tag, backend), daemon=True).start()
    response.json({"status": "started", "tag": tag, "backend": backend})


def update_runtime(request: Request, response: Response, ctx: AppContext) -> None:
    payload = _runtime_payload(request, response, ctx)
    if payload is None:
        return
    tag, backend = payload
    start_runtime_update(tag, backend, response, ctx)


def remove_runtime(request: Request, response: Response, ctx: AppContext) -> None:
    payload = _runtime_payload(request, response, ctx)
    if payload is None:
        return
    if _runtime_process_running(ctx):
        response.error("Stop running process first", 400)
        return
    tag, backend = payload
    with ctx.state.install_lock:
        if ctx.state.install_in_progress:
            response.error("Installation already in progress", 409)
            return
        try:
            result = sdcpp_manager.remove_runtime(ctx, tag, backend)
        except ValueError as exc:
            response.error(str(exc), 400)
            return
        except Exception as exc:
            response.error(sanitize_error(exc, 500), 500)
            return
    response.json(result)


def cleanup_sdcpp(request: Request, response: Response, ctx: AppContext) -> None:
    if _runtime_process_running(ctx):
        response.error("Stop running process first", 400)
        return
    with ctx.state.install_lock:
        if ctx.state.install_in_progress:
            response.error("Installation already in progress", 409)
            return
        try:
            removed = sdcpp_manager.remove_sdcpp_files(ctx)
        except Exception as exc:
            response.error(sanitize_error(exc, 500), 500)
            return
    response.json({"removed_files": removed})
