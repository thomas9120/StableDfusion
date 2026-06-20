"""Preset CRUD routes. TODO(Phase 4).

Mirrors LLama-GUI's presets route, adapted so presets = generation configs.
- GET    /api/presets
- POST   /api/presets
- DELETE /api/presets/<name>
- POST   /api/presets/shortcut
"""

from backend.context import AppContext
from backend.http import Request, Response


def list_presets(request: Request, response: Response, ctx: AppContext) -> None:
    presets = []
    if ctx.paths.presets.exists():
        for path in sorted(ctx.paths.presets.glob("*.json")):
            presets.append({"name": path.stem, "path": path.name})
    response.json({"presets": presets})


def save_preset(request: Request, response: Response, ctx: AppContext) -> None:
    response.error("Preset save not implemented yet (Phase 4)", 501)


def delete_preset(request: Request, response: Response, ctx: AppContext) -> None:
    response.error("Preset delete not implemented yet (Phase 4)", 501)


def export_preset_shortcut(request: Request, response: Response, ctx: AppContext) -> None:
    response.error("Preset shortcut not implemented yet (Phase 4)", 501)
