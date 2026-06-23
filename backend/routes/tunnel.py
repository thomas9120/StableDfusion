"""Cloudflare tunnel routes. ~Verbatim from LLama-GUI.

- POST /api/remote-tunnel/start
- POST /api/remote-tunnel/stop
- GET  /api/remote-tunnel/status
"""

from backend.context import AppContext
from backend.http import Request, Response, sanitize_error
from backend.services import tunnel_service


def start(request: Request, response: Response, ctx: AppContext) -> None:
    port = (request.body or {}).get("port", ctx.config.sd_server_port)
    try:
        response.json(tunnel_service.start(ctx, port))
    except ValueError as exc:
        response.error(str(exc), 400)
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)


def stop(request: Request, response: Response, ctx: AppContext) -> None:
    response.json({"stopped": tunnel_service.stop(ctx)})


def get_status(request: Request, response: Response, ctx: AppContext) -> None:
    response.json(tunnel_service.get_snapshot(ctx))
