"""App git-update routes. ~Verbatim from LLama-GUI. TODO(Phase 1).

- GET  /api/app-update-status
- POST /api/app-update
"""

from backend.context import AppContext
from backend.http import Request, Response, sanitize_error
from backend.services import git_update_service


def get_status(request: Request, response: Response, ctx: AppContext) -> None:
    fetch = (request.query or "").lower().find("fetch=true") >= 0
    try:
        response.json(git_update_service.get_status(ctx, fetch=fetch))
    except NotImplementedError:
        response.error("App update status not implemented yet (Phase 1)", 501)
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)


def start_update(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        response.json(git_update_service.start_update(ctx))
    except NotImplementedError:
        response.error("App update not implemented yet (Phase 1)", 501)
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
