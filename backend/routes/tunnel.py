"""Cloudflare tunnel routes. ~Verbatim from LLama-GUI. TODO(Phase 5).

- POST /api/remote-tunnel/start
- POST /api/remote-tunnel/stop
- GET  /api/remote-tunnel/status
"""

from backend.context import AppContext
from backend.http import Request, Response
from backend.services import tunnel_service


def start(request: Request, response: Response, ctx: AppContext) -> None:
    port = (request.body or {}).get("port", ctx.config.sd_server_port)
    try:
        response.json(tunnel_service.start(ctx, port))
    except NotImplementedError:
        response.error("Tunnel not implemented yet (Phase 5)", 501)


def stop(request: Request, response: Response, ctx: AppContext) -> None:
    response.json({"stopped": tunnel_service.stop(ctx)})


def get_status(request: Request, response: Response, ctx: AppContext) -> None:
    response.json(tunnel_service.get_snapshot(ctx))
