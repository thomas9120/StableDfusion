"""Persistent sd-server routes. TODO(Phase 5).

- POST /api/sd-server/start
- POST /api/sd-server/stop
- GET  /api/sd-server/status
"""

from backend.context import AppContext
from backend.http import Request, Response


def start(request: Request, response: Response, ctx: AppContext) -> None:
    response.error("sd-server start not implemented yet (Phase 5)", 501)


def stop(request: Request, response: Response, ctx: AppContext) -> None:
    response.error("sd-server stop not implemented yet (Phase 5)", 501)


def get_status(request: Request, response: Response, ctx: AppContext) -> None:
    response.json(ctx.state.sd_server.snapshot())
