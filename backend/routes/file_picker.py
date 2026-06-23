"""Native file picker route. ~Verbatim from LLama-GUI. TODO(Phase 1).

- POST /api/select-file
"""

from backend.context import AppContext
from backend.http import Request, Response, sanitize_error
from backend.services import file_picker_service


def select_file(request: Request, response: Response, ctx: AppContext) -> None:
    body = request.body or {}
    purpose = body.get("purpose", "model")
    try:
        response.json(file_picker_service.select_file(ctx, purpose, body.get("title")))
    except NotImplementedError:
        response.error("File picker not implemented yet (Phase 1)", 501)
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)


def select_directory(request: Request, response: Response, ctx: AppContext) -> None:
    body = request.body or {}
    try:
        response.json(file_picker_service.select_directory(ctx, body.get("title")))
    except NotImplementedError:
        response.error("Directory picker not implemented yet", 501)
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
