"""Native file picker route. ~Verbatim from LLama-GUI. TODO(Phase 1).

- POST /api/select-file
"""

from backend.context import AppContext
from backend.http import Request, Response
from backend.services import file_picker_service


def select_file(request: Request, response: Response, ctx: AppContext) -> None:
    body = request.body or {}
    purpose = body.get("purpose", "model")
    try:
        response.json(file_picker_service.select_file(ctx, purpose, body.get("title")))
    except NotImplementedError:
        response.error("File picker not implemented yet (Phase 1)", 501)
