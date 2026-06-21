"""Server lifecycle routes.

- POST /api/shutdown
- POST /api/restart
- POST /api/open-folder
"""

from ..context import AppContext
from ..http import Request, Response, sanitize_error
from ..services import lifecycle_service

# Known folders the Install tab can open. Anything else is rejected.
FOLDER_MAP_KEYS = {"models", "output", "sdcpp", "presets", "root"}


def post_shutdown(request: Request, response: Response, ctx: AppContext) -> None:
    shutting_down = lifecycle_service.shutdown_gui_server(ctx)
    response.json({"shutting_down": shutting_down})


def post_restart(request: Request, response: Response, ctx: AppContext) -> None:
    restarting = lifecycle_service.restart_gui_server(ctx)
    response.json({"restarting": restarting})


def post_open_folder(request: Request, response: Response, ctx: AppContext) -> None:
    body = request.body or {}
    folder = str(body.get("folder", "models")).strip().lower()
    if folder not in FOLDER_MAP_KEYS:
        response.error(f"Unknown folder: {folder}", 400)
        return
    folder_paths = {
        "models": ctx.paths.models,
        "output": ctx.paths.output,
        "sdcpp": ctx.paths.sdcpp,
        "presets": ctx.paths.presets,
        "root": ctx.paths.root,
    }
    target = folder_paths[folder]
    target.mkdir(parents=True, exist_ok=True)
    try:
        lifecycle_service.open_folder_in_file_manager(target)
        response.json({"opened": True})
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
