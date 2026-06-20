"""Generation routes — the core sd-cli one-shot workflow. TODO(Phase 2).

See PLAN.md §10. Endpoints:
- POST /api/generate
- GET  /api/generate/status
- GET  /api/generate/preview
- POST /api/generate/cancel
"""

from backend.context import AppContext
from backend.http import Request, Response
from backend.services import generate_service


def generate(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        response.json(generate_service.run(ctx, request.body))
    except NotImplementedError:
        response.error("Generation not implemented yet (Phase 2)", 501)


def get_status(request: Request, response: Response, ctx: AppContext) -> None:
    response.json(generate_service.status(ctx))


def get_preview(request: Request, response: Response, ctx: AppContext) -> None:
    response.error("Live preview not implemented yet (Phase 2)", 501)


def cancel(request: Request, response: Response, ctx: AppContext) -> None:
    response.json({"canceled": generate_service.cancel(ctx)})
