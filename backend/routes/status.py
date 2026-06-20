"""GET /api/status — server + install status.

Reports installed backend, executable presence, runtime-library health, and the
available backend variants for this platform. Drives the Install tab + the
sidebar version badge.
"""

from backend.context import AppContext
from backend.http import Request, Response, sanitize_error
from backend.services import sdcpp_manager


def get_status(request: Request, response: Response, ctx: AppContext) -> None:
    try:
        services = ctx.services
        cfg = dict(services.load_config())
        has_config = bool(cfg.get("tag"))

        executables: dict[str, bool] = {}
        for tool in services.sdcpp_tools:
            name = services.get_tool_filename(tool)
            executables[name] = services.find_tool_executable(tool).exists()

        runtime_health = sdcpp_manager.validate_runtime_dependencies(ctx)
        missing_runtime_files = runtime_health.get("missing_runtime_files") or []

        cli_name = services.get_tool_filename("sd-cli")
        installed = has_config and executables.get(cli_name, False) and not missing_runtime_files
        config_stale = has_config and not installed

        backend_specs = services.backend_specs
        available_backends = [
            {"id": key, "label": spec["label"]} for key, spec in backend_specs.items()
        ]

        response.json(
            {
                "app": "StableDfusion",
                "installed": installed,
                "config_stale": config_stale,
                "version": cfg.get("tag"),
                "backend": cfg.get("backend"),
                "installed_version_name": cfg.get("version"),
                "executables": executables,
                "missing_runtime_files": missing_runtime_files,
                "runtime_health": runtime_health,
                "platform": services.current_platform,
                "platform_label": services.get_platform_label(),
                "arch": services.current_arch,
                "executable_suffix": services.binary_suffix,
                "running": services.is_process_running(),
                "active_process_tool": ctx.state.active_process_tool,
                "sd_server": ctx.state.sd_server.snapshot(),
                "available_backends": available_backends,
                "models_dir": str(ctx.paths.models),
                "output_dir": str(ctx.paths.output),
                "sdcpp_dir": str(ctx.paths.sdcpp),
            }
        )
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
