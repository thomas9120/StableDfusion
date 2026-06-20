"""Install / release management routes. TODO(Phase 1).

See PLAN.md §11. Endpoints:
- GET  /api/releases
- GET  /api/download-progress
- POST /api/install
- POST /api/update
- POST /api/cleanup-sdcpp
"""

from backend.context import AppContext
from backend.http import Request, Response
from backend.services import sdcpp_manager


def get_releases(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        response.json({"releases": sdcpp_manager.get_releases(ctx)})
    except NotImplementedError:
        response.error("Release fetching not implemented yet (Phase 1)", 501)


def get_download_progress(request: Request, response: Response, ctx: AppContext) -> None:
    response.json(ctx.state.download_progress.snapshot())


def start_install(request: Request, response: Response, ctx: AppContext) -> None:
    response.error("Install not implemented yet (Phase 1)", 501)


def start_update(request: Request, response: Response, ctx: AppContext) -> None:
    response.error("Update not implemented yet (Phase 1)", 501)


def cleanup_sdcpp(request: Request, response: Response, ctx: AppContext) -> None:
    response.error("Cleanup not implemented yet (Phase 1)", 501)
