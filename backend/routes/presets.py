"""Preset CRUD routes.

Presets are saved generation configurations grouped by model type/bundle.

- GET    /api/presets
- POST   /api/presets
- DELETE /api/presets/<name>
- POST   /api/presets/shortcut
"""

import datetime
import json
import re
import urllib.parse
from pathlib import Path
from typing import Any

from ..context import AppContext
from ..http import Request, Response

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$")
_KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,96}$")
_BUNDLE_RE = re.compile(r"^[A-Za-z0-9_.-]{0,64}$")
_VALID_MODES = {"img_gen", "vid_gen", "upscale", "convert", "metadata"}
_MAX_STRING_LEN = 20000
_MAX_JSON_BYTES = 250000


def _utc_now() -> str:
    return datetime.datetime.now(datetime.UTC).isoformat()


def _validate_name(value: Any) -> str:
    name = str(value or "").strip()
    if not _NAME_RE.fullmatch(name):
        raise ValueError(
            "Preset name must start with a letter or number and use only letters, "
            "numbers, spaces, dots, underscores, and hyphens."
        )
    if name.upper() in {"CON", "PRN", "AUX", "NUL"}:
        raise ValueError("Preset name is reserved on this platform.")
    return name


def _validate_bundle(value: Any) -> str:
    bundle = str(value or "custom").strip() or "custom"
    if not _BUNDLE_RE.fullmatch(bundle):
        raise ValueError("Preset model type is invalid.")
    return bundle


def _validate_text(value: Any, field: str, limit: int = 500) -> str:
    text = str(value or "").strip()
    if "\x00" in text:
        raise ValueError(f"{field} may not contain NUL bytes.")
    if len(text) > limit:
        raise ValueError(f"{field} is too long.")
    return text


def _preset_path(ctx: AppContext, name: str) -> Path:
    path = (ctx.paths.presets / f"{name}.json").resolve()
    base = ctx.paths.presets.resolve()
    path.relative_to(base)
    return path


def _json_safe(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        raise ValueError("Preset value is nested too deeply.")
    if value is None or isinstance(value, bool | int | float):
        return value
    if isinstance(value, str):
        if "\x00" in value:
            raise ValueError("Preset values may not contain NUL bytes.")
        if len(value) > _MAX_STRING_LEN:
            raise ValueError("Preset string value is too long.")
        return value
    if isinstance(value, list):
        if len(value) > 100:
            raise ValueError("Preset list value is too long.")
        return [_json_safe(item, depth + 1) for item in value]
    if isinstance(value, dict):
        if len(value) > 300:
            raise ValueError("Preset object has too many keys.")
        normalized: dict[str, Any] = {}
        for raw_key, raw_value in value.items():
            key = str(raw_key or "").strip()
            if not _KEY_RE.fullmatch(key):
                raise ValueError(f"Preset key is invalid: {key!r}")
            normalized[key] = _json_safe(raw_value, depth + 1)
        return normalized
    raise ValueError(f"Unsupported preset value type: {type(value).__name__}")


def _normalize_values(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("Preset values must be an object.")
    return _json_safe(raw)


def _normalize_preset(
    raw: dict[str, Any], existing: dict[str, Any] | None = None
) -> dict[str, Any]:
    name = _validate_name(raw.get("name") or (existing or {}).get("name"))
    mode = str(raw.get("mode") or (existing or {}).get("mode") or "img_gen").strip()
    if mode not in _VALID_MODES:
        raise ValueError(f"Invalid preset mode: {mode!r}")

    bundle = _validate_bundle(
        raw.get("bundle") or raw.get("model_type") or (existing or {}).get("bundle")
    )
    values = _normalize_values(raw.get("values", raw.get("params", {})))
    if "custom_args" in raw and "custom_args" not in values:
        values["custom_args"] = _json_safe(raw.get("custom_args"))

    preset = {
        "schema": 1,
        "kind": "stable-d-gui.preset",
        "name": name,
        "description": _validate_text(raw.get("description", ""), "description"),
        "bundle": bundle,
        "model_type": bundle,
        "mode": mode,
        "values": values,
        "created_at": (existing or {}).get("created_at") or _utc_now(),
        "updated_at": _utc_now(),
    }
    encoded = json.dumps(preset, ensure_ascii=False).encode("utf-8")
    if len(encoded) > _MAX_JSON_BYTES:
        raise ValueError("Preset is too large.")
    return preset


def _read_preset(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    if not data.get("name"):
        data["name"] = path.stem
    if not data.get("bundle") and data.get("model_type"):
        data["bundle"] = data.get("model_type")
    if not data.get("model_type") and data.get("bundle"):
        data["model_type"] = data.get("bundle")
    if not isinstance(data.get("values"), dict) and isinstance(data.get("params"), dict):
        data["values"] = data["params"]
    return data


def _write_preset(path: Path, preset: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(preset, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _preset_filename(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("._") or "preset"
    return f"{safe}.sdgui-preset.json"


def list_presets(request: Request, response: Response, ctx: AppContext) -> None:
    presets = []
    with ctx.state.preset_lock:
        if ctx.paths.presets.exists():
            for path in ctx.paths.presets.glob("*.json"):
                data = _read_preset(path)
                if data:
                    presets.append(data)
    presets.sort(key=lambda p: (str(p.get("bundle", "")).lower(), str(p.get("name", "")).lower()))
    response.json({"presets": presets})


def save_preset(request: Request, response: Response, ctx: AppContext) -> None:
    body = request.body or {}
    raw = body.get("preset") if isinstance(body.get("preset"), dict) else body
    if not isinstance(raw, dict):
        response.error("Preset payload must be an object.", 400)
        return

    try:
        name = _validate_name(raw.get("name"))
        path = _preset_path(ctx, name)
        with ctx.state.preset_lock:
            existing = _read_preset(path) if path.exists() else None
            preset = _normalize_preset(raw, existing)
            _write_preset(path, preset)
    except (ValueError, OSError) as exc:
        response.error(str(exc), 400)
        return

    response.json({"saved": True, "preset": preset})


def delete_preset(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        raw_name = urllib.parse.unquote(request.params.get("name", ""))
        name = _validate_name(raw_name)
        path = _preset_path(ctx, name)
        with ctx.state.preset_lock:
            if not path.exists():
                response.error("Preset not found.", 404)
                return
            path.unlink()
    except ValueError as exc:
        response.error(str(exc), 400)
        return
    except OSError as exc:
        response.error("Could not delete preset.", 500)
        print(f"[presets] delete failed for {raw_name!r}: {exc}", flush=True)
        return
    response.json({"deleted": True, "name": name})


def export_preset_shortcut(request: Request, response: Response, ctx: AppContext) -> None:
    """Return a named preset as a JSON payload suitable for browser download."""
    try:
        name = _validate_name((request.body or {}).get("name"))
        path = _preset_path(ctx, name)
        with ctx.state.preset_lock:
            preset = _read_preset(path) if path.exists() else None
        if not preset:
            response.error("Preset not found.", 404)
            return
    except ValueError as exc:
        response.error(str(exc), 400)
        return
    response.json({"filename": _preset_filename(name), "preset": preset})
