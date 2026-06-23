"""Server lifecycle: shutdown, restart, cleanup, open-folder.

~Verbatim from LLama-GUI's lifecycle.py (generic). On shutdown/restart we first
stop the running sd-cli/sd-server process and the Cloudflare tunnel so ports
and subprocesses don't leak.
"""

import os
import subprocess
import sys
import threading

from ..context import AppContext


def stop_runtime_services(ctx: AppContext) -> None:
    """Stop any running sd-cli/sd-server process + cloudflared tunnel."""
    from . import process_manager, server_mode_service, tunnel_service

    try:
        tunnel_service.stop_remote_tunnel(ctx)
    except Exception as exc:
        print(f"[lifecycle] tunnel stop error: {exc}", file=sys.stderr)
    try:
        server_mode_service.stop(ctx)
    except Exception as exc:
        print(f"[lifecycle] sd-server stop error: {exc}", file=sys.stderr)
    try:
        process_manager.stop_process(ctx)
    except Exception as exc:
        print(f"[lifecycle] process stop error: {exc}", file=sys.stderr)


def shutdown_gui_server(ctx: AppContext) -> bool:
    """Schedule a graceful server shutdown (returns immediately)."""
    server = ctx.state.gui_server
    if server is None:
        return False
    stop_runtime_services(ctx)
    threading.Thread(target=server.shutdown, daemon=True).start()
    return True


def cleanup_gui_server(ctx: AppContext) -> None:
    stop_runtime_services(ctx)
    server = ctx.state.gui_server
    if server is not None:
        try:
            server.server_close()
        except Exception:
            pass
        ctx.state.gui_server = None


def restart_gui_server(ctx: AppContext) -> bool:
    """Re-exec server.py in a detached child, then exit this process.

    The replacement is spawned *before* this instance shuts down. The new
    process receives ``SD_GUI_RESTART=1`` so its ``main()`` retries binding for
    a few seconds while we release the port. If the spawn itself fails, this
    server stays alive instead of leaving the user with no backend.
    """
    server = ctx.state.gui_server
    if server is None:
        return False

    restart_script = ctx.paths.root / "server.py"
    # Pre-flight: refuse to restart if the replacement can't be launched at all.
    if not restart_script.exists() or not os.path.exists(sys.executable):
        print(
            "ERROR: restart target missing (server.py or python executable); aborting restart.",
            file=sys.stderr,
        )
        return False

    stop_runtime_services(ctx)

    def _restart() -> None:
        try:
            env = dict(os.environ)
            env["SD_GUI_RESTART"] = "1"
            subprocess.Popen(
                [sys.executable, str(restart_script)],
                cwd=str(ctx.paths.root),
                env=env,
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                if sys.platform == "win32"
                else 0,
            )
            print("Restarting StableDfusion...", file=sys.stderr)
        except Exception as exc:
            print(f"ERROR: Failed to restart server: {exc}", file=sys.stderr)
            import traceback

            traceback.print_exc()
            # Do NOT shut down — keep the current server alive.
            return
        # Replacement spawned successfully: release the port and exit.
        try:
            server.shutdown()
        except Exception:
            pass
        os._exit(0)

    threading.Thread(target=_restart, daemon=False).start()
    return True


def open_folder_in_file_manager(target) -> None:
    if sys.platform == "win32":
        os.startfile(str(target))  # type: ignore[attr-defined]
        return
    if sys.platform == "darwin":
        subprocess.run(["open", str(target)], check=False)
        return
    subprocess.run(["xdg-open", str(target)], check=False)
