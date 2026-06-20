"""GET /api/status — server + install status. Functional (scaffold)."""

import json

from backend.context import AppContext
from backend.http import Request, Response


def get_status(request: Request, response: Response, ctx: AppContext) -> None:
    config_data: dict = {"version": None, "backend": None, "tag": None}
    try:
        if ctx.paths.config_file.exists():
            config_data = json.loads(ctx.paths.config_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        pass
    response.json(
        {
            "app": "Stable-D GUI",
            "platform": ctx.services.current_platform,
            "arch": ctx.services.current_arch,
            "installed": config_data,
            "backend_specs": list(ctx.services.backend_specs.keys()),
            "process_running": ctx.services.is_process_running(),
        }
    )
