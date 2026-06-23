"""Persistent sd-server routes.

- POST /api/sd-server/start
- POST /api/sd-server/stop
- GET  /api/sd-server/status
"""

from backend.context import AppContext
from backend.http import Request, Response, sanitize_error
from backend.services import server_mode_service


def start(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        result = server_mode_service.start(ctx, request.body or {})
        if result.get("error"):
            response.error(str(result["error"]), int(result.get("status") or 500))
            return
        response.json(result)
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)


def stop(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        response.json({"stopped": server_mode_service.stop(ctx)})
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)


def get_status(request: Request, response: Response, ctx: AppContext) -> None:
    response.json(server_mode_service.status(ctx))
