"""Server lifecycle routes. TODO(Phase 1).

- POST /api/shutdown
- POST /api/restart
- POST /api/open-folder
"""

import subprocess
import sys
import threading

from backend.context import AppContext
from backend.http import Request, Response
from backend.services import lifecycle_service


def _shutdown_target(ctx: AppContext) -> None:
    lifecycle_service.shutdown(ctx)
    sys.exit(0)


def post_shutdown(request: Request, response: Response, ctx: AppContext) -> None:
    response.json({"shutting_down": True})
    threading.Thread(target=_shutdown_target, args=(ctx,), daemon=True).start()


def post_restart(request: Request, response: Response, ctx: AppContext) -> None:
    # TODO(Phase 1): re-exec server.py like LLama-GUI.
    response.error("Restart not implemented yet (Phase 1)", 501)


def post_open_folder(request: Request, response: Response, ctx: AppContext) -> None:
    target = (request.body or {}).get("path", "")
    if not target:
        response.error("Missing path", 400)
        return
    # TODO(Phase 1): validate target is within known dirs before opening.
    try:
        if sys.platform == "win32":
            subprocess.Popen(["explorer", str(target)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])
        response.json({"opened": True})
    except Exception as exc:
        response.error(str(exc), 500)
